> 2026-10-17当前版本：1.6.22本地Release。已修复EXE继承Low完整性标签造成的受限启动，交付候选及桌面快捷方式目标均Medium。正式版使用原配置启动，用户确认“窗口正常，原数据也在”；二次启动单实例通过。Rust28项、前端65项、bundle7项及Release构建通过。用户最终确认Alt+Space和托盘图标／右键菜单均正常，D-02关闭；H-05B实机性能/媒体矩阵仍NOT_RUN。详见work/PROJECT_REPAIR_1.6.22.md，历史验收见DKN_STATUS.md。
# DKN Nexus

**Der Klang des rastlosen Nachtregens**  
Developer: **夜雨声烦**

DKN Nexus **v1.6.22** is a Windows desktop launcher and personal workspace. It combines application discovery, category filtering, pinned and quick-launch apps, a local clipboard history, categorized reusable phrases, TXT notes, web shortcuts, saved chat history, and optional DeepSeek + Bocha AI services. Agent opens in a single workspace window that holds the projects, conversations, and model/account tools together, with configurable OpenAI-compatible text model APIs and global text-size presets.

> **1.6.22 local candidate:** release file security labels are now checked independently of
> executable hashes. A Low-integrity build must be finalized from a normal Windows user
> terminal before desktop testing. Runtime window-creation errors are logged; a missing
> native main window now produces an explicit startup error and exits. This is a local
> EXE delivery; original-profile startup and existing data are user-confirmed, and a second
> launch focuses the existing instance. The user also confirmed the global shortcut and tray menu;
> no installer is published.

## Current capabilities

- Tauri 2, React, and TypeScript; simplified Chinese is the default UI language.
- Start Menu/Desktop shortcut discovery, cached application icons and metadata, fast local search, keyboard navigation, pinning, and user-added applications.
- Local classification rules with optional user-triggered DeepSeek classification. User classification/category overrides take precedence over AI cache results.
- Optional classification cache and app metadata remain local. AI requests are only made after an explicit user action or chat send.
- Event-driven Windows clipboard capture, configurable local history (1–100 items; default 10), and copy-back without recording Nexus's own clipboard writes again.
- Quick-launch rail, TXT notes, user-defined categories, and validated HTTP(S) web shortcuts opened by the system default browser.
- DeepSeek chat and Bocha web search are separate providers. API keys are encrypted locally with Windows DPAPI. Chat requests use a bounded recent context.
- Agent opens in a dedicated, resizable single-instance window. Projects can be renamed, recategorized, moved to another folder, or removed from Nexus without deleting their files; each project retains multiple sequential task/conversation records. Codex and WorkBuddy are invoked through their CLI processes, and Nexus stores the workflow plan and captured results. This does not make Nexus prompts appear inside their separate native chat windows. The workspace also supports selectable models, local CLI login status, role routing, and OpenAI Images API-compatible image providers with DPAPI-protected keys and locally stored image results.
- System tray, global shortcut, hide-to-tray, configurable startup, and resizable custom window.
- Media control window reads the current Windows media session (GSMTC), with an optional local NetEase Cloud Music fallback. The music window is pre-created and hidden, so its media reads follow real visibility: nothing is queried while it is hidden, a slow query is never overlapped or queued, and results arriving after the window is hidden are discarded. Local-player probing uses a bounded, recoverable backoff instead of a permanent latch.
- A separate transparent radial overlay, configurable hold shortcut (default `Alt+Shift+Space`), local categorized clipboard favorites/phrases, quick paste, quick notes, saved web links, and a small Nexus AI input layer. Settings can record shortcuts by pressing and releasing the desired combination. Voice capture is optional and off by default; cloud ASR is not connected.
- NSIS is the configured Windows bundle target. The installer output and the actual install/upgrade/uninstall flow must be checked for each release; native UI acceptance items are tracked in `DKN_STATUS.md`.

## Development and release

```powershell
npm install
npm run build
npm run test:media
npm run check:bundle
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri dev
npm run release:desktop
npm run verify:release
```

`npm run test:media` runs the frontend contract tests for the media polling scheduler
(`src/services/mediaPolling.ts`) on virtual time. It uses Node's built-in test runner with type
stripping (Node 22.6+/24) and adds no production dependency.

`npm run check:bundle` runs the production Vite build, then checks the generated JavaScript for
the expected media interfaces and UI text.

`npm run release:desktop` builds a local Release EXE and normalizes that artifact to Windows
Medium integrity. Run this delivery step from a normal Windows user terminal. Sandbox output
can inherit Low integrity even when its file hash is correct; launching that EXE can then fail
to access the normal WebView2 profile. `npm run verify:release` checks the fixed desktop target
without changing it. After copying a candidate to another path inside the project, run
`scripts/verify-windows-release.ps1 -ExecutablePath <actual-candidate-path> -NormalizeIntegrity`
and verify the copy again. The script changes only the explicitly named EXE's label, preserves
its SHA-256, and refuses paths outside the project. It does not sign the EXE or change system policy.

`tauri build` is intentionally excluded from the routine development checks. Do not create an installer unless a release is explicitly requested.

The standalone development executable under `src-tauri/target/debug` is not a normal installed app and may need the Vite server. The release executable is generated under `src-tauri/target/release`; the NSIS installer is generated under `src-tauri/target/release/bundle/nsis`.

AI features need the user's own API keys and network access. Application classification can be wrong; user corrections are kept separately from AI results. Clipboard history and notes are local data. Uninstalling the application should not be treated as a backup plan for user data: copy important TXT notes and settings before uninstalling.

Build status, actual validation, unresolved issues, and manual test steps are maintained in [DKN_STATUS.md](DKN_STATUS.md).
