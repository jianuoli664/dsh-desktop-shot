# dsh-desktop-shot

集成在 DSH 桌面版里的**简单截图工具**：输入框旁边点一下 → 窗口收起、拖一个框 →
图片自动进草稿框。仅 Windows。

## 安装

1. 把本仓库放进插件目录（没有 git 就下 [ZIP](https://github.com/jianuoli664/dsh-desktop-shot/archive/refs/heads/main.zip) 解压到同一位置）：

   ```powershell
   git clone https://github.com/jianuoli664/dsh-desktop-shot.git "$env:USERPROFILE\.dsh\plugins\dsh-desktop-shot"
   ```

2. 在 profile 里登记依赖（`--profile` 换成你在用的那个，一般是 `desktop`）：

   ```powershell
   & "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "file:C:/Users/<你>/.dsh/plugins/dsh-desktop-shot"
   ```

3. 打开 `%USERPROFILE%\.dsh\profiles\<profile>\package.json`，确认 `dsh.profile.bundles`
   里有 `"dsh-desktop-shot"`（`pnpm add` 只写 `dependencies`，装载清单要自己补）。
4. 重启 DSH 桌面应用，输入框右侧出现截图按钮。

改 `lib/client.js` 不用重启（宿主按 mtime/size 轮询热换）；改 `lib/index.mjs` 必须重启进程。

## 用法

1. 点输入框右侧的截图按钮，DSH 窗口收起。
2. 拖一个矩形框（Esc / 右键取消，默认 300 秒超时自动取消）。
3. 裁剪图自动进草稿框。万一没进去，图还在剪贴板里，`Ctrl+V` 即可。

## 已知限制

- 仅 Windows（Win32 + PowerShell + WinForms）。
- 自动投递靠 composer 的隐藏 `input[type=file]`；核心改掉这个控件就只能退回剪贴板粘贴。
- 回合正在 `adjudicating` / `submitting` 时核心会拒收附件，长回合重试也救不了。

## 卸载

```powershell
& "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove dsh-desktop-shot
```

或从 profile 的 `package.json` 里删掉 `dependencies` 与 `dsh.profile.bundles` 中的
`dsh-desktop-shot` 两处，再重启。

## 文档

技术背景、踩坑记录和验证数据在 [docs/notes.md](docs/notes.md)。

## 许可

[MIT](LICENSE)
