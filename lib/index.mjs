/**
 * dsh-desktop-shot — 宿主侧（host half）
 *
 * 点一下输入框右边的按钮，做三件事：
 *   1. 把 DSH 窗口**最小化**（`ShowWindow(SW_MINIMIZE)`，跨进程可用，实测 15-19ms 生效）；
 *   2. **自动拉起框选工具**（本文件里的 `SELECTOR_SCRIPT`，一个 C# 冻结帧遮罩）——
 *      你不用自己去开 Win+Shift+S；
 *   3. 框选完成后工具自己把窗口还回来并聚焦，你 Ctrl+V 粘贴即可。
 *
 * 为什么不用系统截图工具：按 Esc 取消时它不给任何信号，我们只能干等到超时，窗口会一直缩着；
 * 自己做工具有**进程退出码**，成功 / 取消 / 超时都能立刻收尾。
 *
 * 为什么不用 0.1.x 那套"宿主自己抓屏 + 全屏遮罩"：那条链路要藏窗口再在 1 秒内还回来，
 * "消失又立刻出现"正是点击时闪烁的来源。现在窗口收起来之后一直收着，选完才回来。
 *
 * 注意：宿主是 `ELECTRON_RUN_AS_NODE` 起的纯 Node 进程（`require('electron')` 不存在），
 * 全部通过 spawn 子进程完成。窗口属于 Electron 主进程，跨进程 `ShowWindow` 可用；
 * 但 `SetWindowDisplayAffinity` 这类"调用者必须是窗口所有者"的 API 会被拒（error 5），
 * 所以"窗口照常显示但不进截图"那条路走不通，不要往那个方向做。
 *
 * 诊断：关键步骤追加写入 `~/.dsh/dsh-desktop-shot.log`。
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-desktop-shot'
export const inject = ['connection']

const NS = 'dsh-desktop-shot'
const MINIMIZE_ROUTE = `/api/${NS}/minimize`
const RESTORE_ROUTE = `/api/${NS}/restore`
const STATUS_ROUTE = `/api/${NS}/status`
const CROP_ROUTE = `/api/${NS}/last-crop`
const TRACE_ROUTE = `/api/${NS}/trace`
const LOG_PATH = join(homedir(), '.dsh', `${NS}.log`)
const SCRIPT_DIR = join(homedir(), '.dsh', `${NS}-scripts`)
const SELECTOR_PATH = join(SCRIPT_DIR, 'selector.ps1')
const DEFAULT_TOOL_TIMEOUT_SEC = 300
/** UTF-8 BOM: Windows PowerShell reads a BOM-less UTF-8 .ps1 as ANSI and mangles the CJK hint. */
const BOM = Buffer.from([0xef, 0xbb, 0xbf])

/** 宿主侧 PowerShell 调用的兜底超时：脚本自身有退出码，但编译/权限异常会让它永远不返回。 */
const PS_TIMEOUT_MS = 20_000
/** `/last-crop` 的一次性取件时限：到点没被客户端取走就丢掉，不长期留在内存里。 */
const CROP_TTL_MS = 30_000
/** 单条诊断日志的字符上限，防止任意长度的客户端文本撑爆日志文件。 */
const LOG_MESSAGE_MAX = 1200
/** 客户端转发的文本另外收紧一档：那是完全由页面控制的内容。 */
const TRACE_MESSAGE_MAX = 600

/**
 * 还原并聚焦窗口的 C# 实现。**只此一份**：选择器脚本与兜底还原脚本都从这里取，
 * 两边以前各抄了一份，改了其中一份就会两边行为不一致。
 *
 * 这里**不带 `using` 指令**：它会被插进两个脚本各自的 Add-Type 编译单元，而
 * `Add-Type` 把"重复 using"当错误（CS0105 升级为 error），两处都已自带所需的 using。
 */
const RESTORE_CS = `
public static class DshShotRestore {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", EntryPoint = "GetWindowThreadProcessId")] public static extern uint ThreadOf(IntPtr h, IntPtr pid);
  public static int RestoreAndFocus(IntPtr h) {
    if (!IsWindow(h)) return 4;
    int flags = 0;
    if (IsIconic(h)) { ShowWindow(h, 9); flags |= 1; }
    IntPtr fg = GetForegroundWindow();
    uint fgThread = fg == IntPtr.Zero ? 0 : ThreadOf(fg, IntPtr.Zero);
    uint me = GetCurrentThreadId();
    bool attached = false;
    if (fgThread != 0 && fgThread != me) {
      try { attached = AttachThreadInput(fgThread, me, true); } catch { }
    }
    BringWindowToTop(h);
    if (SetForegroundWindow(h)) flags |= 2;
    if (attached) { try { AttachThreadInput(fgThread, me, false); } catch { } }
    return flags;
  }
}
`

/** 追加一行诊断日志；日志本身永远不能把插件搞崩，也不允许被超长文本撑爆。 */
function log(...parts) {
  try {
    const line = parts
      .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
      .join(' ')
      .replace(/[\r\n]+/g, ' ⏎ ')
      .slice(0, LOG_MESSAGE_MAX)
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* 诊断通道失败不影响功能 */
  }
}

/**
 * 第一步：定位 DSH 窗口并最小化；确认真的最小化了才返回。
 * `ShowWindow` 的返回值是"之前的可见状态"，不能当成功判据，所以这里轮询 `IsIconic`。
 */
const MINIMIZE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DshShotWin {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  delegate bool EnumProc(IntPtr h, IntPtr p);
  public static IntPtr FindByTitleSuffix(string suffix) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      int n = GetWindowTextLength(h);
      if (n <= 0) return true;
      StringBuilder sb = new StringBuilder(n + 1);
      GetWindowText(h, sb, sb.Capacity);
      if (sb.ToString().EndsWith(suffix, StringComparison.OrdinalIgnoreCase)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static IntPtr FindByProcessId(int pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      if ((int)owner == pid) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@

$suffix = if ($env:DSH_DESKTOP_SHOT_TITLE) { $env:DSH_DESKTOP_SHOT_TITLE } else { 'DeepSeek Harness' }
$procName = if ($env:DSH_DESKTOP_SHOT_PROCESS) { $env:DSH_DESKTOP_SHOT_PROCESS } else { 'DeepSeek Harness' }

$hwnd = [DshShotWin]::FindByTitleSuffix($suffix)
if ($hwnd -eq [IntPtr]::Zero) {
  try {
    $proc = Get-Process -Name $procName -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proc) { $hwnd = [DshShotWin]::FindByProcessId($proc.Id) }
  } catch { }
}
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'error window-not-found'; exit 2 }

[DshShotWin]::ShowWindow($hwnd, 6) | Out-Null
$iconic = $false
for ($i = 0; $i -lt 40; $i++) {
  if ([DshShotWin]::IsIconic($hwnd)) { $iconic = $true; break }
  Start-Sleep -Milliseconds 25
}
Write-Output ("minimized hwnd={0} iconic={1}" -f $hwnd.ToInt64(), $iconic)
`

/**
 * 第二步：框选工具本体。整个遮罩是 C#（WinForms），PowerShell 只是启动器。
 *
 * 为什么遮罩层要写成 C#：PowerShell 的 `Add_MouseMove` 每来一个消息都要过一遍脚本引擎，
 * 实测 `MouseMove` 根本不落地（框选永远停在 0x0）。覆写 `OnMouseMove`/`OnPaint` 才可靠，
 * 顺带拿到双缓冲。
 *
 * 时序：窗口此时已被宿主最小化 → 抓一张整屏冻结帧（遮罩还没出现，所以遮罩不会进画面）
 * → 显示全屏遮罩 → 拖拽框选 → 裁剪 → 放进剪贴板 → 还原并聚焦 DSH 窗口 → 用退出码报结果。
 *
 * 退出码：0 = 截到了、3 = 取消、5 = 超时、其它 = 启动/运行失败（宿主会兜底还原窗口）。
 */
const SELECTOR_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

${RESTORE_CS}

public static class DshShotNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  // TakeOver 抢前台需要的这几个声明（RestoreAndFocus 的实现只在 DshShotRestore 里）。
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", EntryPoint = "GetWindowThreadProcessId")] public static extern uint ThreadOf(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public static readonly IntPtr HWND_TOP = new IntPtr(0);
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_NOACTIVATE = 0x0010;
  public const uint SWP_SHOWWINDOW = 0x0040;
  public const uint SWP_FRAMECHANGED = 0x0020;
  public const int WS_EX_TOPMOST_BIT = 0x8;
  public static bool IsTopMost(IntPtr h) { return (GetWindowLong(h, -20) & WS_EX_TOPMOST_BIT) != 0; }
  public static bool IsForeground(IntPtr h) { return GetForegroundWindow() == h; }
  /* Make sure this window is actually seen.
     Two separate traps, both observed the hard way:
       - Form.TopMost alone did NOT leave WS_EX_TOPMOST set on the real overlay, so the window sat
         under whatever the user was looking at ("visible" in every API, invisible on screen);
       - a plain SetForegroundWindow from a background process is refused by the foreground lock.
     So: force the style bit explicitly, place it in the topmost band, and additionally try to take
     the foreground with the AttachThreadInput dance (proven by RestoreAndFocus). Returns a bitmask:
     bit0 topmost, bit1 foreground, bit2 SetForegroundWindow returned true. */
  public static int TakeOver(IntPtr h) {
    IntPtr fg = GetForegroundWindow();
    uint fgThread = fg == IntPtr.Zero ? 0 : ThreadOf(fg, IntPtr.Zero);
    uint me = GetCurrentThreadId();
    bool attached = false;
    if (fgThread != 0 && fgThread != me) {
      try { attached = AttachThreadInput(fgThread, me, true); } catch { }
    }
    int ex = GetWindowLong(h, -20);
    if ((ex & WS_EX_TOPMOST_BIT) == 0) {
      try { SetWindowLong(h, -20, ex | WS_EX_TOPMOST_BIT); } catch { }
    }
    ShowWindow(h, 5);
    SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED);
    BringWindowToTop(h);
    bool ok = SetForegroundWindow(h);
    if (!IsTopMost(h)) {
      /* last resort: raise inside the band we are allowed to touch */
      SetWindowPos(h, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }
    if (attached) { try { AttachThreadInput(fgThread, me, false); } catch { } }
    int flags = 0;
    if (IsTopMost(h)) flags |= 1;
    if (IsForeground(h)) flags |= 2;
    if (ok) flags |= 4;
    return flags;
  }
  /* Fallback that does not depend on winning any z-order race: make this overlay an OWNED window of
     the DSH window (an owned window is always drawn above its owner), then restore+focus DSH --
     which is proven to work (RestoreAndFocus reports the foreground bit in production). The overlay
     is fullscreen and already showing the frozen frame, so the user only ever sees the overlay. */
  public static bool SetOwner(IntPtr h, IntPtr owner) {
    try {
      SetWindowLongPtr(h, -8, owner);
      return true;
    } catch { return false; }
  }
  public static void Trace(string message) {
    string path = Environment.GetEnvironmentVariable("DSH_DESKTOP_SHOT_TOOL_TRACE");
    if (string.IsNullOrEmpty(path)) return;
    try { File.AppendAllText(path, DateTime.Now.ToString("HH:mm:ss.fff") + " " + message + Environment.NewLine); } catch { }
  }
}

public class DshShotSelector : Form {
  private const int MinSize = 8;
  private readonly Bitmap frozen;
  private readonly string hint;
  private readonly Font hintFont;
  private readonly Font sizeFont;
  private readonly Brush dim = new SolidBrush(Color.FromArgb(132, 0, 0, 0));
  private readonly Pen edge = new Pen(Color.FromArgb(255, 79, 195, 247), 1f);
  private readonly Brush chrome = new SolidBrush(Color.FromArgb(210, 15, 17, 21));
  private readonly Timer watchdog;
  private Timer reassert;
  private int retries;
  private readonly long dshHwnd;
  private bool ownerFallback;
  private bool dragging;
  private bool showSelection;
  private Point anchor;
  private Point current;
  /* Properties, not fields: Form derives from MarshalByRefObject and a public struct field
     trips CS1690, which Add-Type treats as a build error. */
  public string Outcome { get; set; }
  public Rectangle Crop { get; set; }
  /** takeover 位掩码：bit0 置顶、bit1 前台、bit2 SetForegroundWindow 返回真。 */
  public int TakeoverFlags { get; set; }

  public DshShotSelector(Bitmap image, Rectangle bounds, string hintText, string fontFamily, int watchdogSeconds, long dshWindow) {
    Outcome = "cancelled";
    Crop = Rectangle.Empty;
    dshHwnd = dshWindow;
    SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
    frozen = image;
    hint = hintText;
    hintFont = new Font(fontFamily, 12f);
    sizeFont = new Font(fontFamily, 10f);
    FormBorderStyle = FormBorderStyle.None;
    StartPosition = FormStartPosition.Manual;
    ShowInTaskbar = false;
    TopMost = true;
    KeyPreview = true;
    MinimizeBox = false;
    MaximizeBox = false;
    Bounds = bounds;
    Cursor = Cursors.Cross;
    Text = "dsh-desktop-shot";
    watchdog = new Timer();
    watchdog.Interval = Math.Max(10, watchdogSeconds) * 1000;
    watchdog.Tick += delegate { DshShotNative.Trace("watchdog"); Outcome = "timeout"; Close(); };
  }

  protected override void OnShown(EventArgs e) {
    base.OnShown(e);
    /* Two things can leave this overlay invisible even though it exists and is "visible":
       (1) a SW_HIDE STARTUPINFO (node windowsHide / Start-Process -WindowStyle Hidden) overrides
           this process's FIRST ShowWindow;
       (2) the foreground lock refuses a plain SetForegroundWindow from a background process, so the
           window stays UNDER whatever the user is looking at.
       TakeOver() handles both and reports what it managed to get. */
    TopMost = true;
    TakeoverFlags = DshShotNative.TakeOver(Handle);
    DshShotNative.Trace("shown bounds=" + Width + "x" + Height + " at " + Left + "," + Top + " takeover=" + TakeoverFlags);
    Activate();
    Focus();
    /* Keep re-asserting for a while: the foreground lock can be transient, and getting the topmost
       bit in place is what decides whether the user sees anything at all. */
    reassert = new Timer();
    reassert.Interval = 300;
    reassert.Tick += delegate {
      retries++;
      TakeoverFlags = DshShotNative.TakeOver(Handle);
      /* If neither the topmost band nor the foreground can be had, fall back to riding on the DSH
         window: own it, then restore+focus DSH (proven mechanism). Only then is the overlay
         guaranteed to be above whatever the user was looking at. */
      if (!ownerFallback && retries >= 3 && (TakeoverFlags & 3) == 0 && dshHwnd != 0) {
        ownerFallback = true;
        bool owned = DshShotNative.SetOwner(Handle, new IntPtr(dshHwnd));
        DshShotRestore.RestoreAndFocus(new IntPtr(dshHwnd));
        if (owned) TakeoverFlags |= 8;
        DshShotNative.Trace("owner fallback owned=" + owned + " flags=" + TakeoverFlags);
      }
      DshShotNative.Trace("retry " + retries + " takeover=" + TakeoverFlags);
      if ((TakeoverFlags & 3) == 3 || retries >= 6) reassert.Stop();
    };
    reassert.Start();
    watchdog.Start();
  }

  protected override void OnMouseDown(MouseEventArgs e) {
    base.OnMouseDown(e);
    DshShotNative.Trace("down " + e.Button + " " + e.X + "," + e.Y);
    if (e.Button == MouseButtons.Right) { Outcome = "cancelled"; Close(); return; }
    if (e.Button != MouseButtons.Left) return;
    dragging = true;
    showSelection = true;
    anchor = e.Location;
    current = e.Location;
    Invalidate();
  }

  protected override void OnMouseMove(MouseEventArgs e) {
    base.OnMouseMove(e);
    if (!dragging) return;
    current = e.Location;
    Invalidate();
  }

  protected override void OnMouseUp(MouseEventArgs e) {
    base.OnMouseUp(e);
    DshShotNative.Trace("up " + e.Button + " " + e.X + "," + e.Y);
    if (!dragging) return;
    dragging = false;
    Point a = anchor, c = e.Location;
    int x1 = Math.Min(a.X, c.X), y1 = Math.Min(a.Y, c.Y);
    int x2 = Math.Max(a.X, c.X), y2 = Math.Max(a.Y, c.Y);
    if (x2 - x1 < MinSize || y2 - y1 < MinSize) {
      showSelection = false;
      Invalidate();
      DshShotNative.Trace("too small " + (x2 - x1) + "x" + (y2 - y1));
      return;
    }
    Crop = new Rectangle(x1, y1, x2 - x1, y2 - y1);
    Outcome = "captured";
    Rectangle made = Crop;
    DshShotNative.Trace("crop " + made.Width + "x" + made.Height + " at " + made.X + "," + made.Y);
    Close();
  }

  protected override void OnKeyDown(KeyEventArgs e) {
    base.OnKeyDown(e);
    if (e.KeyCode == Keys.Escape) { DshShotNative.Trace("escape"); Outcome = "cancelled"; Close(); }
  }

  protected override void OnPaintBackground(PaintEventArgs e) {
    /* OnPaint covers the whole client area */
  }

  protected override void OnPaint(PaintEventArgs e) {
    Graphics g = e.Graphics;
    g.DrawImageUnscaled(frozen, 0, 0);
    Rectangle client = ClientRectangle;
    if (!showSelection) {
      g.FillRectangle(dim, client);
      SizeF s = g.MeasureString(hint, hintFont);
      float hx = (client.Width - s.Width) / 2f;
      float hy = client.Height - s.Height - 60f;
      g.FillRectangle(chrome, hx - 14f, hy - 8f, s.Width + 28f, s.Height + 16f);
      g.DrawString(hint, hintFont, Brushes.White, hx, hy);
      return;
    }
    Point a = anchor, c = current;
    int x1 = Math.Min(a.X, c.X), y1 = Math.Min(a.Y, c.Y);
    int x2 = Math.Max(a.X, c.X), y2 = Math.Max(a.Y, c.Y);
    g.FillRectangle(dim, 0, 0, client.Width, y1);
    g.FillRectangle(dim, 0, y1, x1, y2 - y1);
    g.FillRectangle(dim, x2, y1, client.Width - x2, y2 - y1);
    g.FillRectangle(dim, 0, y2, client.Width, client.Height - y2);
    g.DrawRectangle(edge, x1, y1, Math.Max(1, x2 - x1 - 1), Math.Max(1, y2 - y1 - 1));
    string label = (x2 - x1) + " x " + (y2 - y1);
    SizeF ls = g.MeasureString(label, sizeFont);
    float lx = x1, ly = y1 - ls.Height - 6f;
    if (ly < 4f) ly = y1 + 6f;
    g.FillRectangle(chrome, lx, ly, ls.Width + 12f, ls.Height + 6f);
    g.DrawString(label, sizeFont, Brushes.White, lx + 6f, ly + 3f);
  }

  protected override void Dispose(bool disposing) {
    if (disposing) {
      watchdog.Dispose();
      if (reassert != null) reassert.Dispose();
      dim.Dispose();
      edge.Dispose();
      chrome.Dispose();
      hintFont.Dispose();
      sizeFont.Dispose();
    }
    base.Dispose(disposing);
  }
}

public static class DshShotSelectorRun {
  public static string Run(long hwndValue, string hint, string fontFamily, int watchdogSeconds) {
    DshShotNative.SetProcessDPIAware();
    Rectangle vs = SystemInformation.VirtualScreen;
    Bitmap frozen = new Bitmap(vs.Width, vs.Height);
    using (Graphics g = Graphics.FromImage(frozen)) g.CopyFromScreen(vs.X, vs.Y, 0, 0, frozen.Size);
    string outcome;
    string crop = "no";
    int takeover = 0;
    using (DshShotSelector form = new DshShotSelector(frozen, vs, hint, fontFamily, watchdogSeconds, hwndValue)) {
      form.ShowDialog();
      outcome = form.Outcome;
      takeover = form.TakeoverFlags;
      Rectangle chosen = form.Crop;
      if (outcome == "captured" && !chosen.IsEmpty) {
        Rectangle rect = chosen;
        Bitmap shot = new Bitmap(rect.Width, rect.Height);
        using (Graphics g2 = Graphics.FromImage(shot)) {
          g2.DrawImage(frozen, new Rectangle(0, 0, rect.Width, rect.Height), rect, GraphicsUnit.Pixel);
        }
        DataObject data = new DataObject();
        data.SetData(DataFormats.Bitmap, shot);
        MemoryStream stream = new MemoryStream();
        shot.Save(stream, ImageFormat.Png);
        stream.Position = 0;
        data.SetData("PNG", stream);
        Clipboard.SetDataObject(data, true);
        /* Also hand the crop to the host as a file: the renderer cannot read the clipboard
           (the shell denies every permission), so this is how it gets delivered into the composer. */
        string outPath = Environment.GetEnvironmentVariable("DSH_DESKTOP_SHOT_OUT");
        if (!string.IsNullOrEmpty(outPath)) {
          try { shot.Save(outPath, ImageFormat.Png); } catch { }
        }
        crop = rect.Width + "x" + rect.Height;
        stream.Dispose();
        shot.Dispose();
      }
      frozen.Dispose();
    }
    int flags = 0;
    if (hwndValue != 0) flags = DshShotRestore.RestoreAndFocus(new IntPtr(hwndValue));
    return "selector end outcome=" + outcome + " flags=" + flags + " crop=" + crop + " takeover=" + takeover;
  }
}
'@ -ReferencedAssemblies 'System.Windows.Forms', 'System.Drawing'

$hwnd = [int64]0
if ($env:DSH_DESKTOP_SHOT_HWND) { $hwnd = [int64]$env:DSH_DESKTOP_SHOT_HWND }
$watchdog = 300
if ($env:DSH_DESKTOP_SHOT_TOOL_TIMEOUT_SEC) { $watchdog = [int]$env:DSH_DESKTOP_SHOT_TOOL_TIMEOUT_SEC }

$family = 'Microsoft YaHei UI'
$cjk = $true
try {
  $probe = New-Object System.Drawing.Font($family, 12)
  if ($probe.Name -ne $family) { $family = 'Segoe UI'; $cjk = $false }
  $probe.Dispose()
} catch { $family = 'Segoe UI'; $cjk = $false }
# The hint text is passed in from PowerShell on purpose: non-ASCII inside the C# source above
# would have to survive Add-Type's temp .cs file encoding, which is not reliable.
$hint = if ($cjk) { '拖拽框选区域 · Esc 或右键取消' } else { 'Drag to select - Esc or right click to cancel' }

$result = [DshShotSelectorRun]::Run($hwnd, $hint, $family, $watchdog)
Write-Output $result
if ($result -match 'outcome=captured') { exit 0 }
if ($result -match 'outcome=timeout') { exit 5 }
exit 3
`

/** 兜底还原：只在框选工具异常退出（没来得及还原）时用。与选择器共用 {@link RESTORE_CS}。 */
const RESTORE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
${RESTORE_CS}
'@
$hwnd = [IntPtr][int64]$env:DSH_DESKTOP_SHOT_HWND
$flags = [DshShotRestore]::RestoreAndFocus($hwnd)
Write-Output ("restore flags={0}" -f $flags)
`

/** 把选择器脚本落盘并返回路径。
 *
 * 为什么不再用 `-EncodedCommand`：脚本 base64 后（UTF-16LE）已经超过 Windows 32,767 字符的
 * 命令行上限，spawn 会直接失败；写成文件再 `-File` 调用就没有这个天花板，顺带也让脚本可以被
 * 直接打开阅读/调试。文件带 UTF-8 BOM，否则 PS 5.1 会按 ANSI 读、把中文提示读花。 */
function writeSelectorScript() {
  try {
    mkdirSync(SCRIPT_DIR, { recursive: true })
    writeFileSync(SELECTOR_PATH, Buffer.concat([BOM, Buffer.from(SELECTOR_SCRIPT, 'utf8')]))
    return SELECTOR_PATH
  } catch (error) {
    log('selector script write failed:', error?.message ?? String(error))
    return null
  }
}

/** 杀掉整棵进程树：Add-Type 会拉起 csc.exe，只杀 powershell.exe 会留下编译孤儿。 */
function killTree(child) {
  if (!child || child.killed) return
  try {
    child.kill()
  } catch {
    /* 已经退出了 */
  }
  if (child.pid) {
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      killer.on('error', () => {})
      killer.unref()
    } catch {
      /* taskkill 不可用就只 kill 直接子进程 */
    }
  }
}

/** 跑一段脚本并把 stdout 收全（经 -EncodedCommand 传入，免去引号/转义地狱）。
 *
 * 带超时：脚本自身有退出码，但 PowerShell 首次 Add-Type 编译或被杀软拦下时可能永不返回，
 * 那样上一层的 HTTP 请求会一直挂着，客户端按钮就永远禁用。 */
function runPowerShell(script, extraEnv = {}, timeoutMs = PS_TIMEOUT_MS) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-STA', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, env: { ...process.env, ...extraEnv } },
    )
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`powershell timed out after ${timeoutMs}ms`))
        return
      }
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(`powershell exit ${code}: ${(stderr.trim() || stdout.trim()).slice(0, 300) || 'no output'}`))
    })
  })
}

/**
 * 每个宿主进程一次性随机令牌。路由只监听本机回环，但任何本机进程都能 POST；
 * 浏览器还会替跨站页面发出"简单"POST。所以除了同源校验，业务路由都要求这个头。
 * 令牌本身由 `/token` 发放——跨站页面读不到它：响应不带 CORS 许可，浏览器不会把 body 交给对方。
 */
const ROUTE_TOKEN = randomBytes(24).toString('hex')
const TOKEN_ROUTE = `/api/${NS}/token`

/** 插件状态：`/status` 读它，客户端回到前台时据此提示。 */
const state = {
  armed: false,
  hwnd: 0,
  outcome: null,
  finishedAt: 0,
  tool: null,
  /**
   * 最近一次裁剪。**有意做成一次性的**：这是一张整屏截图，留在内存里越久、
   * 能被 `/last-crop` 取走的窗口就越长，所以客户端取走即清、超时也清。
   */
  lastCrop: null,
  cropTimer: null,
}

/** 丢掉暂存的裁剪结果（取走、超时、重新截图、插件卸载都走这里）。 */
function dropCrop(reason) {
  if (state.cropTimer) {
    clearTimeout(state.cropTimer)
    state.cropTimer = null
  }
  if (!state.lastCrop) return
  log('crop dropped:', reason, state.lastCrop.buffer.length, 'bytes')
  state.lastCrop = null
}

/** 暂存裁剪结果并起一个一次性取件时限。 */
function keepCrop(buffer) {
  dropCrop('replaced by a newer crop')
  state.lastCrop = { buffer, at: Date.now() }
  state.cropTimer = setTimeout(() => dropCrop('expired unread'), CROP_TTL_MS)
  if (typeof state.cropTimer.unref === 'function') state.cropTimer.unref()
}

/**
 * 定下本次结论。**不动 `state.tool`**：调用方负责决定进程是留着还是杀掉，
 * 这样"先摘引用、再杀进程"的顺序在一个地方看得清楚。
 */
function settle(outcome, detail) {
  state.armed = false
  state.outcome = outcome
  state.finishedAt = Date.now()
  log('selector settled:', outcome, detail ?? '')
}

/** 工具异常退出时的兜底还原（正常路径里工具自己已经把窗口还回去了）。 */
function ensureRestored(hwnd) {
  if (!hwnd) return
  runPowerShell(RESTORE_SCRIPT, { DSH_DESKTOP_SHOT_HWND: String(hwnd) })
    .then((stdout) => log('backstop restore:', stdout || 'ok'))
    .catch((error) => log('backstop restore failed:', error?.message ?? String(error)))
}

/** 拉起框选工具；它自己负责收尾还原，宿主按退出码记账。 */
function startSelector(hwnd, toolTimeoutSec) {
  const scriptPath = writeSelectorScript()
  if (scriptPath === null) {
    settle('failed', 'could not write the selector script')
    ensureRestored(hwnd)
    return
  }
  const cropPath = join(tmpdir(), `${NS}-crop-${Date.now()}.png`)
  const child = spawn(
    'powershell.exe',
    ['-STA', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    {
      windowsHide: true,
      env: {
        ...process.env,
        DSH_DESKTOP_SHOT_HWND: String(hwnd),
        DSH_DESKTOP_SHOT_TOOL_TIMEOUT_SEC: String(toolTimeoutSec),
        DSH_DESKTOP_SHOT_OUT: cropPath,
      },
    },
  )
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  child.on('error', (error) => {
    if (state.tool !== child) return
    log('selector spawn failed:', error?.message ?? String(error))
    state.tool = null
    settle('failed', error?.message)
    ensureRestored(hwnd)
  })
  child.on('close', (code) => {
    // 被 /restore 或插件卸载主动杀掉的工具，不许覆盖已经定下的结论。
    if (state.tool !== child) {
      log('selector closed (superseded):', stdout.trim().slice(0, 200))
      try {
        unlinkSync(cropPath)
      } catch {
        /* ignore */
      }
      return
    }
    state.tool = null
    // hwnd 跟着真实截图走：残留的 hwnd 在窗口已经关掉后毫无意义，兜底还原不该再去碰它。
    state.hwnd = 0
    const outcome = code === 0 ? 'captured' : code === 3 ? 'cancelled' : code === 5 ? 'timeout' : 'failed'
    if (stderr.trim()) log('selector stderr:', stderr.trim().slice(0, 600))
    // 关键：先备好裁剪结果，再 settle —— 客户端一旦看到 outcome=captured 就必须能取到图。
    if (outcome === 'captured') {
      try {
        keepCrop(readFileSync(cropPath))
        log('crop stored:', state.lastCrop.buffer.length, 'bytes')
      } catch (error) {
        state.lastCrop = null
        log('crop read failed:', error?.message ?? String(error))
      }
    }
    try {
      unlinkSync(cropPath)
    } catch {
      /* ignore */
    }
    settle(outcome, `exit=${code} ${stdout.trim().slice(0, 160)}`)
    if (outcome === 'failed') ensureRestored(hwnd)
  })
  state.tool = child
}

function toolTimeoutSec() {
  const value = Number(process.env.DSH_DESKTOP_SHOT_TOOL_TIMEOUT_SEC)
  return Number.isFinite(value) && value >= 10 ? Math.floor(value) : DEFAULT_TOOL_TIMEOUT_SEC
}

/**
 * `Origin` 校验：本机回环端口上任何本机程序都能 POST，浏览器也会替跨站页面发"简单"请求。
 * 要求 Origin 与本插件路由同源，跨站页面就发不进来（同源时 Origin 头与路径同源，正常放行）。
 */
function sameOrigin(request) {
  const origin = request.headers.get('origin')
  if (!origin) return true
  try {
    return new URL(origin).host === new URL(request.url).host
  } catch {
    return false
  }
}

/** 包一层请求守卫：同源 + 一次性令牌。`/token` 与 `/trace` 不校验令牌（见各自注释）。 */
function guard(handler, { requireToken = true } = {}) {
  return async (request) => {
    if (!sameOrigin(request)) {
      log('rejected: cross-origin request')
      return new Response('forbidden', { status: 403 })
    }
    if (requireToken && request.headers.get('x-dsh-desktop-shot-token') !== ROUTE_TOKEN) {
      log('rejected: missing or stale route token')
      return Response.json({ ok: false, error: { code: 'unauthorized' } }, { status: 401 })
    }
    return handler(request)
  }
}

/** 读出请求体的 JSON；空 body 当 `{}`。 */
async function readJson(request) {
  const text = await request.text()
  return text.trim() === '' ? {} : JSON.parse(text)
}

/**
 * 插件主体：token / minimize / restore / status / last-crop / trace 六条路由。
 * 整体包在 try/catch 里——宿主加载失败会让整个 DSH 起不来，这里绝不允许把异常抛出去。
 */
export function apply(ctx) {
  try {
    // 发放一次性令牌。跨站页面**拿不到它**：响应没有 CORS 许可，浏览器不会把 body 交给对方。
    ctx.effect(
      () =>
        ctx.connection.fetch.register({
          path: TOKEN_ROUTE,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: guard(
            async () =>
              Response.json(
                { ok: true, value: { token: ROUTE_TOKEN } },
                { headers: { 'cache-control': 'no-store' } },
              ),
            { requireToken: false },
          ),
        }),
      `${NS}: ${TOKEN_ROUTE}`,
    )

    ctx.effect(
      () =>
        ctx.connection.fetch.register({
          path: MINIMIZE_ROUTE,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: guard(async () => {
            if (state.armed) {
              log('minimize ignored: already armed')
              return Response.json({ ok: true, value: { alreadyArmed: true } })
            }
            try {
              const stdout = await runPowerShell(MINIMIZE_SCRIPT)
              const match = /hwnd=(-?\d+) iconic=(True|False)/i.exec(stdout)
              if (!match) throw new Error(stdout.trim() || 'window not found')
              const hwnd = Number(match[1])
              if (match[2].toLowerCase() !== 'true') throw new Error('window did not minimize')
              const wait = toolTimeoutSec()
              state.armed = true
              state.hwnd = hwnd
              state.outcome = null
              state.finishedAt = 0
              dropCrop('new capture started')
              log('minimized:', `hwnd=${hwnd}`, `toolTimeout=${wait}s`)
              startSelector(hwnd, wait)
              return Response.json({ ok: true, value: { hwnd, timeoutSec: wait } })
            } catch (error) {
              const message = error?.message ?? String(error)
              log('minimize failed:', message)
              return Response.json({ ok: false, error: { code: 'minimize-failed', message } }, { status: 500 })
            }
          }),
        }),
      `${NS}: ${MINIMIZE_ROUTE}`,
    )

    ctx.effect(
      () =>
        ctx.connection.fetch.register({
          path: RESTORE_ROUTE,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: guard(async () => {
            if (!state.hwnd) return Response.json({ ok: true, value: { restored: false, reason: 'no-window' } })
            try {
              const stdout = await runPowerShell(RESTORE_SCRIPT, { DSH_DESKTOP_SHOT_HWND: String(state.hwnd) })
              log('manual restore:', stdout || 'ok')
              // 先摘掉引用再杀，免得它的 close 回调把结论覆盖掉。
              const tool = state.tool
              state.tool = null
              killTree(tool)
              settle('manual-restore', stdout || '')
              return Response.json({ ok: true, value: { restored: true } })
            } catch (error) {
              const message = error?.message ?? String(error)
              log('manual restore failed:', message)
              return Response.json({ ok: false, error: { code: 'restore-failed', message } }, { status: 500 })
            }
          }),
        }),
      `${NS}: ${RESTORE_ROUTE}`,
    )

    ctx.effect(
      () =>
        ctx.connection.fetch.register({
          path: STATUS_ROUTE,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: guard(async () =>
            Response.json({
              ok: true,
              value: {
                armed: state.armed,
                outcome: state.outcome,
                finishedAt: state.finishedAt,
              },
            }),
          ),
        }),
      `${NS}: ${STATUS_ROUTE}`,
    )

    // 最近一次裁剪的原始 PNG 字节：客户端取走后交给 composer 官方入口，实现"自动进消息框"。
    // 一次性：读完立刻丢掉，避免整屏截图在宿主内存里长期可被取走。
    ctx.effect(
      () =>
        ctx.connection.fetch.register({
          path: CROP_ROUTE,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: guard(async () => {
            const crop = state.lastCrop
            if (!crop) return new Response('no crop', { status: 404 })
            dropCrop('collected by the client')
            return new Response(crop.buffer, {
              headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
            })
          }),
        }),
      `${NS}: ${CROP_ROUTE}`,
    )

    // 客户端把关键步骤报到这里，方便在页面之外排查。
    // 同源即可、不要令牌：客户端可能在任何一次请求之前就已经开始记日志；
    // 长度截断 + 换行清理，防止任意客户端文本注入伪造的日志行或撑大文件。
    ctx.effect(
      () =>
        ctx.connection.fetch.register({
          path: TRACE_ROUTE,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: guard(
            async (request) => {
              try {
                const body = await readJson(request)
                const message = String(body?.message ?? '')
                  .replace(/[\r\n]+/g, ' ⏎ ')
                  .slice(0, TRACE_MESSAGE_MAX)
                log('client:', message)
                return Response.json({ ok: true })
              } catch (error) {
                return Response.json({ ok: false, error: { message: String(error?.message ?? error) } }, { status: 400 })
              }
            },
            { requireToken: false },
          ),
        }),
      `${NS}: ${TRACE_ROUTE}`,
    )

    // 插件卸载（DSH 退出/重载）时：先定下结论（否则客户端会永远轮询一个不会结算的状态）、
    // 杀掉整棵工具进程树、丢掉暂存截图，最后如果窗口还是我们收起来的就还回去。
    ctx.effect(
      () => () => {
        // 顺序要紧：先摘引用（close 回调据此判断自己已被取代），再定结论，最后杀进程树。
        const tool = state.tool
        state.tool = null
        const wasBusy = tool !== null || state.armed || state.lastCrop !== null
        settle('unloaded', 'plugin disposed')
        killTree(tool)
        dropCrop('plugin disposed')
        if (wasBusy) log('dispose: settled as unloaded')
        if (state.hwnd) ensureRestored(state.hwnd)
      },
      `${NS}: dispose restore`,
    )

    log(
      'routes registered:',
      TOKEN_ROUTE,
      MINIMIZE_ROUTE,
      RESTORE_ROUTE,
      STATUS_ROUTE,
      CROP_ROUTE,
      TRACE_ROUTE,
    )
  } catch (error) {
    log('apply failed:', error?.message ?? String(error))
  }
}
