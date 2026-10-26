use base64::{engine::general_purpose::STANDARD, Engine};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_AUDIO_BYTES: usize = 32 * 1024 * 1024;
const TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const RESPONSE_PREFIX: &str = "DKN_ASR_RESULT:";

const PYTHON_WORKER: &str = r#"
import json
import sys

try:
    from faster_whisper import WhisperModel
    model = WhisperModel("small", device="cpu", compute_type="int8", local_files_only=True)
    segments, _ = model.transcribe(sys.argv[1], language="zh", vad_filter=True)
    text = "".join(segment.text for segment in segments).strip()
    print("DKN_ASR_RESULT:" + json.dumps({"text": text}, ensure_ascii=False), flush=True)
except Exception as error:
    print("DKN_ASR_RESULT:" + json.dumps({"error": type(error).__name__, "message": str(error)}, ensure_ascii=False), flush=True)
    sys.exit(2)
"#;

struct TemporaryAudio(PathBuf);

impl Drop for TemporaryAudio {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn python_executable() -> Result<PathBuf, String> {
    if let Some(value) = env::var_os("DKN_NEXUS_WHISPER_PYTHON").filter(|value| !value.is_empty()) {
        let configured = PathBuf::from(value);
        if configured.is_file() {
            return Ok(configured);
        }
        return Err("DKN_NEXUS_WHISPER_PYTHON 指向的 Python 文件不存在。".to_string());
    }

    let mut candidates = vec![PathBuf::from(
        r"D:\Agent\ai切片助手\live_clipper\.venv\Scripts\python.exe",
    )];
    if let Some(path) = env::var_os("PATH") {
        for directory in env::split_paths(&path) {
            candidates.push(directory.join("python.exe"));
            candidates.push(directory.join("python3.exe"));
        }
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| {
            "找不到本地 faster-whisper Python 环境。请安装切片助手的本地识别环境，或设置 DKN_NEXUS_WHISPER_PYTHON。".to_string()
        })
}

fn audio_extension(mime_type: Option<&str>) -> &'static str {
    match mime_type
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/mp4" | "audio/m4a" => "m4a",
        "audio/ogg" => "ogg",
        "audio/mpeg" | "audio/mp3" => "mp3",
        _ => "webm",
    }
}

fn transcribe_file(audio: &PathBuf) -> Result<String, String> {
    let python = python_executable()?;
    let mut command = Command::new(python);
    command
        .args(["-c", PYTHON_WORKER])
        .arg(audio)
        .env("PYTHONIOENCODING", "utf-8")
        .env("HF_HUB_OFFLINE", "1")
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let mut process_job = crate::child_process::ChildProcessJob::new();
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动本地语音识别环境：{error}"))?;
    let _job_assigned = process_job.assign(&child);
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() >= TRANSCRIPTION_TIMEOUT => {
                process_job.terminate(&mut child);
                return Err("本地语音转录超过 15 分钟，已停止处理。请缩短录音后重试。".to_string());
            }
            Ok(None) => thread::sleep(Duration::from_millis(120)),
            Err(error) => {
                process_job.terminate(&mut child);
                return Err(format!("等待本地语音转录时出错：{error}"));
            }
        }
    }

    // Closing the job also stops any helper that outlived Python and still
    // holds the redirected output pipe open.
    drop(process_job);
    let output = child
        .wait_with_output()
        .map_err(|error| format!("读取本地语音转录结果失败：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let response = stdout
        .lines()
        .rev()
        .find_map(|line| line.strip_prefix(RESPONSE_PREFIX))
        .ok_or_else(|| {
            let detail = String::from_utf8_lossy(&output.stderr);
            let detail = detail.trim();
            if detail.is_empty() {
                "本地语音识别没有返回结果。请确认 faster-whisper 已安装。".to_string()
            } else {
                format!("本地语音识别启动失败：{}", detail.chars().take(700).collect::<String>())
            }
        })?;
    let payload: serde_json::Value = serde_json::from_str(response)
        .map_err(|_| "本地语音识别返回了无法读取的结果。".to_string())?;
    if let Some(error) = payload.get("error").and_then(serde_json::Value::as_str) {
        let message = payload
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if error.contains("EntryNotFound") || error.contains("LocalEntryNotFound") {
            return Err("本机没有找到 faster-whisper small 模型缓存。请先在切片助手中完成一次本地语音识别。".to_string());
        }
        if error == "ModuleNotFoundError" {
            return Err("当前 Python 环境没有安装 faster-whisper。请检查切片助手的本地识别环境。".to_string());
        }
        return Err(format!("本地语音识别失败：{error}{}", if message.is_empty() { String::new() } else { format!("：{message}") }));
    }
    if !output.status.success() {
        return Err("本地语音识别进程异常退出。".to_string());
    }
    payload
        .get("text")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "本地语音识别没有生成文字。".to_string())
}

fn transcribe_audio(audio_base64: String, mime_type: Option<String>) -> Result<String, String> {
    if audio_base64.len() > (MAX_AUDIO_BYTES * 4 / 3) + 16 {
        return Err("录音超过 32 MB，请缩短录音后重试。".to_string());
    }
    let audio = STANDARD
        .decode(audio_base64)
        .map_err(|_| "录音数据无法读取，请重新录制。".to_string())?;
    if audio.is_empty() {
        return Err("录音为空，请重新录制。".to_string());
    }
    if audio.len() > MAX_AUDIO_BYTES {
        return Err("录音超过 32 MB，请缩短录音后重试。".to_string());
    }

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = env::temp_dir().join(format!(
        "dkn-nexus-asr-{}-{nonce}.{}",
        std::process::id(),
        audio_extension(mime_type.as_deref())
    ));
    fs::write(&path, audio).map_err(|error| format!("无法保存临时录音：{error}"))?;
    let temp = TemporaryAudio(path);
    transcribe_file(&temp.0)
}

#[tauri::command]
pub async fn transcribe_local_audio(
    audio_base64: String,
    audio_mime_type: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || transcribe_audio(audio_base64, audio_mime_type))
        .await
        .map_err(|error| format!("本地语音任务没有完成：{error}"))?
}
