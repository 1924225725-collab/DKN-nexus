# DKN Nexus

![DKN Nexus 图标](public/dkn-nexus-icon.png)

**一个以本地数据和快捷操作为中心的 Windows 桌面工作台。**

DKN 来自 *Der Klang des rastlosen Nachtregens*。Nexus 希望把应用启动、剪贴板、笔记、常用短语、网页入口、音乐控制和可选的 AI 工作流放在一个轻量、统一的桌面入口中，减少日常操作中的来回切换。

作者：**夜雨声烦**。当前源码版本：**1.6.22**。

本仓库提供源码、开发说明与项目交接资料。当前版本的交付记录是本地 Release EXE；本仓库首次导入没有附带安装包或 EXE，开发者可按下方说明自行构建。

## 已有能力

| 模块 | 当前能力 |
| --- | --- |
| 应用启动器 | 扫描开始菜单与桌面快捷方式；本地搜索、分类、固定、快捷启动及手动添加应用 |
| 剪贴板与短语 | Windows 剪贴板变更监听、本地历史、收藏和分类短语；历史数量可配置 |
| 笔记与网页 | TXT 笔记、快捷记录和经校验的 HTTP(S) 网页入口 |
| AI 对话与搜索 | 可选 DeepSeek 对话和博查搜索；支持本地保存聊天及配置 |
| Agent 工作台 | 独立窗口中的项目、任务和会话管理；CLI 进程执行与结果记录；可配置文本和图片服务 |
| 音乐控制 | Windows GSMTC 媒体会话；可选网易云音乐本机适配；隐藏窗口时停止轮询，限制重复查询 |
| 轮盘与系统入口 | 透明轮盘、全局快捷键、托盘、隐藏到托盘和开机启动设置 |

部分 AI、CLI 和本地语音能力需要用户自行配置服务、账号或外部程序；可见的配置入口不代表所有外部服务均已经联调通过。API 密钥使用 Windows DPAPI 在本机保护，仓库不包含账号、密钥或用户数据。

## 版本与验收状态

截至 **2026-10-17 的 1.6.22 记录**，已修复交付 EXE 继承 Windows Low 完整性标签导致的“后台有进程、无窗口/托盘”问题。用户确认原配置启动正常、原数据保留，Alt+Space 与托盘右键菜单正常，二次启动能够聚焦原实例。

该轮记录的检查结果为前端合同测试 65 项、生产 bundle 检查 7 项、Rust 单元测试 28 项通过，Release 构建通过。**2026-10-27 的 GitHub 导入只整理文档和发布文件，没有重新构建或重跑这些测试。**

仍需关注：

- **H-05B：媒体交互与长时间资源占用的完整实机矩阵仍为 NOT_RUN（6/10，验证缺口）**，不能由启动成功推断其已通过。
- 当前本地交付 EXE 未签名；完整安装、升级和卸载流程需要在正式发布时单独验收。
- Agent 的 Codex/WorkBuddy CLI 适配依赖实际安装版本和登录状态。2026-10-21 的既有检查发现 WorkBuddy 随附 CLI 默认入口缺模块；本仓库没有因此完成该接法的修复，也不承诺这些外部入口当前可用。
- 云端语音识别尚未接通；本地语音路径需要额外的运行环境。

最新交接结论见 [DKN_HANDOVER.md](DKN_HANDOVER.md) 顶部，历史记录见 [DKN_STATUS.md](DKN_STATUS.md)，问题等级和新旧属性见 [DKN_ISSUE_LEVELS.md](DKN_ISSUE_LEVELS.md)。历史任务中出现的“当前”“待验收”等字样应结合日期阅读。

## 技术架构

前端使用 **React 19、TypeScript 和 Vite 7**；原生层使用 **Rust 与 Tauri 2**。Windows WebView2 承载界面，Rust 命令提供应用扫描、剪贴板、窗口、媒体会话、文件和进程等能力。项目没有必须部署的独立服务器，外部 AI 服务按用户配置接入。

主窗口、Agent 工作台、音乐窗口与轮盘由 Tauri 管理。应用偏好、笔记、聊天和任务记录以本地文件或 WebView 存储为主；具体数据契约和模块责任见交接文档。

```text
React / TypeScript 界面
          │ Tauri IPC / 事件
Rust 原生模块
          ├─ Windows 窗口、托盘、快捷键、剪贴板与媒体会话
          ├─ 本地配置、笔记、历史与受保护密钥
          └─ 用户配置的 AI 服务 / 本机 CLI 子进程
```

## 开始开发

本项目主要面向 Windows。准备可运行 Vite 7 的 Node.js（建议 24，或 22.12+）、npm、Rust MSVC 工具链、Windows C++ 构建工具和 WebView2 Runtime，并确保相关命令可在终端访问。

```powershell
git clone https://github.com/1924225725-collab/DKN-nexus.git
cd DKN-nexus
npm ci
npm run tauri dev
```

前端开发端口为 `127.0.0.1:1421`。主要开发、检查和构建命令，以及窗口与交付注意事项见 [开发说明](docs/DEVELOPMENT.md)。

```powershell
npm run test:media
node tests/check-cdp-scripts.mjs
npm run check:bundle
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

构建本地 Release EXE：

```powershell
npm run release:desktop
npm run verify:release
```

交付流程应在正常 Windows 用户终端运行。产物位于 `src-tauri/target/release/dkn-nexus.exe`。EXE 的 SHA-256 与 Windows 安全标签需要分别检查；复制到新位置后也应重新检查副本。安装包构建与验收不包含在这个命令中。

## 目录与资料

| 路径 | 作用 |
| --- | --- |
| `src/` | 界面、业务状态、服务桥接、媒体轮询与轮盘逻辑 |
| `src-tauri/src/` | Rust 原生能力、Agent/模型调用、媒体与子进程管理 |
| `src-tauri/capabilities/` | Tauri 窗口权限声明 |
| `src-tauri/icons/`、`public/` | 应用图标与静态资源 |
| `tests/`、`scripts/` | 合同检查、bundle/CDP 检查和 Windows 交付校验 |
| `DKN_HANDOVER.md` | 架构、技术决策、状态及接手须知 |
| `DKN_STATUS.md` | 按历史阶段保留的开发与验收记录 |
| `work/PROJECT_REPAIR_1.6.2*.md` | 本次选入仓库的启动修复文字报告 |
| `docs/REPOSITORY_SCOPE.md` | 上传范围、脱敏说明与本机证据边界 |

旧任务单、Prompt 和流程补充保留用于理解历史，不代表新的开发授权；以用户当前要求和交接文档最新状态为准。历史记录引用的部分本机证据、外部协议和构建产物没有公开，缺失时应说明，不能推定已验证。

问题反馈请提供版本、复现步骤和脱敏后的错误提示。分享日志前检查个人内容、路径和凭据。
