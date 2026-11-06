# 实现笔记

`dsh-desktop-shot` 的技术背景、踩坑记录与实测数据，从 README 拆出来。

## 为什么不用系统截图工具

按 Esc 取消时系统截图工具**不给任何信号**，我们就只能干等到超时——窗口会一直缩着。
自己做工具有**进程退出码**：

| 退出码 | 含义 | 宿主动作 |
| --- | --- | --- |
| `0` | 截到了 | 暂存裁剪结果，等客户端取走放进草稿框 |
| `3` | 取消（Esc / 右键 / 框太小） | 记账，提示已取消 |
| `5` | 超时（默认 300s） | 记账，提示超时 |
| 其它 | 启动/运行失败 | 兜底还原窗口，提示失败 |

工具自己是"先还原窗口、再退出"的，所以取消也能立刻收尾，不存在干等。

## 为什么不是"插件自己抓屏"

DSH 桌面应用是 Electron 壳，页面的屏幕捕获被明确禁掉：`app.asar` 里
`setDisplayMediaRequestHandler` 只回 `callback({})`，`setPermissionRequestHandler` 一律
`callback(false)`。所以纯 Web 引擎在应用窗口里必然拿不到屏幕。

`0.1.x` 因此把抓屏挪到宿主侧：最小化窗口 → 抓整屏 → **立刻还原** → 全屏遮罩上框选 → 裁剪 → 投递。
那条链路能跑，但点击时明显"顿一下、闪一下"：

- 抓屏要现场编译 C#、抓 2560×1440、存 3.7MB PNG、编码成 4.96MB base64 再跨进程传（实测 1.06–2.16s）；
- 窗口藏起来之后**必须在 1 秒内还回来**，"消失又立刻出现"本身就是一次可见的闪烁；
- 还要进出一次原生全屏（壳会把状态镜像到 `<html data-fullscreen>`，核心布局真的读它）。

现在窗口收起来之后**一直收着**，选完才回来，所以不存在"闪"。

## 投递：走 composer 自己的文件入口

裁剪完，框选工具会把 PNG **额外落一份文件**，宿主读进内存，客户端从 `POST /last-crop`
一次性取回原始字节、包成 `File`，然后塞进 **composer 自己的隐藏 `input[type=file][multiple]`**
并派发 `change`——也就是"选择文件"按钮走的那条路，等于用户自己选了这张图。

**为什么不是接 `conversation.input.attachments` 槽位里的 `onAddFiles`**（0.4.3 及更早的做法）：
那个槽位是 `kind: "single"`，官方附件组件（`client-ui-attachment` 的 `ComposerAttachments`）
已经以 priority 0 占着它。登记表对同优先级的第二次注册是**直接抛错拒绝**的：

```
single slot "conversation.input.attachments" already has a registration
at priority 0 (registered by client-ui-attachment) — register at a different
priority to shadow it (lowest renders)
```

所以那个"桥"从来就没装上过，`onAddFiles` 一直是 `undefined`，投递实际一直由文件 input 兜底完成
（旧日志里 `via intake (verified=true)` 的 `channel` 记错了）。而且真去抢优先级会把官方的
草稿缩略图轨道与拖放区顶掉。走文件 input 既不必抢槽位，又天然经过 composer 的
`intakeFiles` 校验（图片数量/张数/总大小限制），比直接调 `onAddFiles` 更严格。

**判定成功的依据**：composer 接受后会自己清空那个 input（`e.target.value = ""`），
所以"`input.files` 变空"就是核心收下了。失败就重试，最多 6 轮、每轮间隔 400ms；
仍失败才提示「已截取到剪贴板 —— Ctrl+V 粘贴」（剪贴板里一直留着一份）。

**已知限制**：回合正跑在 `adjudicating`/`submitting` 时核心会拒绝，长回合重试也救不了——
这时会退回剪贴板提示。

**投递时机等到窗口可见并且画过一帧**：投递发生在窗口刚从最小化还原的几十毫秒内，
此时 `document` 往往还是 `hidden`，而草稿缩略图与核心的图片尺寸探测都要靠解码。

## 安全边界（0.4.4 起）

这些路由虽然只监听本机回环，但**任何本机进程都能 POST**，浏览器还会替跨站页面发"简单"请求。
两层防护：

1. **DSH 连接层**（不归本插件管）：所有 `/api/*` 路由本身就要认证，且对跨源请求返回 403。
2. **本插件**：每个宿主进程生成一次性随机令牌，业务路由要求 `x-dsh-desktop-shot-token` 头；
   另外校验 `Origin` 与本机同源。令牌由 `POST /token` 发放——跨站页面拿不到它，
   因为响应没有 CORS 许可，浏览器不会把 body 交给对方。宿主重启换令牌后客户端会自动重取。

其它收紧：

- `/last-crop` **一次性的**：被取走即从内存清除；30s 没人取也清（整屏截图不该长期留驻）。
- `/trace` 的单条消息截断到 600 字符并去掉换行，防止任意客户端文本伪造日志行或撑大文件；
  单条日志硬上限 1200 字符。
- 选择器脚本与兜底还原脚本共用同一份 C#（见 `RESTORE_CS`），不再各抄一份。
- 所有 PowerShell 子进程有 20s 兜底超时，并且杀的是**整棵进程树**（`taskkill /T`）——
  `Add-Type` 会拉起 `csc.exe`，只杀 `powershell.exe` 会留下编译孤儿。

## 流程

| 步骤 | 谁做 |
| --- | --- |
| 点按钮 → `POST /minimize` | 客户端 |
| `EnumWindows` 按标题后缀定位 → `ShowWindow(SW_MINIMIZE)` → 轮询 `IsIconic` 确认 | 宿主（一次性 PowerShell） |
| 抓一张整屏冻结帧（此时遮罩还没出现，所以遮罩不会进画面） | 框选工具（C#） |
| 全屏遮罩 + 拖拽框选 + 尺寸提示 + Esc/右键取消 | 框选工具（C#） |
| 裁剪 → 进剪贴板，并另存一份 PNG 到 `DSH_DESKTOP_SHOT_OUT` | 框选工具（C#） |
| `ShowWindow(SW_RESTORE)` + `SetForegroundWindow`（必要时 `AttachThreadInput` 抢前台） | 框选工具（C#） |
| 退出码报结果 → 客户端轮询 `/status` 拿到结论 | 宿主 + 客户端 |
| 取回 PNG → 塞进 composer 的 file input → 进草稿框 | 客户端 |

**遮罩层是 C# 不是 PowerShell**：PowerShell 的 `Add_MouseMove` 每来一个消息都要过一遍脚本引擎，
实测 `MouseMove` 根本不落地（框选永远停在 `0x0`）。覆写 `OnMouseMove`/`OnPaint` 才可靠，
顺带拿到双缓冲。

## 路由

| 路由 | 作用 |
| --- | --- |
| `POST /api/dsh-desktop-shot/token` | 发放本进程的一次性路由令牌（同源校验，不需要令牌本身） |
| `POST /api/dsh-desktop-shot/minimize` | 收起窗口并拉起框选工具；返回 `{hwnd, timeoutSec}` |
| `POST /api/dsh-desktop-shot/restore` | 立刻还原（兜底），并杀掉框选工具 |
| `POST /api/dsh-desktop-shot/status` | `{armed, outcome, finishedAt}`，客户端据此判断该不该去取图 |
| `POST /api/dsh-desktop-shot/last-crop` | 最近一次裁剪的**原始 PNG 字节**（`image/png`）；没有则 404，**取走即清** |
| `POST /api/dsh-desktop-shot/trace` | 客户端把关键步骤转发到宿主日志（截断 600 字符、去掉换行） |

除 `/token` 与 `/trace` 外都要求 `x-dsh-desktop-shot-token` 头。
`outcome` 取值：`captured` / `cancelled` / `timeout` / `failed` / `manual-restore` / `unloaded`。

## 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DSH_DESKTOP_SHOT_TITLE` | `DeepSeek Harness` | 窗口标题**后缀**（主定位方式；标题形如「会话名 — DeepSeek Harness」） |
| `DSH_DESKTOP_SHOT_PROCESS` | `DeepSeek Harness` | 标题匹配不到时按进程名兜底定位 |
| `DSH_DESKTOP_SHOT_TOOL_TIMEOUT_SEC` | `300` | 框选工具自己的看门狗（下限 10s）；到点自动取消并还原窗口 |
| `DSH_DESKTOP_SHOT_TOOL_TRACE` | 未设 | 设成文件路径后，框选工具把每次鼠标/键盘/裁剪事件追加写进去（排查用） |

## 已知边界

- **仅 Windows**（Win32 + PowerShell + WinForms）。
- **自动投递依赖 composer 的隐藏 file input**（`input[type=file][multiple]`）：那是核心自己
  渲染的控件，也是"选择文件"按钮的入口。若核心改了它的形态（去掉 `multiple`、改成别的控件、
  或 `disabled`），客户端会找不到它，重试 6 轮后提示「已截取到剪贴板 —— Ctrl+V 粘贴」，
  功能不至于完全不可用。日志里对应 `no composer file input found` 与
  `file-input delivery did not land`。
- **本插件不占用 `conversation.input.attachments` 槽位**（原因见上文"投递"一节）。
  因此它不会影响官方的草稿缩略图轨道、拖放区或历史图片 gallery。
- **遮罩必须主动抢到"可见"，否则你看不到它**：后台进程新建的窗口**不会**盖住当前前台窗口——
  第一版就是窗口建出来了、`IsWindowVisible=True`、尺寸也对，但没有置顶位、排在用户正在看的窗口
  下面，于是"点了没反应"。现在分两层：
  1. `TakeOver()`：显式 `SetWindowLong(GWL_EXSTYLE |= WS_EX_TOPMOST)` + `SetWindowPos(HWND_TOPMOST)`
     + `AttachThreadInput` + `SetForegroundWindow`，并每 300ms 重试最多 6 次；
  2. **兜底** `owner fallback`：如果前 3 次都拿不到置顶/前台，就把遮罩挂成 **DSH 窗口的附属窗口**
     （owned window 必然画在 owner 之上），然后 `RestoreAndFocus(DSH)`——这条机制在生产里已证实可用。
     实测兜底触发后，后续重试连置顶位也一并拿到了（`takeover=7`）。
  每步结果都写进 stdout 的 `takeover` 位掩码，宿主日志里能直接看到：
  `bit0` 置顶、`bit1` 前台、`bit2` `SetForegroundWindow` 返回真、`bit3` 走了附属窗口兜底。
- **`-EncodedCommand` 有 32,767 字符的命令行上限**：选择器脚本 base64 后已经超了（34,576），
  直接 spawn 会报 `The filename or extension is too long`。所以脚本会落盘到
  `~/.dsh/dsh-desktop-shot-scripts/selector.ps1`（**UTF-8 带 BOM**，否则 PS 5.1 按 ANSI 读会把
  中文提示读花）再以 `-File` 调用。宿主每次运行前都会重写该文件，可以直接打开阅读/调试。
- **改宿主代码要重启 DSH，改客户端代码不用**：宿主线程会 stat-poll 每个插件的 `client.js`
  （比 mtime/ctime/size），一变就调 `rebuilt(id)` 重新读盘并热换模块；宿主侧模块被 ESM 的
  import 缓存锁住，必须重启进程。
- **装的时候要留意 `file:` 依赖是"复制"而不是软链**：profile 里写
  `"dsh-desktop-shot": "file:…/plugins/dsh-desktop-shot"` 时，pnpm 会把整个目录**复制**到
  `~/.dsh/profiles/<profile>/node_modules/dsh-desktop-shot`。改工作区文件不会影响运行中的插件，
  必须重新安装（或把依赖改成 `link:` 让它变成符号链接）。
- **跨进程 `ShowWindow` 可以用，但"窗口不进截图"不行**：外部进程调用
  `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` 实测被拒（`error 5`）；该 API 通常要求
  调用者就是窗口所有者。要做「窗口照常显示、但不进截图」（零闪烁的理想解）得改 `app.asar`
  里的 Electron 主进程，会被应用更新覆盖 —— 本插件不走这条路。
- 抓的是**整个虚拟屏幕**（多显示器合成一张），框选坐标即物理像素；150% 缩放下实测
  2560×1440 全幅正确（`bounds=2560x1440`）。
- 剪贴板里同时放 `Bitmap` 与 `PNG` 两种格式，Chromium 的粘贴事件会把它当成图片文件项，
  和 Snipping Tool 的行为一致。
- 宿主找不到窗口时返回 `window-not-found`；`ShowWindow` 被拦（例如权限/完整性等级不匹配）时返回
  `window did not minimize`，客户端分别给不同提示。

## 诊断

宿主把每一步写进 `~/.dsh/dsh-desktop-shot.log`：

- `minimized: hwnd=… toolTimeout=300s`
- `crop stored: 515002 bytes`（裁剪结果已交给宿主，等客户端取走）
- `crop dropped: collected by the client 515002 bytes` / `crop dropped: expired unread …`
  （一次性取件：被取走、超时 30s、重新截图或插件卸载都会丢弃）
- `selector settled: captured exit=0 selector end outcome=captured flags=3 crop=761x544 takeover=7`
- `selector settled: cancelled exit=3 …` / `timeout exit=5 …` / `failed exit=1 …`
- `selector settled: unloaded …`（插件卸载/重载时把没收尾的一轮定下结论，客户端才不会一直轮询）
- `selector stderr: …`（工具启动失败时的原始报错）
- `backstop restore: restore flags=3`（只在工具异常退出时才出现）
- `rejected: cross-origin request` / `rejected: missing or stale route token`（被安全守卫挡下的请求）
- `client: delivered crop 515002B into the composer via file-input (verified=true)`
- `client: no composer file input found` / `file-input delivery did not land (attempt N)` /
  `client: auto-insert failed: …`（自动投递没成功，此时图还在剪贴板里）
- `client: …`（页面侧报过来的其它关键步骤）

两个位掩码：

- `flags`（还原窗口）：`bit0` = 原本是最小化（我们去还原了）、`bit1` = 拿到前台成功、`bit2` = 窗口已经不在了。
- `takeover`（遮罩能不能被看见）：`bit0` = 置顶、`bit1` = 前台、`bit2` = `SetForegroundWindow` 返回真、`bit3` = 走了附属窗口兜底。

## 验证记录

本机 Windows（build 26200，2560×1440，150% 缩放）实测。下面这些数字是在**假窗口**上跑的，
脚本是从 `lib/index.mjs` 里**原文抽出来**、用生产同款 `-STA … -EncodedCommand` 调用的
（等于上线的那份）；唯一没覆盖的是对**真实 DSH 窗口**的那一次 `ShowWindow`——见文末。

**窗口操作能力**（两个自建进程互测，不碰 DSH 窗口）：

| 项目 | 实测 |
| --- | --- |
| 外部进程 `ShowWindow(SW_MINIMIZE/SW_HIDE/SW_SHOWNA)` | 可用，状态 **15–19ms** 内落地 |
| `DwmFlush()`（等 DWM 合成完成） | 2–6ms |
| 外部进程 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` | **被拒，error 5** |
| 本进程 `SetWindowDisplayAffinity` + `CopyFromScreen` | 生效（测试窗从抓屏里消失） |

**框选工具**：

| 用例 | 实测 |
| --- | --- |
| 最小化 → 遮罩出现 | **1053ms**，`shown bounds=2560x1440 at 0,0`（DPI 感知正确） |
| 合成拖拽 400,300 → 900,600 | `crop=500x300`，**像素级精确** |
| 裁剪结果 | 500×300，**完全不含遮罩 UI**（证明冻结帧在遮罩出现前抓的） |
| 剪贴板 | 拿到图，`Bitmap` + `PNG` 两种格式 |
| 窗口还原 | `flags=3`（原本最小化 + 拿到前台） |
| Esc 取消 | `outcome=cancelled`，退出码 3，剪贴板未被改动 |
| 看门狗超时 | `outcome=timeout`，退出码 5，准点触发 |
| **自动投递的交接点**：拖 400,300 → 900,600 后落盘的文件 | 存在，**500×300 PNG，315,835 字节**（客户端就是从这条路由取走它的） |
| 三个脚本的 PowerShell 语法解析 | 全部 clean |

**z 序 / 抢前台**（遮罩能不能被看见就靠这一条）：

| 用例 | 实测 |
| --- | --- |
| 遮罩 `takeover` 位掩码 | `takeover=7` = 置顶(bit0) + 前台(bit1) + `SetForegroundWindow` 返回真(bit2) |
| 遮罩 z 序 | `zIndex=0`（最顶层；曾经是 1，被用户正看着的窗口压着 → "点了没反应"） |
| 生产环境实测 | `selector settled: captured exit=0 … takeover=7` |

**自动投递**（0.4.4）：走 composer 自己的 file input，判定依据是"核心收下后把 `input.files` 清空"，
不再依赖任何槽位桥。日志：`client: delivered crop <N>B into the composer via file-input (verified=true)`。

**0.4.4 的回归验证**（沙箱内可复现的部分）：

| 用例 | 结果 |
| --- | --- |
| 三个脚本的 PowerShell 语法解析 | 全部 clean |
| 选择器脚本的 C# 整体编译（`Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing`） | **COMPILE OK**（这一步抓出了重构时误删的 `AttachThreadInput`/`ThreadOf`/`SetWindowPos` 声明与一个重复的 `SetWindowLongPtr`） |
| 兜底还原脚本的 C# 编译 | **COMPILE OK**；`RestoreAndFocus(0)` 返回 `flags=4`（窗口已不在，符合预期） |
| 端到端：跑真实选择器脚本并把 Esc 发给遮罩窗口 | 遮罩 **1200ms** 出现（`shown bounds=2560x1440 at 0,0`），Esc 被处理，`outcome=cancelled`，退出码 3，**未写出任何裁剪文件** |
| 路由守卫 | 无令牌 → `401 unauthorized`；错误令牌 → `401`；跨源 `Origin` → **403 forbidden**；`/token` 同源可取到令牌 |

**仍未覆盖的一环**：真实 DSH 窗口上的"点按钮 → 窗口收起 → 选中 → 自动进草稿"整链需要在 GUI 里
手动点一次（沙箱进程是 `Low Mandatory Level`、DSH 是 Medium，UIPI 会拦掉跨完整性等级的窗口操作）。

**没被自动化覆盖的一环**：对**真实 DSH 窗口**的那一次 `ShowWindow(SW_MINIMIZE)` 无法从 agent
沙箱里验证——沙箱进程是 `Low Mandatory Level`，而 DSH 是 Medium，UIPI 会拦掉跨完整性等级的窗口
操作。不过生产日志里有 `minimized: hwnd=… toolTimeout=300s`，说明它是可用的。若最小化没生效，
客户端会提示「窗口没能最小化」，日志里是 `window did not minimize`。

## 调试钩子

- 按钮 `[data-dsh-shot-button="1"]`；框选遮罩窗口标题 `dsh-desktop-shot`。
- 客户端关键步骤会 POST 到 `/api/dsh-desktop-shot/trace`，落到宿主日志（页面 console 我看不到）。
