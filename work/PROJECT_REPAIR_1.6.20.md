# DKN Nexus 1.6.20 直接修复记录

日期：2026-10-17（Asia/Shanghai）  
范围：用户要求暂停既有流程约定，由本对话直接修复整个项目；不以旧任务流程代替实际检查。

## 当前结论

1.6.20 Release 已成功编译并复制到 `work/TASK_001/release/dkn-nexus-1.6.20.exe`。候选版本为 1.6.20，13,860,352 字节，SHA-256：`956930912935CE82C3019F1113B77DD42E0BA2C7B9185532E6A0F4FC9B6E7A31`。自动化测试和生产构建通过。

**桌面 GUI 尚未完成当前轮启动验证。** Windows 对 Shell 启动调用返回“操作已被用户取消”，之后没有 DKN Nexus 进程。Tauri 开发启动中的 Vite 已能在 IPv4 1421 端口运行，但 debug Rust build-script 在本受限启动上下文返回 `0xC0000142 / STATUS_DLL_INIT_FAILED`；Release 构建在获准的本地构建上下文成功。不能据此声称已完整确认 GUI 可用。

## 修复项及等级

| 编号 | 新旧属性 | 等级／类型／难度 | 修复与验证 |
| --- | --- | --- | --- |
| D-01 | **本轮新发现的旧代码 Bug，已修** | 5/10；生命周期／性能／进程管理；中 | Agent 工作流和本地语音识别超时后同步等待 `taskkill.status()`，一次 1 秒超时测试实际拖到约 21 秒。新增共享 Windows Job Object 管理，超时优先终止整个进程树；分配不可用时 `taskkill` 等待限制为 500ms，再终止直接子进程。最终超时回归约 1.01 秒通过。 |
| D-02 | **本轮新发现的旧代码启动恢复缺陷，已修** | 5/10；启动／生命周期／单实例；中 | 已有实例无任何可用顶层窗口时，单实例守卫等待约 1 秒后仍返回“不启动”，可能令恢复启动静默退出。改为允许一个恢复实例继续，并用独立恢复互斥量选举，避免并发恢复启动；创建互斥量前清空可能残留的 Win32 LastError，测试先注入ERROR_ALREADY_EXISTS再验证新建/重复恢复判断。GUI 级恢复流程尚未实机验证。 |
| D-03 | **本轮新发现的开发环境问题，已修** | 3/10；开发启动／兼容环境；低 | Vite/Tauri 使用 `localhost:1420` 时，本机 IPv6 `::1:1420` 冲突而 IPv4 可用，导致开发启动报端口占用。固定 Vite host 为 `127.0.0.1`，端口改为 1421，Tauri devUrl 同步；Vite 在 `127.0.0.1:1421` 成功启动。 |
| D-04 | **旧检查脚本的验证缺陷，已修** | 3/10；测试／构建验证；低 | 原 `check:bundle` 直接调用 esbuild 二进制，在当前环境路径访问失败，并要求未压缩函数名。改为先运行真实 Vite 生产构建，再检查生成 JS 资产中的关键媒体接口、UI 文案和控件标记；7项检查通过。 |
| H-09 | **历史工具 Bug，r10 已修并复验** | 4/10；功能／生命周期／性能与验证；中 | 采样器根进程身份校验、采样单飞、PID 复用处理与单次进程树快照均已修；27/27合同测试通过。 |
| H-10 | **历史工具 Bug，已修并复验** | 3/10；文件／编码；低 | 严格解码及写后字节验证在 27/27合同测试中通过。 |
| H-07 | **历史记录问题，已修并复验** | 2/10；文件／编码／文档；低 | manifest算法与实现、可读副本字节一致性回归通过。 |
| H-05B | **旧验证缺口，仍未关闭；不是已确认产品 Bug** | 6/10；实机测试／性能资源；中 | 尚未完成完整媒体交互和至少10分钟资源观察；`hiddenNewReads`、`maxInFlight`、退避/GPU证据仍缺。GUI未能在本轮启动，保持 NOT_RUN。 |

本轮未确认其他新的产品功能 Bug。以上结论只涵盖已跑自动化范围，不能代替未完成的实机矩阵。

## 修改文件

- `src-tauri/src/child_process.rs`：新增 Windows 子进程 Job Object 管理和有界清理回退。
- `src-tauri/src/agent_workflow.rs`、`src-tauri/src/local_asr.rs`：复用进程树管理，避免超时清理无限等待及遗留持有输出管道的子进程。
- `src-tauri/src/lib.rs`：窗口缺失时允许唯一恢复启动，并新增恢复互斥测试。
- `vite.config.ts`、`src-tauri/tauri.conf.json`、`package.json`：开发服务器固定为 IPv4 `127.0.0.1:1421`；`npm run dev` 使用 Tauri 已采用的 config loader。
- `tests/check-bundle.mjs`、`package.json`：检查真实 Vite 构建输出，执行 bundle check 前自动构建。
- `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`、`src/App.tsx`：统一版本升至 1.6.20。

## 验证结果

- `npm run test:media`：65/65 通过。
- `cargo test --locked`：27/27 通过；超时测试约 1.01 秒，恢复互斥量测试通过。
- `npm run build`：TypeScript与Vite生产构建成功，77个模块。
- `npm run check:bundle`：7/7检查通过，并先重建生产前端资源。
- `node --experimental-strip-types work/TASK_001/r10/tool-contracts.test.mjs`：27/27通过。
- `npm run tauri -- build --no-bundle`：Release成功，产品版本1.6.20。
- Release EXE与交付副本哈希一致：`956930912935CE82C3019F1113B77DD42E0BA2C7B9185532E6A0F4FC9B6E7A31`。
- Windows文件版本与产品版本均为1.6.20；该本地候选EXE当前未签名。
- 没有完成 GUI 当前启动、媒体播放/切歌/拖动、托盘/X/Esc交互及10分钟资源趋势验证；不将这些写为通过。

## 当前仍需完成

由用户在桌面启动 1.6.20 候选或允许 Windows 启动提示后，继续检查主窗口是否可见、冷启动/二次启动/无窗口恢复、托盘隐藏恢复、媒体控制和 H-05B 资源矩阵。若 GUI 启动失败，收集具体错误后继续修，不把系统取消提示归咎为产品 Bug。
