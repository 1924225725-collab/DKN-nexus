use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedImageResult {
    model: String,
    image_path: Option<String>,
    image_url: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageApiCredential {
    endpoint_url: String,
    api_key: String,
}

pub(crate) struct ParsedEndpoint {
    host: String,
    port: u16,
    path: String,
    secure: bool,
}

pub(crate) fn parse_endpoint(value: &str) -> Result<ParsedEndpoint, String> {
    let value = value.trim();
    let (secure, rest) = if let Some(rest) = value.strip_prefix("https://") {
        (true, rest)
    } else if let Some(rest) = value.strip_prefix("http://") {
        (false, rest)
    } else {
        return Err("API 地址必须使用 HTTPS；仅 localhost / 127.0.0.1 允许 HTTP。".into());
    };
    if value.contains('#') || value.bytes().any(|byte| byte.is_ascii_whitespace()) {
        return Err("API 地址不能包含空白字符或片段标记。".into());
    }
    let boundary = rest.find(['/', '?']).unwrap_or(rest.len());
    let authority = &rest[..boundary];
    if authority.is_empty() || authority.contains('@') {
        return Err("API 地址的主机名无效。".into());
    }
    let (host, port) = if let Some(bracketed) = authority.strip_prefix('[') {
        let close = bracketed.find(']').ok_or_else(|| "IPv6 主机地址格式无效。".to_string())?;
        let host = &bracketed[..close];
        let suffix = &bracketed[close + 1..];
        let port = if suffix.is_empty() { if secure { 443 } else { 80 } }
            else { suffix.strip_prefix(':').ok_or_else(|| "端口格式无效。".to_string())?.parse::<u16>().map_err(|_| "端口格式无效。".to_string())? };
        (host.to_string(), port)
    } else if let Some((host, port)) = authority.rsplit_once(':') {
        if host.contains(':') { return Err("IPv6 主机地址请使用方括号括起。".into()); }
        (host.to_string(), port.parse::<u16>().map_err(|_| "端口格式无效。".to_string())?)
    } else {
        (authority.to_string(), if secure { 443 } else { 80 })
    };
    if host.is_empty() || port == 0 { return Err("图片 API 主机名或端口无效。".into()); }
    if !secure && !matches!(host.to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "::1") {
        return Err("出于密钥安全考虑，HTTP 只允许 localhost / 127.0.0.1；远程服务必须使用 HTTPS。".into());
    }
    let suffix = &rest[boundary..];
    let path = if suffix.is_empty() { "/".to_string() }
        else if suffix.starts_with('?') { format!("/{suffix}") }
        else { suffix.to_string() };
    Ok(ParsedEndpoint { host, port, path, secure })
}

fn secret_name(provider_id: &str) -> Result<String, String> {
    if provider_id.len() != 32 || !provider_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("图片服务 ID 无效。".into());
    }
    Ok(format!("agent-image-{}", provider_id.to_ascii_lowercase()))
}

fn validate_api_key(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 4096 || value.contains('\r') || value.contains('\n') || !value.is_ascii() {
        return Err("图片 API Key 无效；请重新输入一个 ASCII 格式的 API Key。".into());
    }
    Ok(())
}

fn image_root() -> Result<PathBuf, String> {
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).ok_or_else(|| "找不到当前用户的 LOCALAPPDATA 目录。".to_string())?;
    Ok(local.join("DKN Nexus").join("generated-images"))
}

fn persist_image(bytes: &[u8], mime: &str) -> Result<String, String> {
    if bytes.is_empty() || bytes.len() > 25 * 1024 * 1024 { return Err("生成图片为空或超过 25 MiB，本次结果未保存。".into()); }
    let extension = match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => return Err("图片服务返回了不支持的格式；仅支持 PNG、JPEG、WebP。".into()),
    };
    let root = image_root()?;
    std::fs::create_dir_all(&root).map_err(|error| format!("无法创建本机图片目录：{error}"))?;
    static NEXT_FILE: AtomicU64 = AtomicU64::new(0);
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    for _ in 0..5 {
        let suffix = NEXT_FILE.fetch_add(1, Ordering::Relaxed);
        let path = root.join(format!("agent-{stamp}-{}-{suffix}.{extension}", std::process::id()));
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                use std::io::Write;
                file.write_all(bytes).map_err(|error| format!("图片文件写入失败：{error}"))?;
                return Ok(path.to_string_lossy().into_owned());
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("无法创建本机图片文件：{error}")),
        }
    }
    Err("无法为生成图片分配唯一文件名。".into())
}

fn parse_response(status: u32, body: &[u8], key: &str, model: &str) -> Result<GeneratedImageResult, String> {
    let value: Value = serde_json::from_slice(body).map_err(|_| "图片服务返回的内容不是有效 JSON。".to_string())?;
    if !(200..300).contains(&status) {
        let detail = value.pointer("/error/message").and_then(Value::as_str)
            .or_else(|| value.get("message").and_then(Value::as_str))
            .unwrap_or("服务未返回具体错误信息");
        let safe_detail = detail.replace(key, "[密钥已隐藏]").chars().take(600).collect::<String>();
        return Err(format!("图片 API 返回 HTTP {status}：{safe_detail}"));
    }
    let item = value.pointer("/data/0").ok_or_else(|| "图片 API 响应缺少 data[0]。".to_string())?;
    if let Some(encoded) = item.get("b64_json").and_then(Value::as_str) {
        let (mime, encoded) = if let Some(data_url) = encoded.strip_prefix("data:") {
            let (header, data) = data_url.split_once(',').ok_or_else(|| "图片 API 返回的数据 URL 格式无效。".to_string())?;
            let mime = header.split(';').next().unwrap_or("");
            (mime, data)
        } else {
            (item.get("mime_type").and_then(Value::as_str).unwrap_or("image/png"), encoded)
        };
        let bytes = STANDARD.decode(encoded).map_err(|_| "图片 API 返回的 Base64 图片无法解码。".to_string())?;
        let image_path = persist_image(&bytes, mime)?;
        return Ok(GeneratedImageResult { model: model.to_string(), image_path: Some(image_path), image_url: None });
    }
    if let Some(url) = item.get("url").and_then(Value::as_str) {
        let parsed = parse_endpoint(url)?;
        if !parsed.secure { return Err("图片服务返回了不安全的 HTTP 图片链接，已拒绝显示。".into()); }
        return Ok(GeneratedImageResult { model: model.to_string(), image_path: None, image_url: Some(url.to_string()) });
    }
    Err("图片 API 响应中没有可识别的 b64_json 或 url 字段。".into())
}

#[cfg(windows)]
pub(crate) mod winhttp {
    use super::ParsedEndpoint;
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};

    type Handle = *mut c_void;
    const WINHTTP_ACCESS_TYPE_DEFAULT_PROXY: u32 = 0;
    const WINHTTP_FLAG_SECURE: u32 = 0x0080_0000;
    const WINHTTP_QUERY_STATUS_CODE: u32 = 19;
    const WINHTTP_QUERY_FLAG_NUMBER: u32 = 0x2000_0000;

    #[link(name = "winhttp")]
    unsafe extern "system" {
        fn WinHttpOpen(agent: *const u16, access: u32, proxy: *const u16, bypass: *const u16, flags: u32) -> Handle;
        fn WinHttpConnect(session: Handle, server: *const u16, port: u16, reserved: u32) -> Handle;
        fn WinHttpOpenRequest(connection: Handle, verb: *const u16, object: *const u16, version: *const u16, referrer: *const u16, accept_types: *const *const u16, flags: u32) -> Handle;
        fn WinHttpSetTimeouts(handle: Handle, resolve: i32, connect: i32, send: i32, receive: i32) -> i32;
        fn WinHttpSendRequest(request: Handle, headers: *const u16, header_length: u32, optional: *mut c_void, optional_length: u32, total_length: u32, context: usize) -> i32;
        fn WinHttpReceiveResponse(request: Handle, reserved: *mut c_void) -> i32;
        fn WinHttpQueryHeaders(request: Handle, level: u32, name: *const u16, buffer: *mut c_void, buffer_length: *mut u32, index: *mut u32) -> i32;
        fn WinHttpQueryDataAvailable(request: Handle, available: *mut u32) -> i32;
        fn WinHttpReadData(request: Handle, buffer: *mut c_void, bytes_to_read: u32, bytes_read: *mut u32) -> i32;
        fn WinHttpCloseHandle(handle: Handle) -> i32;
    }

    fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(std::iter::once(0)).collect() }

    pub fn post(endpoint: &ParsedEndpoint, key: &str, body: &[u8]) -> Result<(u32, Vec<u8>), String> {
        post_with_limit(endpoint, key, body, 35 * 1024 * 1024, "图片 API")
    }

    pub fn post_with_limit(endpoint: &ParsedEndpoint, key: &str, body: &[u8], response_limit: usize, service_label: &str) -> Result<(u32, Vec<u8>), String> {
        let agent = wide(concat!("DKN Nexus/", env!("CARGO_PKG_VERSION")));
        let host = wide(&endpoint.host);
        let path = wide(&endpoint.path);
        let post = wide("POST");
        let headers = wide(&format!("Content-Type: application/json\r\nAuthorization: Bearer {key}\r\n"));
        unsafe {
            let session = WinHttpOpen(agent.as_ptr(), WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, null(), null(), 0);
            if session.is_null() { return Err(format!("Windows HTTPS 会话初始化失败：{}", std::io::Error::last_os_error())); }
            let outcome = (|| {
                if WinHttpSetTimeouts(session, 15_000, 15_000, 30_000, 120_000) == 0 { return Err(format!("无法设置 {service_label} 网络超时。")); }
                let connection = WinHttpConnect(session, host.as_ptr(), endpoint.port, 0);
                if connection.is_null() { return Err(format!("连接 {service_label} 主机失败：{}", std::io::Error::last_os_error())); }
                let request = WinHttpOpenRequest(connection, post.as_ptr(), path.as_ptr(), null(), null(), null(), if endpoint.secure { WINHTTP_FLAG_SECURE } else { 0 });
                if request.is_null() {
                    let error = format!("创建 {service_label} 请求失败：{}", std::io::Error::last_os_error());
                    WinHttpCloseHandle(connection);
                    return Err(error);
                }
                let sent = WinHttpSendRequest(request, headers.as_ptr(), u32::MAX, body.as_ptr() as *mut c_void, body.len() as u32, body.len() as u32, 0);
                if sent == 0 || WinHttpReceiveResponse(request, null_mut()) == 0 {
                    let error = format!("{service_label} 网络请求失败：{}", std::io::Error::last_os_error());
                    WinHttpCloseHandle(request); WinHttpCloseHandle(connection);
                    return Err(error);
                }
                let mut status = 0u32;
                let mut status_size = std::mem::size_of::<u32>() as u32;
                if WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, null(), &mut status as *mut u32 as *mut c_void, &mut status_size, null_mut()) == 0 {
                    let error = format!("无法读取 {service_label} HTTP 状态：{}", std::io::Error::last_os_error());
                    WinHttpCloseHandle(request); WinHttpCloseHandle(connection);
                    return Err(error);
                }
                let mut response = Vec::new();
                loop {
                    let mut available = 0u32;
                    if WinHttpQueryDataAvailable(request, &mut available) == 0 {
                        let error = format!("读取 {service_label} 响应失败：{}", std::io::Error::last_os_error());
                        WinHttpCloseHandle(request); WinHttpCloseHandle(connection);
                        return Err(error);
                    }
                    if available == 0 { break; }
                    if response.len().saturating_add(available as usize) > response_limit {
                        WinHttpCloseHandle(request); WinHttpCloseHandle(connection);
                        return Err(format!("{service_label} 响应超过 {} MiB，已停止读取。", response_limit / (1024 * 1024)));
                    }
                    let mut chunk = vec![0u8; available as usize];
                    let mut read = 0u32;
                    if WinHttpReadData(request, chunk.as_mut_ptr() as *mut c_void, available, &mut read) == 0 {
                        let error = format!("读取 {service_label} 响应内容失败：{}", std::io::Error::last_os_error());
                        WinHttpCloseHandle(request); WinHttpCloseHandle(connection);
                        return Err(error);
                    }
                    chunk.truncate(read as usize); response.extend_from_slice(&chunk);
                }
                WinHttpCloseHandle(request); WinHttpCloseHandle(connection);
                Ok((status, response))
            })();
            WinHttpCloseHandle(session);
            outcome
        }
    }
}

#[tauri::command]
pub fn save_agent_image_secret(provider_id: String, endpoint_url: String, value: String) -> Result<(), String> {
    let name = secret_name(&provider_id)?;
    let endpoint_url = endpoint_url.trim().to_string();
    parse_endpoint(&endpoint_url)?;
    let value = value.trim();
    validate_api_key(value)?;
    let credential = ImageApiCredential { endpoint_url, api_key: value.to_string() };
    let serialized = serde_json::to_string(&credential).map_err(|_| "图片服务密钥无法安全编码。".to_string())?;
    #[cfg(windows)] { return super::secure_store::save(&name, &serialized); }
    #[cfg(not(windows))] { let _ = (name, serialized); Err("图片 API 密钥安全存储目前仅支持 Windows。".into()) }
}

#[tauri::command]
pub fn has_agent_image_secret(provider_id: String) -> Result<bool, String> {
    let name = secret_name(&provider_id)?;
    #[cfg(windows)] {
        return Ok(super::secure_store::load(&name).ok()
            .and_then(|value| serde_json::from_str::<ImageApiCredential>(&value).ok())
            .is_some_and(|credential| !credential.api_key.is_empty()));
    }
    #[cfg(not(windows))] { let _ = name; Ok(false) }
}

#[tauri::command]
pub async fn generate_agent_image(provider_id: String, model: String, size: String, prompt: String) -> Result<GeneratedImageResult, String> {
    let model = model.trim().to_string();
    let prompt = prompt.trim().to_string();
    let size = size.trim().to_string();
    if model.is_empty() || model.len() > 160 || prompt.is_empty() || prompt.chars().count() > 6000 || size.len() > 80 {
        return Err("图片模型、提示内容或尺寸无效。".into());
    }
    let name = secret_name(&provider_id)?;
    #[cfg(windows)]
    {
        let credential: ImageApiCredential = serde_json::from_str(&super::secure_store::load(&name)?)
            .map_err(|_| "图片服务密钥记录无效；请在 Agent → 模型 / API 管理中重新保存。".to_string())?;
        validate_api_key(&credential.api_key)?;
        let endpoint = parse_endpoint(&credential.endpoint_url)?;
        let request_body = json!({ "model": model, "prompt": prompt, "n": 1, "size": if size.is_empty() { "1024x1024".to_string() } else { size } });
        let request_bytes = serde_json::to_vec(&request_body).map_err(|_| "无法构建图片 API 请求。".to_string())?;
        let key_for_error_redaction = credential.api_key.clone();
        let key = credential.api_key;
        let (status, body) = tauri::async_runtime::spawn_blocking(move || winhttp::post(&endpoint, &key, &request_bytes))
            .await.map_err(|error| format!("图片 API 工作线程失败：{error}"))??;
        parse_response(status, &body, &key_for_error_redaction, &model)
    }
    #[cfg(not(windows))]
    { let _ = name; Err("自定义图片 API 的安全原生传输目前仅支持 Windows。".into()) }
}

#[tauri::command]
pub fn read_agent_image(image_path: String) -> Result<String, String> {
    let root = image_root()?;
    let canonical_root = root.canonicalize().map_err(|_| "本机生成图片目录不存在。".to_string())?;
    let path = Path::new(image_path.trim()).canonicalize().map_err(|_| "生成图片文件不存在或无法读取。".to_string())?;
    if !path.starts_with(&canonical_root) { return Err("为保护本地文件，预览只允许读取 Nexus 生成图片目录中的文件。".into()); }
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    let mime = match extension.as_str() { "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "webp" => "image/webp", _ => return Err("生成图片文件类型无效。".into()) };
    let metadata = std::fs::metadata(&path).map_err(|error| format!("读取图片文件信息失败：{error}"))?;
    if metadata.len() == 0 || metadata.len() > 25 * 1024 * 1024 { return Err("图片预览文件为空或超过 25 MiB。".into()); }
    let bytes = std::fs::read(path).map_err(|error| format!("读取图片预览失败：{error}"))?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[tauri::command]
pub fn read_project_image(project_path: String, image_path: String) -> Result<String, String> {
    let project = Path::new(project_path.trim()).canonicalize().map_err(|_| "项目目录不存在。".to_string())?;
    if !project.is_dir() { return Err("项目目录不存在。".to_string()); }
    let path = Path::new(image_path.trim()).canonicalize().map_err(|_| "项目图片文件不存在或无法读取。".to_string())?;
    if !path.starts_with(&project) { return Err("为保护本地文件，预览只允许读取当前项目目录中的图片。".into()); }
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    let mime = match extension.as_str() { "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "webp" => "image/webp", "gif" => "image/gif", "svg" => "image/svg+xml", _ => return Err("项目图片格式无效。".to_string()) };
    let metadata = std::fs::metadata(&path).map_err(|error| format!("读取项目图片信息失败：{error}"))?;
    if metadata.len() == 0 || metadata.len() > 25 * 1024 * 1024 { return Err("项目图片为空或超过 25 MiB。".to_string()); }
    let bytes = std::fs::read(path).map_err(|error| format!("读取项目图片预览失败：{error}"))?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::{parse_endpoint, parse_response, secret_name};
    use serde_json::json;

    #[test]
    fn image_endpoint_requires_tls_except_loopback() {
        assert!(parse_endpoint("https://images.example/v1/generations").is_ok());
        assert!(parse_endpoint("http://127.0.0.1:8080/v1/images/generations").is_ok());
        assert!(parse_endpoint("http://images.example/v1/generations").is_err());
        assert!(parse_endpoint("https://user:pass@images.example/v1/generations").is_err());
    }

    #[test]
    fn image_secret_names_are_bounded_and_scoped() {
        assert_eq!(secret_name("0123456789abcdef0123456789abcdef").unwrap(), "agent-image-0123456789abcdef0123456789abcdef");
        assert!(secret_name("../../secret").is_err());
    }

    #[test]
    fn image_response_accepts_https_url_and_redacts_api_keys() {
        let body = serde_json::to_vec(&json!({ "data": [{ "url": "https://cdn.example.test/image.png" }] })).unwrap();
        let result = parse_response(200, &body, "test-secret", "sample-model").unwrap();
        assert_eq!(result.image_url.as_deref(), Some("https://cdn.example.test/image.png"));
        assert_eq!(result.model, "sample-model");

        let error_body = serde_json::to_vec(&json!({ "error": { "message": "rejected test-secret token" } })).unwrap();
        let error = parse_response(401, &error_body, "test-secret", "sample-model").unwrap_err();
        assert!(error.contains("[密钥已隐藏]"));
        assert!(!error.contains("test-secret"));
    }
}
