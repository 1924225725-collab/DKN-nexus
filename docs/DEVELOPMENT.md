# DKN Nexus 开发说明

当前源码版本为 1.6.22，主要运行环境是 Windows。开始修改前先阅读 `DKN_HANDOVER.md` 顶部的最新交接，再按需要查阅下面的架构和历史章节。

## 环境与启动

准备 Node.js 24 或 22.12+、npm、Rust MSVC 工具链、Windows C++ 构建工具及 WebView2 Runtime。仓库包含 npm 和 Cargo 锁文件。

```powershell
npm ci
npm run tauri dev
```

Tauri 开发命令会启动前端开发服务器。只运行 `npm run dev` 适合界面开发；普通浏览器不具备 Tauri IPC 和 Windows 原生能力。Vite 固定监听 `127.0.0.1:1421`，端口冲突时应先查明占用来源。

## 开发检查

| 命令 | 检查内容 |
| --- | --- |
| `npm run build` | TypeScript 检查与 Vite 生产构建 |
| `npm run test:media` | 媒体轮询、隐藏/显示和窗口生命周期前端合同 |
| `node tests/check-cdp-scripts.mjs` | Rust 内嵌 CDP JavaScript 的语法，不访问播放器 |
| `npm run check:bundle` | 生产构建及生成 JavaScript 的接口/文案检查 |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml` | Rust 类型和编译检查 |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | Rust 单元测试，部分用例使用本机子进程 |

按改动选择相关检查，并记录实际运行结果。构建通过不等于托盘、快捷键、音乐或外部 CLI 的真实交互通过。历史测试数字是当时证据，不能写成当前机器刚刚跑过。

## 本地 Release 交付

```powershell
npm run release:desktop
npm run verify:release
```

产物为 `src-tauri/target/release/dkn-nexus.exe`。`release:desktop` 在构建后对该文件运行 Windows 完整性标签校验/规范化；`verify:release` 只读检查固定交付目标。操作必须来自正常 Windows 用户终端。单文件校验脚本只接受项目内明确指定的 EXE，不改变内容哈希，不完成数字签名。

如将产物复制到项目内另一位置，需再检查副本：

```powershell
powershell.exe -NoProfile -File scripts/verify-windows-release.ps1 -ExecutablePath <项目内实际EXE路径> -NormalizeIntegrity
```

构建目录名可能来自历史缓存，不代表 EXE 的实际版本。验收应核对版本、路径、哈希、完整性标签与实际进程；隐藏到托盘后 `MainWindowHandle` 的单次值不能独立证明应用是否可用。

NSIS 是当前配置的 Windows 安装包目标。仅在需要正式安装包交付时构建，并另外验证安装、升级、卸载和用户数据保留。本仓库首次导入没有发布二进制 Release。

## 系统边界

- 主窗口、音乐窗、轮盘和 Agent 工作台有不同的可见性及生命周期。关闭、隐藏和退出的语义需要分别保留。
- 媒体查询遵循真实窗口可见性，不在隐藏时轮询，不重叠查询，不应用隐藏后的迟到结果。
- CLI 和本地 ASR 的取消/超时需要连同后代进程清理；新进程参数应继续避免 shell 字符串拼接。
- API 密钥由用户在运行时提供，Windows DPAPI 密文不能作为跨机器可用的示例配置。
- 外部 CLI 的路径、认证与版本属于本机依赖；不要从主项目中推定 DSH/CodeBuddy 独立插件的实现状态。

## 资源与仓库维护

首次发布时，本机工程约 52.10 GiB，绝大部分是 Rust 构建产物；本仓库只纳入必要源码和文字资料。`target/debug/incremental`、不同版本 target 目录、依赖缓存和生成物没有上传。

清理本地构建目录前先检查桌面快捷方式实际目标。原开发机曾直接指向 `src-tauri/target/release/dkn-nexus.exe`，删除整个 target 会同时删掉该入口。Git 忽略规则只影响后续版本管理，不会删除任何本机文件。
