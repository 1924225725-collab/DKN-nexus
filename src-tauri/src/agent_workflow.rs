use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const MAX_CAPTURED_OUTPUT: usize = 2 * 1024 * 1024;
const ROUTING_TIMEOUT: Duration = Duration::from_secs(180);
const PLANNING_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const CODING_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const REVIEW_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowProgress {
    task_id: String,
    stage: String,
    agent: String,
    model: String,
    message: String,
    output: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteTarget {
    id: String,
    name: String,
    category: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRoute {
    project_id: Option<String>,
    new_project_name: Option<String>,
    new_project_category: Option<String>,
    reason: String,
    #[serde(default)]
    model: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelSelection {
    #[serde(default)]
    codex: String,
    #[serde(default)]
    workbuddy: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProviderInfo {
    codex_account: String,
    codex_status: String,
    workbuddy_account: String,
    workbuddy_status: String,
    workbuddy_models: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPlanDraft {
    summary: String,
    steps: Vec<AgentPlanDraftStep>,
    #[serde(default)]
    model: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentPlanDraftStep {
    title: String,
    description: String,
    role: String,
    #[serde(default)]
    user_prompt: Option<String>,
    #[serde(default)]
    image_choice: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStepResult {
    output: String,
    agent: String,
    model: String,
}

fn selected_model(value: &str, provider: &str) -> Result<Option<String>, String> {
    let model = value.trim();
    if model.is_empty() { return Ok(None); }
    if model.starts_with('-') || model.len() > 100 || !model.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._:/-".contains(&byte)) {
        return Err(format!("{provider} 模型 ID 只能包含字母、数字、点、下划线、冒号、斜线或连字符。"));
    }
    Ok(Some(model.to_string()))
}

fn emit_progress(app: &AppHandle, task_id: &str, stage: &str, agent: &str, model: &str, message: &str, output: Option<String>) {
    let _ = app.emit("agent-workflow-progress", WorkflowProgress {
        task_id: task_id.to_string(),
        stage: stage.to_string(),
        agent: agent.to_string(),
        model: model.to_string(),
        message: message.to_string(),
        output,
    });
}

fn find_on_path(names: &[&str]) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    for directory in env::split_paths(&path) {
        for name in names {
            let candidate = directory.join(name);
            if candidate.is_file() { return Some(candidate); }
        }
    }
    None
}

fn codex_executable() -> Result<PathBuf, String> {
    if let Some(path) = find_on_path(&["codex.exe", "codex"]) { return Ok(path); }
    let local = env::var_os("LOCALAPPDATA").map(PathBuf::from).ok_or_else(|| "找不到本机 Codex CLI；请先安装并登录 Codex CLI。".to_string())?;
    let root = local.join("OpenAI").join("Codex").join("bin");
    let mut candidates = fs::read_dir(root).map_err(|_| "找不到本机 Codex CLI；请先安装并登录 Codex CLI。".to_string())?
        .filter_map(Result::ok).map(|entry| entry.path().join("codex.exe"))
        .filter(|path| path.is_file()).collect::<Vec<_>>();
    candidates.sort_by_key(|path| fs::metadata(path).and_then(|meta| meta.modified()).ok());
    candidates.pop().ok_or_else(|| "找不到本机 Codex CLI；请先安装并登录 Codex CLI。".to_string())
}

fn codex_home_directory() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("CODEX_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    let profile = env::var_os("USERPROFILE")
        .filter(|value| !value.is_empty())
        .or_else(|| env::var_os("HOME").filter(|value| !value.is_empty()))
        .ok_or_else(|| "无法定位当前 Windows 用户的 Codex 数据目录；请检查 USERPROFILE 或 CODEX_HOME。".to_string())?;
    Ok(PathBuf::from(profile).join(".codex"))
}

fn codex_command(executable: &Path) -> Result<Command, String> {
    let mut command = Command::new(executable);
    command.env("CODEX_HOME", codex_home_directory()?);
    Ok(command)
}

fn workbuddy_command() -> Result<(PathBuf, PathBuf), String> {
    let local = env::var_os("LOCALAPPDATA").map(PathBuf::from).ok_or_else(|| "找不到 WorkBuddy 本地安装目录。".to_string())?;
    let app = local.join("Programs").join("WorkBuddy").join("resources").join("app.asar.unpacked").join("cli").join("bin").join("codebuddy");
    let bundled_node = local.join("Programs").join("dkn-node").join("node.exe");
    let node = if bundled_node.is_file() { Some(bundled_node) } else { find_on_path(&["node.exe", "node"]) };
    if app.is_file() && node.is_some() { Ok((node.unwrap(), app)) }
    else { Err("没有找到 WorkBuddy 随附的 CodeBuddy CLI。请确认 WorkBuddy 已安装并登录。".to_string()) }
}

fn read_capped<R: Read + Send + 'static>(mut reader: R) -> thread::JoinHandle<(Vec<u8>, bool)> {
    thread::spawn(move || {
        let mut captured = Vec::with_capacity(64 * 1024);
        let mut buffer = [0u8; 8192];
        let mut truncated = false;
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let copied = count.min(MAX_CAPTURED_OUTPUT.saturating_sub(captured.len()));
                    captured.extend_from_slice(&buffer[..copied]);
                    truncated |= copied < count;
                }
            }
        }
        (captured, truncated)
    })
}

fn process_output(command: &mut Command, directory: &Path, task_id: &str, phase: &str, timeout: Duration) -> Result<Output, String> {
    command.current_dir(directory).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let executable = Path::new(command.get_program()).file_name().unwrap_or(command.get_program()).to_string_lossy();
    crate::diagnostic_log(format!("agent:process:start task={task_id} phase={phase} executable={executable} timeout_secs={}", timeout.as_secs()));
    let started = Instant::now();
    let mut process_job = crate::child_process::ChildProcessJob::new();
    let mut child = command.spawn().map_err(|error| {
        crate::diagnostic_log(format!("agent:process:spawn_failed task={task_id} phase={phase}"));
        format!("{phase}阶段无法启动 Agent 命令：{error}")
    })?;
    let _job_assigned = process_job.assign(&child);
    #[cfg(windows)]
    if !_job_assigned {
        crate::diagnostic_log(format!("agent:process:job-assignment-unavailable task={task_id} phase={phase}"));
    }
    let stdout = child.stdout.take().ok_or_else(|| format!("{phase}阶段无法读取 Agent 输出。"))?;
    let stderr = child.stderr.take().ok_or_else(|| format!("{phase}阶段无法读取 Agent 日志。"))?;
    let stdout_reader = read_capped(stdout);
    let stderr_reader = read_capped(stderr);

    let mut wait_error = None;
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() >= timeout => {
                timed_out = true;
                process_job.terminate(&mut child);
                break;
            }
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(error) => {
                wait_error = Some(error.to_string());
                process_job.terminate(&mut child);
                break;
            }
        }
    }
    let status = child.wait().map_err(|error| format!("{phase}阶段等待 Agent 进程结束失败：{error}"))?;
    drop(process_job);
    let (stdout, stdout_truncated) = stdout_reader.join().map_err(|_| format!("{phase}阶段读取 Agent 输出失败。"))?;
    let (stderr, stderr_truncated) = stderr_reader.join().map_err(|_| format!("{phase}阶段读取 Agent 日志失败。"))?;
    let elapsed_ms = started.elapsed().as_millis();
    crate::diagnostic_log(format!("agent:process:finish task={task_id} phase={phase} status={} elapsed_ms={elapsed_ms} stdout_bytes={} stderr_bytes={} truncated={}", status.code().unwrap_or(-1), stdout.len(), stderr.len(), stdout_truncated || stderr_truncated));
    if let Some(error) = wait_error { return Err(format!("{phase}阶段等待 Agent 进程失败：{error}")); }
    if timed_out {
        return Err(format!("{phase}阶段超过 {} 分钟，已自动终止相关进程。请检查对应 CLI 是否已登录、网络是否正常，然后重试。", timeout.as_secs().div_ceil(60)));
    }
    Ok(Output { status, stdout, stderr })
}

fn output_text(output: &Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let combined = if stdout.is_empty() { stderr } else if stderr.is_empty() { stdout } else { format!("{stdout}\n\n[Agent 日志]\n{stderr}") };
    let mut chars = combined.chars();
    let bounded = chars.by_ref().take(24_000).collect::<String>();
    if chars.next().is_some() { format!("{bounded}\n\n（输出已截断）") } else { bounded }
}

fn model_label(output: &Output, requested_model: Option<&str>, provider: &str) -> String {
    if let Some(model) = String::from_utf8_lossy(&output.stderr).lines().find_map(|line| {
        line.trim().strip_prefix("model: ").filter(|value| !value.is_empty()).map(str::to_string)
    }) {
        return format!("CLI 实际回报：{model}");
    }
    match requested_model {
        Some(model) => format!("已请求 {model} · CLI 未回报实际型号"),
        None => format!("{provider} CLI 默认 · 未回报实际型号"),
    }
}

fn ensure_success(name: &str, output: &Output) -> Result<String, String> {
    let text = output_text(output);
    if !output.status.success() { return Err(format!("{name}执行失败：{}", if text.is_empty() { "没有返回错误详情" } else { &text })); }
    if text.trim().is_empty() { return Err(format!("{name}没有返回结果。")); }
    Ok(text)
}

fn codex_exec_command(executable: &Path, directory: &Path, model: Option<&str>, prompt: String) -> Result<Command, String> {
    codex_exec_command_with_sandbox(executable, directory, model, prompt, "read-only")
}

fn codex_exec_command_with_sandbox(executable: &Path, directory: &Path, model: Option<&str>, prompt: String, sandbox: &str) -> Result<Command, String> {
    let mut command = codex_command(executable)?;
    command.args(["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", sandbox]);
    if let Some(model) = model { command.args(["--model", model]); }
    command.args(["--color", "never", "--cd"]).arg(directory).arg(prompt);
    Ok(command)
}

fn parse_agent_plan(response: &str) -> Result<AgentPlanDraft, String> {
    let mut object_start = None;
    let mut depth = 0usize;
    let mut quoted = false;
    let mut escaped = false;
    for (index, character) in response.char_indices() {
        if object_start.is_none() {
            if character == '{' { object_start = Some(index); depth = 1; }
            continue;
        }
        if quoted {
            if escaped { escaped = false; }
            else if character == '\\' { escaped = true; }
            else if character == '"' { quoted = false; }
            continue;
        }
        match character {
            '"' => quoted = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    if let Some(start) = object_start {
                        if let Ok(mut plan) = serde_json::from_str::<AgentPlanDraft>(&response[start..=index]) {
                            plan.summary = plan.summary.trim().chars().take(6000).collect();
                            plan.steps.retain_mut(|step| {
                                step.title = step.title.trim().chars().take(120).collect();
                                step.description = step.description.trim().chars().take(5000).collect();
                                step.role = step.role.trim().to_ascii_lowercase();
                                step.user_prompt = step.user_prompt.take().map(|value| value.trim().chars().take(1000).collect());
                                !step.title.is_empty() && !step.description.is_empty() && matches!(step.role.as_str(), "coding" | "analysis" | "review" | "image" | "audio" | "music" | "user")
                            });
                            plan.steps.truncate(8);
                            if !plan.summary.is_empty() && !plan.steps.is_empty() { return Ok(plan); }
                        }
                    }
                    object_start = None;
                }
            }
            _ => {}
        }
    }
    Err("Codex 没有返回有效的动态行动方案；请重试，或简化任务描述。".to_string())
}

fn parse_workbuddy_models(help: &str) -> Vec<String> {
    let Some(marker) = help.find("Currently supported:") else { return Vec::new(); };
    let Some(open) = help[marker..].find('(').map(|offset| marker + offset) else { return Vec::new(); };
    let Some(close) = help[open + 1..].find(')').map(|offset| open + 1 + offset) else { return Vec::new(); };
    help[open + 1..close].split(',').map(str::trim)
        .filter(|model| !model.is_empty() && model.len() <= 100 && model.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._:/-".contains(&byte)))
        .map(str::to_string).collect()
}

fn codex_account_status() -> (String, String) {
    let Ok(executable) = codex_executable() else { return ("未找到本机 Codex CLI，无法读取登录状态。".to_string(), "unknown".to_string()); };
    let Ok(mut command) = codex_command(&executable) else { return ("无法定位 Codex 登录数据目录。".to_string(), "unknown".to_string()); };
    command.args(["login", "status"]);
    let Ok(output) = process_output(&mut command, &env::temp_dir(), "provider-status", "Codex 登录状态", Duration::from_secs(8)) else {
        return ("无法读取 Codex 登录状态；请检查本机 Codex CLI。".to_string(), "unknown".to_string());
    };
    let response = output_text(&output).to_ascii_lowercase();
    if response.contains("logged in using chatgpt") || response.contains("logged in with chatgpt") {
        ("已使用 ChatGPT 登录；Codex 派单、策划与验收使用此账户额度。".to_string(), "connected".to_string())
    } else if response.contains("logged in using api key") || response.contains("logged in with api key") {
        ("已使用 API Key 登录；Codex 派单、策划与验收使用此凭据（不会显示密钥）。".to_string(), "connected".to_string())
    } else if response.contains("not logged in") {
        ("Codex CLI 当前未登录。".to_string(), "disconnected".to_string())
    } else {
        ("Codex CLI 已返回登录状态，但未提供可识别的账户类型。".to_string(), "unknown".to_string())
    }
}

fn workbuddy_model_catalog() -> Vec<String> {
    let Ok((node, executable)) = workbuddy_command() else { return Vec::new(); };
    let mut command = Command::new(node);
    command.arg(executable).arg("--help");
    let Ok(output) = process_output(&mut command, &env::temp_dir(), "provider-status", "WorkBuddy 模型列表", Duration::from_secs(8)) else {
        return Vec::new();
    };
    if !output.status.success() { return Vec::new(); }
    parse_workbuddy_models(&output_text(&output))
}

#[tauri::command]
pub async fn get_agent_provider_info() -> Result<AgentProviderInfo, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (codex_account, codex_status) = codex_account_status();
        AgentProviderInfo {
            codex_account,
            codex_status,
            workbuddy_account: "编码阶段使用 WorkBuddy 当前桌面登录账户；CodeBuddy CLI 不公开可安全读取的账号名，请在 WorkBuddy 客户端确认当前账户头像。".to_string(),
            workbuddy_status: "unknown".to_string(),
            workbuddy_models: workbuddy_model_catalog(),
    }}).await.map_err(|error| format!("读取本机 Agent 信息失败：{error}"))
}

fn parse_project_route(response: &str) -> Result<ProjectRoute, String> {
    let mut object_start = None;
    let mut depth = 0usize;
    let mut quoted = false;
    let mut escaped = false;
    for (index, character) in response.char_indices() {
        if object_start.is_none() {
            if character == '{' { object_start = Some(index); depth = 1; }
            continue;
        }
        if quoted {
            if escaped { escaped = false; }
            else if character == '\\' { escaped = true; }
            else if character == '"' { quoted = false; }
            continue;
        }
        match character {
            '"' => quoted = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    if let Some(start) = object_start {
                        if let Ok(route) = serde_json::from_str::<ProjectRoute>(&response[start..=index]) { return Ok(route); }
                    }
                    object_start = None;
                }
            }
            _ => {}
        }
    }
    Err("Codex 没有返回可识别的项目匹配 JSON；请重试，或直接在项目组中选择项目。".to_string())
}

#[tauri::command]
pub fn pick_project_directory() -> Result<Option<String>, String> {
    #[cfg(windows)] {
        let script = "Add-Type -AssemblyName System.Windows.Forms; $dialog=New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description='选择要交给 Agent 处理的项目目录'; $dialog.ShowNewFolderButton=$true; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::Write($dialog.SelectedPath) }";
        let mut command = Command::new("powershell");
        command.args(["-STA", "-NoProfile", "-NonInteractive", "-Command", script]).stdin(Stdio::null());
        let output = command.output().map_err(|error| format!("无法打开项目目录选择器：{error}"))?;
        if !output.status.success() { return Err("项目目录选择器打开失败。".to_string()); }
        let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok((!selected.is_empty()).then_some(selected));
    }
    #[cfg(not(windows))] { Err("项目目录选择器目前仅支持 Windows。".to_string()) }
}

#[tauri::command]
pub fn pick_agent_resource_file(kind: String) -> Result<Option<String>, String> {
    #[cfg(windows)] {
        let (title, filter) = match kind.as_str() {
            "image" => ("选择要加入项目的图片", "图片 (*.png;*.jpg;*.jpeg;*.webp;*.gif;*.svg)|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.svg|所有文件 (*.*)|*.*"),
            "package" => ("选择项目相关安装包", "安装包 (*.exe;*.msi;*.msix;*.zip;*.7z)|*.exe;*.msi;*.msix;*.zip;*.7z|所有文件 (*.*)|*.*"),
            _ => return Err("不支持的项目文件类型。".to_string()),
        };
        let script = format!("Add-Type -AssemblyName System.Windows.Forms; $dialog=New-Object System.Windows.Forms.OpenFileDialog; $dialog.Title='{title}'; $dialog.Filter='{filter}'; $dialog.CheckFileExists=$true; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{ [Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::Write($dialog.FileName) }}");
        let mut command = Command::new("powershell");
        command.args(["-STA", "-NoProfile", "-NonInteractive", "-Command", &script]).stdin(Stdio::null());
        let output = command.output().map_err(|error| format!("无法打开项目文件选择器：{error}"))?;
        if !output.status.success() { return Err("项目文件选择器打开失败。".to_string()); }
        let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok((!selected.is_empty()).then_some(selected));
    }
    #[cfg(not(windows))] { Err("项目文件选择器目前仅支持 Windows。".to_string()) }
}

#[tauri::command]
pub fn copy_agent_image_to_project(project_path: String, source_path: String) -> Result<String, String> {
    const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;
    let project = PathBuf::from(project_path.trim()).canonicalize().map_err(|_| "项目目录不存在，请重新选择。".to_string())?;
    if !project.is_dir() { return Err("项目目录不存在，请重新选择。".to_string()); }
    let source = PathBuf::from(source_path.trim()).canonicalize().map_err(|_| "所选图片不存在或无法读取。".to_string())?;
    if !source.is_file() { return Err("所选图片不是文件。".to_string()); }
    let extension = source.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif" | "svg") {
        return Err("图片仅支持 PNG、JPG、WebP、GIF 或 SVG。".to_string());
    }
    let metadata = fs::metadata(&source).map_err(|error| format!("读取图片信息失败：{error}"))?;
    if metadata.len() == 0 { return Err("所选图片是空文件。".to_string()); }
    if metadata.len() > MAX_IMAGE_BYTES { return Err("图片超过 32 MB，请先压缩后再加入项目。".to_string()); }

    let asset_directory = project.join("assets").join("user-provided");
    fs::create_dir_all(&asset_directory).map_err(|error| format!("无法创建项目图片目录：{error}"))?;
    let asset_directory = asset_directory.canonicalize().map_err(|error| format!("无法定位项目图片目录：{error}"))?;
    if !asset_directory.starts_with(&project) { return Err("项目图片目录指向项目以外的位置，已停止复制。".to_string()); }

    let original_name = source.file_stem().and_then(|value| value.to_str()).unwrap_or("image");
    let safe_name = original_name.chars().take(70).map(|character| {
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') { character } else { '-' }
    }).collect::<String>();
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let destination = asset_directory.join(format!("dkn-{timestamp}-{safe_name}.{extension}"));
    fs::copy(&source, &destination).map_err(|error| format!("复制图片到项目目录失败：{error}"))?;
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn route_agent_project(prompt: String, projects: Vec<RouteTarget>, models: AgentModelSelection) -> Result<ProjectRoute, String> {
    let task = prompt.trim().to_string();
    if task.is_empty() { return Err("请先写下任务内容。".to_string()); }
    let codex_model = selected_model(&models.codex, "Codex")?;
    tauri::async_runtime::spawn_blocking(move || {
        let codex = codex_executable()?;
        let project_list = projects.iter().map(|project| serde_json::json!({ "id": project.id, "name": project.name, "category": project.category })).collect::<Vec<_>>();
        let router_prompt = format!("你是 DKN Nexus 的本地项目派单员。只能依据给定的项目名称和分类选择项目，禁止猜测项目路径、仓库内容或用户隐私。若任务明确属于某个现有项目，返回该项目 id；若没有合适项目，建议新项目名称和分类。分类只能是开发、桌面软件、网页、自动化、其他。只输出一个 JSON 对象，不要 Markdown，结构为 {{\"projectId\": string|null, \"newProjectName\": string|null, \"newProjectCategory\": string|null, \"reason\": string}}。\n\n现有项目：\n{}\n\n用户任务：\n{}", serde_json::to_string(&project_list).unwrap_or_else(|_| "[]".to_string()), task);
        let mut command = codex_exec_command(&codex, &env::temp_dir(), codex_model.as_deref(), router_prompt)?;
        let output = process_output(&mut command, &env::temp_dir(), "dispatch", "项目匹配", ROUTING_TIMEOUT)?;
        let model = model_label(&output, codex_model.as_deref(), "Codex");
        let response = ensure_success("Codex 项目匹配", &output)?;
        let mut route = parse_project_route(&response)?;
        route.model = model;
        if let Some(id) = route.project_id.as_ref() {
            if !projects.iter().any(|project| &project.id == id) { return Err("Codex 返回了不存在的项目编号。".to_string()); }
            route.new_project_name = None;
            route.new_project_category = None;
        } else {
            let name = route.new_project_name.as_deref().unwrap_or("").trim();
            if name.is_empty() { return Err("没有项目匹配，也没有可用的新项目名称。".to_string()); }
            route.new_project_name = Some(name.chars().take(60).collect());
            if !matches!(route.new_project_category.as_deref(), Some("开发" | "桌面软件" | "网页" | "自动化" | "其他")) {
                route.new_project_category = Some("开发".to_string());
            }
        }
        Ok(route)
    }).await.map_err(|error| format!("项目匹配工作线程异常：{error}"))?
}

#[tauri::command]
pub async fn plan_agent_task(task_id: String, project_path: String, prompt: String, models: AgentModelSelection, image_api_available: bool) -> Result<AgentPlanDraft, String> {
    let project = PathBuf::from(project_path.trim());
    let task = prompt.trim().to_string();
    if task.is_empty() { return Err("请先写下任务内容。".to_string()); }
    if !project.is_dir() { return Err("项目目录不存在，请重新选择。".to_string()); }
    let codex_model = selected_model(&models.codex, "Codex")?;
    tauri::async_runtime::spawn_blocking(move || {
        let codex = codex_executable()?;
        let image_api_status = if image_api_available { "用户已配置可用的图片生成 API。" } else { "用户尚未配置可用的图片生成 API。" };
        let planner_prompt = format!("你是 DKN Nexus 的总控策划。先只读检查当前项目的必要结构与相关文件，再根据用户目标自行决定需要几步、每步交给谁；不要套用固定的策划/编码/验收三段模板。只规划真正需要的工作，最多 8 步，可以不包含编码或验收。\n\n每步 role 只能是：coding（项目代码实现）、analysis（文本分析/方案）、review（只读检查）、image（调用图片 API 生图）、audio（声音/语音）、music（音乐）、user（需要用户选择、确认或在外部工具中操作）。\n图标和简单界面装饰优先用项目已有图标、CSS、代码绘制 SVG 或文字符号实现，不要为了小图标要求用户生成图片。仅当用户明确要图片，或任务确实需要独立插画、照片、复杂背景等位图素材时，才增加一个 role=user 的图片素材选择步骤；该步骤必须设置 imageChoice=true，让用户在运行阶段选择图片 API、上传本地图片，或继续采用代码绘制方案。选择上传时，图片会被复制到项目 assets/user-provided 并提供路径给后续编码步骤。\n{image_api_status} 如果没有可用 API，严禁创建 role=image 步骤，也不能把未配置 API 当作任务失败；仍提供本地上传和 CSS/SVG 继续选项。只有 imageChoice 步骤确认使用已配置 API 后，才由程序插入图片生成步骤。\n若工作需要人类作其他决定或当前尚未接入的声音/音乐工具，使用普通 user 步骤并写清 userPrompt；不得假称本机已能生成音频或音乐。\n只输出一个 JSON 对象，不要 Markdown，格式：{{\"summary\":\"整体思路\",\"steps\":[{{\"title\":\"步骤标题\",\"description\":\"具体目标与边界\",\"role\":\"coding|analysis|review|user\",\"userPrompt\":\"仅 user 步骤填写\",\"imageChoice\":false}}]}}。图片选择步骤请将 imageChoice 设为 true，其他步骤为 false。用简体中文。\n\n用户目标：\n{task}");
        let mut command = codex_exec_command(&codex, &project, codex_model.as_deref(), planner_prompt)?;
        let output = process_output(&mut command, &project, &task_id, "动态策划", PLANNING_TIMEOUT)?;
        let model = model_label(&output, codex_model.as_deref(), "Codex");
        let response = ensure_success("Codex 动态策划", &output)?;
        let mut plan = parse_agent_plan(&response)?;
        plan.model = model;
        Ok(plan)
    }).await.map_err(|error| format!("行动方案生成工作线程异常：{error}"))?
}

#[tauri::command]
pub async fn execute_agent_plan_step(
    task_id: String,
    project_path: String,
    task_prompt: String,
    plan_summary: String,
    title: String,
    description: String,
    role: String,
    provider: String,
    prior_results: Vec<String>,
    models: AgentModelSelection,
) -> Result<AgentStepResult, String> {
    let project = PathBuf::from(project_path.trim());
    if !project.is_dir() { return Err("项目目录不存在，请重新选择。".to_string()); }
    if !matches!(role.as_str(), "coding" | "analysis" | "review") {
        return Err("图片、声音、音乐及用户参与步骤目前需要手动完成；尚未连接对应执行服务。".to_string());
    }
    if provider == "workbuddy" && role != "coding" {
        return Err("WorkBuddy 当前只接入项目编码步骤，请在此角色中选择 Codex、DeepSeek（仅文本分析）或手动处理。".to_string());
    }
    if provider != "codex" && provider != "workbuddy" {
        return Err("此步骤选择的 Agent 执行器尚未接入。".to_string());
    }
    let task = task_prompt.trim().to_string();
    if task.is_empty() { return Err("任务内容为空。".to_string()); }
    let codex_model = selected_model(&models.codex, "Codex")?;
    let workbuddy_model = selected_model(&models.workbuddy, "WorkBuddy")?;
    tauri::async_runtime::spawn_blocking(move || {
        let prior_context = prior_results.iter().rev().take(6).cloned().collect::<Vec<_>>().into_iter().rev().map(|value| value.chars().take(5000).collect::<String>()).collect::<Vec<_>>().join("\n\n--- 前序步骤结果 ---\n\n");
        let prior_context: String = prior_context.chars().take(20_000).collect();
        let execution_prompt = format!("你负责执行 DKN Nexus 动态计划中的一个步骤。只处理当前步骤，不要扩大任务范围。\n\n用户总需求：\n{task}\n\n整体计划：\n{plan_summary}\n\n当前步骤：{title}\n步骤目标：\n{description}\n\n前序步骤结果：\n{}\n\n请用简体中文总结已完成工作、依据/涉及文件和未完成事项。", if prior_context.is_empty() { "（暂无）" } else { &prior_context });
        if provider == "codex" {
            let codex = codex_executable()?;
            let sandbox = if role == "coding" { "workspace-write" } else { "read-only" };
            let mut command = codex_exec_command_with_sandbox(&codex, &project, codex_model.as_deref(), execution_prompt, sandbox)?;
            let output = process_output(&mut command, &project, &task_id, &format!("步骤-{role}"), if role == "coding" { CODING_TIMEOUT } else { REVIEW_TIMEOUT })?;
            let model = model_label(&output, codex_model.as_deref(), "Codex");
            let result = ensure_success("Codex 步骤", &output)?;
            Ok(AgentStepResult { output: result, agent: "Codex".to_string(), model })
        } else {
            let (node, workbuddy) = workbuddy_command()?;
            let mut command = Command::new(&node);
            command.arg(&workbuddy).args(["--print", "--max-turns", "18", "--permission-mode", "acceptEdits", "--tools", "Read,Edit,Write,Glob,Grep", "--no-session-persistence"]);
            if let Some(model) = workbuddy_model.as_deref() { command.args(["--model", model]); }
            command.arg(execution_prompt);
            let output = process_output(&mut command, &project, &task_id, "步骤-coding", CODING_TIMEOUT)?;
            let model = model_label(&output, workbuddy_model.as_deref(), "WorkBuddy");
            let result = ensure_success("WorkBuddy 编码步骤", &output)?;
            Ok(AgentStepResult { output: result, agent: "WorkBuddy".to_string(), model })
        }
    }).await.map_err(|error| format!("Agent 执行工作线程异常：{error}"))?
}

#[tauri::command]
pub async fn run_agent_workflow(app: AppHandle, task_id: String, project_path: String, prompt: String, models: AgentModelSelection) -> Result<String, String> {
    let project = PathBuf::from(project_path.trim());
    let task = prompt.trim().to_string();
    if task.is_empty() { return Err("请先写下任务内容。".to_string()); }
    if !project.is_dir() { return Err("项目目录不存在，请重新选择。".to_string()); }
    let codex_model = selected_model(&models.codex, "Codex")?;
    let workbuddy_model = selected_model(&models.workbuddy, "WorkBuddy")?;
    tauri::async_runtime::spawn_blocking(move || {
        let codex = codex_executable()?;
        let (node, workbuddy) = workbuddy_command()?;

        emit_progress(&app, &task_id, "planning", "Codex", "", "正在读取项目并拆解任务", None);
        let plan_prompt = format!("你是本项目的技术策划。请只读检查项目结构和相关源码，为下面的需求写一份清晰的实施计划：列出涉及文件、步骤、边界情况和验收条件。不要修改文件、不要执行项目脚本。用简体中文回答，计划要足够具体，供另一个编码 Agent 执行。\n\n用户需求：\n{task}");
        let mut plan_command = codex_exec_command(&codex, &project, codex_model.as_deref(), plan_prompt)?;
        let plan_output = process_output(&mut plan_command, &project, &task_id, "策划", PLANNING_TIMEOUT)?;
        let planning_model = model_label(&plan_output, codex_model.as_deref(), "Codex");
        let plan = ensure_success("Codex 策划", &plan_output)?;
        emit_progress(&app, &task_id, "planning", "Codex", &planning_model, "策划完成，进入 WorkBuddy 编码", Some(plan.clone()));

        emit_progress(&app, &task_id, "coding", "WorkBuddy", "", "正在按计划修改所选项目", None);
        let coding_prompt = format!("你负责在当前项目中实现用户需求。先查看项目说明和相关文件，再按 Codex 计划执行。仅修改完成需求必要的项目文件，不要访问项目目录以外的文件，不要读取密钥或凭据。不要执行 shell 命令；完成后总结修改文件、实现要点、建议运行的验证命令及尚未验证事项。\n\n用户需求：\n{task}\n\nCodex 计划：\n{plan}");
        let mut coding_command = Command::new(&node);
        coding_command.arg(&workbuddy).args(["--print", "--max-turns", "18", "--permission-mode", "acceptEdits", "--tools", "Read,Edit,Write,Glob,Grep", "--no-session-persistence"]);
        if let Some(model) = workbuddy_model.as_deref() { coding_command.args(["--model", model]); }
        coding_command.arg(coding_prompt);
        let coding_output = process_output(&mut coding_command, &project, &task_id, "编码", CODING_TIMEOUT)?;
        let coding_model = model_label(&coding_output, workbuddy_model.as_deref(), "WorkBuddy");
        let coding = ensure_success("WorkBuddy 编码", &coding_output)?;
        emit_progress(&app, &task_id, "coding", "WorkBuddy", &coding_model, "编码阶段结束，开始 Codex 只读验收", Some(coding.clone()));

        emit_progress(&app, &task_id, "reviewing", "Codex", "", "正在只读检查变更和验收条件", None);
        let review_prompt = format!("你是独立的只读代码审查员。检查当前项目中与需求相关的改动，允许使用只读命令查看文件或 git diff，禁止修改文件、运行项目脚本或联网。对照需求与策划逐项检查正确性、回归风险和测试证据。只报告有证据支持的问题；若没有发现问题，明确写出未发现问题，并说明哪些验证尚未运行。\n\n用户需求：\n{task}\n\nCodex 计划：\n{plan}\n\nWorkBuddy 报告：\n{coding}");
        let mut review_command = codex_exec_command(&codex, &project, codex_model.as_deref(), review_prompt)?;
        let review_output = process_output(&mut review_command, &project, &task_id, "验收", REVIEW_TIMEOUT)?;
        let review_model = model_label(&review_output, codex_model.as_deref(), "Codex");
        let review = ensure_success("Codex 验收", &review_output)?;
        emit_progress(&app, &task_id, "completed", "Codex", &review_model, "三阶段流程完成", Some(review.clone()));
        Ok::<String, String>(review)
    }).await.map_err(|error| format!("Agent 工作线程异常：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_route_json_after_prose_and_fence() {
        let response = "匹配结果如下：```json\n{\"projectId\":null,\"newProjectName\":\"大括号 { 保留\",\"newProjectCategory\":\"开发\",\"reason\":\"新项目\"}\n```";
        let route = parse_project_route(response).expect("route JSON should parse");
        assert_eq!(route.new_project_name.as_deref(), Some("大括号 { 保留"));
        assert_eq!(route.new_project_category.as_deref(), Some("开发"));
    }

    #[test]
    fn parses_task_specific_plan_and_ignores_unknown_roles() {
        let response = r#"执行方案：```json
{"summary":"按需处理 {而不是固定三阶段}","steps":[{"title":"实现功能","description":"只修改必要代码","role":"coding"},{"title":"未来能力","description":"占位内容","role":"image"},{"title":"不支持项","description":"忽略","role":"arbitrary"}]}
```"#;
        let plan = parse_agent_plan(response).expect("valid dynamic plan should parse");
        assert_eq!(plan.summary, "按需处理 {而不是固定三阶段}");
        assert_eq!(plan.steps.len(), 2);
        assert_eq!(plan.steps[0].role, "coding");
        assert_eq!(plan.steps[1].role, "image");
    }

    #[test]
    fn codex_exec_arguments_do_not_include_unsupported_max_turns() {
        let command = codex_exec_command(Path::new("codex.exe"), Path::new("C:\\project"), None, "test".to_string()).expect("command should build");
        let arguments = command.get_args().map(|argument| argument.to_string_lossy()).collect::<Vec<_>>();
        assert!(!arguments.iter().any(|argument| argument == "--max-turns"));
        assert!(arguments.iter().any(|argument| argument == "--color"));
    }

    #[test]
    fn selected_codex_model_is_forwarded_as_a_separate_argument() {
        let command = codex_exec_command(Path::new("codex.exe"), Path::new("C:\\project"), Some("gpt-5.6"), "test".to_string()).expect("command should build");
        let arguments = command.get_args().map(|argument| argument.to_string_lossy()).collect::<Vec<_>>();
        let model_index = arguments.iter().position(|argument| argument == "--model").expect("model flag should exist");
        assert_eq!(arguments[model_index + 1], "gpt-5.6");
    }

    #[test]
    fn codex_sandbox_is_selected_per_step_role() {
        let coding = codex_exec_command_with_sandbox(Path::new("codex.exe"), Path::new("C:\\project"), None, "test".to_string(), "workspace-write").expect("coding command should build");
        let review = codex_exec_command_with_sandbox(Path::new("codex.exe"), Path::new("C:\\project"), None, "test".to_string(), "read-only").expect("review command should build");
        let coding_args = coding.get_args().map(|argument| argument.to_string_lossy()).collect::<Vec<_>>();
        let review_args = review.get_args().map(|argument| argument.to_string_lossy()).collect::<Vec<_>>();
        let coding_sandbox = coding_args.iter().position(|argument| argument == "--sandbox").expect("coding sandbox should exist");
        let review_sandbox = review_args.iter().position(|argument| argument == "--sandbox").expect("review sandbox should exist");
        assert_eq!(coding_args[coding_sandbox + 1], "workspace-write");
        assert_eq!(review_args[review_sandbox + 1], "read-only");
    }

    #[test]
    fn parses_workbuddy_model_catalog_from_cli_help() {
        let models = parse_workbuddy_models("--model <model> Currently supported: (auto, hy3, deepseek-v4.1-flash)");
        assert_eq!(models, vec!["auto", "hy3", "deepseek-v4.1-flash"]);
    }

    #[test]
    fn model_ids_accept_provider_namespaces_but_reject_argument_injection() {
        assert_eq!(selected_model(" custom-local:auto ", "WorkBuddy").expect("namespaced model should be accepted").as_deref(), Some("custom-local:auto"));
        assert!(selected_model("--help", "Codex").is_err());
        assert!(selected_model(&"x".repeat(101), "Codex").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn agent_process_times_out_and_is_terminated() {
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 8"]);
        let started = Instant::now();
        let error = process_output(&mut command, &env::temp_dir(), "timeout-test", "超时测试", Duration::from_secs(1)).expect_err("long process should time out");
        assert!(error.contains("已自动终止"));
        assert!(started.elapsed() < Duration::from_secs(8));
    }
}
