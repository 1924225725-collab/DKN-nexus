use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TextApiCredential {
    base_url: String,
    api_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTextStepResult {
    output: String,
    agent: String,
    model: String,
    usage: TextUsage,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct TextUsage {
    input_tokens: u64,
    output_tokens: u64,
}

fn secret_name(provider_id: &str) -> Result<String, String> {
    if provider_id.len() != 32 || !provider_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("自定义文本服务 ID 无效。".into());
    }
    Ok(format!("agent-text-{}", provider_id.to_ascii_lowercase()))
}

fn validate_key(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 4096 || !value.is_ascii() || value.contains('\r') || value.contains('\n') {
        return Err("API Key 无效；请重新输入不含换行的 ASCII 密钥。".into());
    }
    Ok(())
}

fn chat_endpoint(base_url: &str) -> Result<super::agent_image::ParsedEndpoint, String> {
    let base_url = base_url.trim().trim_end_matches('/');
    if base_url.is_empty() || base_url.contains(['?', '#']) {
        return Err("请填写不含查询参数或片段的 OpenAI 兼容 API Base URL。".into());
    }
    let endpoint = if base_url.ends_with("/chat/completions") {
        base_url.to_string()
    } else {
        format!("{base_url}/chat/completions")
    };
    super::agent_image::parse_endpoint(&endpoint)
}

fn parse_response(status: u32, body: &[u8], api_key: &str, model: &str, service_name: &str) -> Result<AgentTextStepResult, String> {
    let value: Value = serde_json::from_slice(body).map_err(|_| "文本 API 返回的内容不是有效 JSON。".to_string())?;
    if !(200..300).contains(&status) {
        let detail = value.pointer("/error/message").and_then(Value::as_str)
            .or_else(|| value.get("message").and_then(Value::as_str))
            .unwrap_or("服务未返回具体错误信息");
        let safe_detail = detail.replace(api_key, "[密钥已隐藏]").chars().take(600).collect::<String>();
        return Err(format!("文本 API 返回 HTTP {status}：{safe_detail}"));
    }
    let content = value.pointer("/choices/0/message/content").and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| value.pointer("/choices/0/message/content").and_then(Value::as_array).map(|parts| {
            parts.iter().filter_map(|part| part.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("")
        }))
        .filter(|content| !content.trim().is_empty())
        .ok_or_else(|| "文本 API 响应缺少 choices[0].message.content。".to_string())?;
    let usage = value.get("usage");
    Ok(AgentTextStepResult {
        output: content,
        agent: service_name.to_string(),
        model: value.pointer("/model").and_then(Value::as_str).unwrap_or(model).to_string(),
        usage: TextUsage {
            input_tokens: usage.and_then(|item| item.get("prompt_tokens")).and_then(Value::as_u64).unwrap_or(0),
            output_tokens: usage.and_then(|item| item.get("completion_tokens")).and_then(Value::as_u64).unwrap_or(0),
        },
    })
}

#[tauri::command]
pub fn save_agent_text_secret(provider_id: String, base_url: String, value: String) -> Result<(), String> {
    let name = secret_name(&provider_id)?;
    let base_url = base_url.trim().trim_end_matches('/').to_string();
    chat_endpoint(&base_url)?;
    let api_key = value.trim();
    validate_key(api_key)?;
    let credential = TextApiCredential { base_url, api_key: api_key.to_string() };
    let serialized = serde_json::to_string(&credential).map_err(|_| "API Key 无法安全编码。".to_string())?;
    #[cfg(windows)] { return super::secure_store::save(&name, &serialized); }
    #[cfg(not(windows))] { let _ = (name, serialized); Err("自定义文本 API 的安全存储目前仅支持 Windows。".into()) }
}

#[tauri::command]
pub fn has_agent_text_secret(provider_id: String) -> Result<bool, String> {
    let name = secret_name(&provider_id)?;
    #[cfg(windows)] {
        return Ok(super::secure_store::load(&name).ok()
            .and_then(|value| serde_json::from_str::<TextApiCredential>(&value).ok())
            .is_some_and(|credential| !credential.api_key.is_empty()));
    }
    #[cfg(not(windows))] { let _ = name; Ok(false) }
}

#[tauri::command]
pub fn delete_agent_text_secret(provider_id: String) -> Result<(), String> {
    let name = secret_name(&provider_id)?;
    #[cfg(windows)] { return super::secure_store::delete(&name); }
    #[cfg(not(windows))] { let _ = name; Err("自定义文本 API 的安全存储目前仅支持 Windows。".into()) }
}

#[tauri::command]
pub async fn execute_agent_text_step(provider_id: String, service_name: String, base_url: String, model: String, prompt: String) -> Result<AgentTextStepResult, String> {
    let model = model.trim().to_string();
    let service_name = service_name.trim().to_string();
    let prompt = prompt.trim().to_string();
    if model.is_empty() || model.len() > 160 || service_name.is_empty() || service_name.len() > 80 || prompt.is_empty() || prompt.chars().count() > 30_000 {
        return Err("模型名称、服务名称或文本内容无效。".into());
    }
    let base_url = base_url.trim().trim_end_matches('/').to_string();
    let endpoint = chat_endpoint(&base_url)?;
    let name = secret_name(&provider_id)?;
    #[cfg(windows)] {
        let credential: TextApiCredential = serde_json::from_str(&super::secure_store::load(&name)?)
            .map_err(|_| "自定义文本服务密钥记录无效，请在 Agent → 模型 / API 中重新保存。".to_string())?;
        if credential.base_url != base_url {
            return Err("API Base URL 已变化；请重新保存与该地址对应的 API Key。".into());
        }
        validate_key(&credential.api_key)?;
        let request_body = json!({
            "model": model,
            "messages": [
                { "role": "system", "content": "你是 DKN Nexus 项目工作流中的文本分析或方案复核 Agent。严格按给定步骤完成，只输出与任务相关的简体中文内容。你没有读取或修改本地项目文件的能力，不要声称已经执行了本地操作。" },
                { "role": "user", "content": prompt }
            ],
            "stream": false
        });
        let request_bytes = serde_json::to_vec(&request_body).map_err(|_| "无法构建文本 API 请求。".to_string())?;
        let key_for_error_redaction = credential.api_key.clone();
        let key = credential.api_key;
        let service_label = service_name.clone();
        let (status, body) = tauri::async_runtime::spawn_blocking(move || super::agent_image::winhttp::post_with_limit(&endpoint, &key, &request_bytes, 4 * 1024 * 1024, &service_label))
            .await.map_err(|error| format!("文本 API 工作线程失败：{error}"))??;
        parse_response(status, &body, &key_for_error_redaction, &model, &service_name)
    }
    #[cfg(not(windows))]
    { let _ = (name, endpoint, service_name, model, prompt); Err("自定义文本 API 的安全原生传输目前仅支持 Windows。".into()) }
}
