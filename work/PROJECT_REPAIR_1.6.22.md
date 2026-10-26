# DKN Nexus 1.6.22 启动与交付修复

日期：2026-10-17（Asia/Shanghai）

## 当前结论

用户确认桌面快捷方式和1.6.21均打不开；主窗、托盘、Alt+Space均不可用。D-02为本次已关闭的旧Bug，原等级7/10；主类型为构建／交付的Windows安全标签，表现为启动／窗口生命周期失败，难度中。此前恢复互斥量和show修复未解决根因。

已确认候选EXE、固定Release EXE和debug EXE均从工作目录继承Low完整性标签。正常启动命令的身份是admin、完整性Medium，但其启动的DKN进程37676实际为Low（RID4096），桌面Explorer为Medium（RID8192）。WebView2使用原用户数据目录时返回0x800700AA“请求的资源在使用中”，Tauri随后保留没有原生句柄的窗口对象；show只报告发送成功，实际查询为FailedToReceiveMessage，形成后台残留。Low进程无法正常使用Medium用户数据目录也是诊断文件日志没有更新的原因；不能再把无新日志直接推断为未进入main。

用项目内独立、同为Low的WebView2目录启动后，原生窗口、托盘、快捷键和应用扫描成功，用户已明确确认能看到窗口。此对照证明数据目录可访问性是触发条件，不证明原配置内容损坏。当前不迁移、不清空、不重置原配置。

1.6.22的交付EXE已恢复Medium并核验；桌面快捷方式原有目标也更新为1.6.22。正式版PID34736实测为Medium（RID8192），使用原数据目录启动成功，框架日志恢复写入、原生窗口句柄检查通过、窗口API报告visible=true。用户明确答复“窗口正常，原数据也在”。二次启动23876正常退出0并聚焦原窗口，只保留原进程34736。用户随后明确确认Alt+Space和托盘图标／右键菜单“两项都正常”。D-02在1.6.22已修复，本次启动、原数据与入口验收完成，现关闭。H-05B完整媒体／性能证据缺口另行保留，不因本项关闭而视为通过。

## 交付产物

三份当前EXE内容一致：

- 构建源：`src-tauri/target/repair-1.6.21/release/dkn-nexus.exe`（目录名沿用缓存，文件版本为1.6.22）。
- 交付副本：`work/TASK_001/release/dkn-nexus-1.6.22.exe`。
- 桌面快捷方式固定目标：`src-tauri/target/release/dkn-nexus.exe`。

版本1.6.22；13,914,624字节；SHA-256 `EF8F75BBF096F4D26A90DD0CA687E74FF74AF41E25DDA551A9AEB2295EA734F3`；完整性Medium（RID8192）；未签名。不修改系统安全策略，不用管理员身份作为软件正常使用的前提。恢复完整性标签不改变文件内容或SHA；签名与完整性标签是两个独立属性。

## 代码与流程修复

- `scripts/verify-windows-release.ps1`：独立读取Windows文件完整性标签；拒绝Low或其他非Medium交付。可选NormalizeIntegrity只修正明确指定的项目内EXE并核验SHA不变，拒绝项目外路径。
- `package.json`：新增`release:desktop`（本地Release构建后规范EXE标签）和`verify:release`（固定入口只读校验）。复制候选后仍须检查目标副本，因为新文件可能重新继承目录的Low标签。
- `src-tauri/src/lib.rs`：初始化框架warn/error日志，保存WebView2创建错误；新增可选DKN_DIAGNOSTIC_DIR便于在项目目录采证；日志写标准错误失败不会再引发panic。
- Tauri setup检查主窗原生句柄，失败时显示具体启动错误并退出，不继续注册托盘/快捷键或假报ready。
- 恢复锁的两项测试串行使用进程级清理状态，租期验证改为有截止时间的轮询，避免测试彼此释放锁或依赖一次固定睡眠。
- 前端显示、package、lockfile、Cargo及Tauri版本统一到1.6.22。直接引用的log0.4.34原已在Cargo.lock中，不升级其他依赖。
- 临时的独立WebView探针例子未形成有效对照，已从源中移除；不将辅助工具自身失败算作新产品Bug。

## 数据保护与证据

- 原WebView配置只读备份到`work/startup-diagnostics/original-profile-copy`，666个文件、73,309,975字节，逐文件SHA与原目录一致；manifest为`original-profile-manifest.json`。
- 对照启动在`work/startup-diagnostics/isolated`，该目录不是正式用户数据目录。临时版PID37676已结束；随后才启动正式版。没有强制结束用户可见工作窗口。
- 框架错误记录：`work/startup-diagnostics/dkn-nexus.log`；成功对照日志：`isolated/dkn-nexus.log`。
- `release-integrity-verification.json`记录三份1.6.22产物及校验对照的版本、标签和SHA。
- `final-startup-verification.json`记录PID34736和Medium token。外部按窗口标题查询返回0，不能单独据此判断没有界面；本次采用应用内原生句柄保护、visible=true日志及用户实际确认综合判断。`single-instance-verification.json`记录二次启动通过。
- 原配置备份可能含用户数据，只用于本地恢复；不得打包进安装程序、公开提交或作为示例内容输出。

## 验证

- TypeScript、Vite生产构建及Rust Release构建：通过。
- 前端媒体与窗口生命周期合同：65/65通过。
- 当前生产bundle：7/7检查通过。
- 交付校验器：Medium候选通过；Low对照明确拒绝；项目外路径明确拒绝；NormalizeIntegrity后对照SHA不变；三份正式产物均Medium且SHA一致。
- 当前1.6.22 Rust单元测试：28/28通过，主入口测试目标0项也正常退出。两次自动审批超时后，用户明确批准；用`cargo test --locked --no-run --message-format=json`构建当前测试，再将Cargo明确返回的两个测试EXE规范为Medium后原样运行全部用例。Agent超时清理测试约1.01秒通过。日志`rust-tests.log`与编译产物清单`cargo-tests-build.jsonl`保留。
- 最终原配置启动与原数据：用户确认通过。Alt+Space、托盘图标及右键菜单：用户最终明确确认“两项都正常”，通过。二次启动单实例：通过。D-02关闭，验收依据包括实际用户交互确认，并非仅凭托盘创建日志。
- H-05B仍是旧6/10实机性能／媒体证据缺口，NOT_RUN，不改写为产品Bug已修复。

## 后续交接要求

最终1.6.22原配置启动、实际版本与Medium token、应用内原生句柄检查、visible日志和用户界面/旧数据确认均已完成。用户已完成最后Alt+Space与托盘交互核对，D-02关闭。不要将本次启动验收扩大为全部功能或H-05B性能矩阵通过，也不要只依据MainWindowHandle的单次值或构建成功判断可用。主窗隐藏到托盘后该值可能为0，应结合窗口API、托盘日志和用户反馈。

后续Windows交付必须运行标签校验；SHA一致不代表安全元数据一致。不可通过放宽整个用户数据目录权限、清空WebView2配置、关闭安全软件或修改整个工作区的强制完整性策略来绕过此问题。
