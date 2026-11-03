use super::*;
pub fn permission_mode_from_str(value: &str) -> PermissionMode {
    match value {
        "per_tool" => PermissionMode::PerTool,
        "developer" => PermissionMode::Developer,
        _ => PermissionMode::Conservative,
    }
}

pub fn permission_mode_to_str(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Conservative => "conservative",
        PermissionMode::PerTool => "per_tool",
        PermissionMode::Developer => "developer",
    }
}

pub fn agent_ai_config_from_settings(settings: &Value) -> Result<AgentAiConfig, String> {
    if !settings
        .get("aiUseForAgent")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err("AI model is not enabled for Agent".to_string());
    }

    let provider = settings_string(settings, "aiProvider");
    if provider == "disabled" || provider.is_empty() {
        return Err("AI provider is disabled for Agent".to_string());
    }
    if !matches!(provider.as_str(), "openai" | "compatible" | "local") {
        return Err(format!("Unsupported AI provider for Agent: {provider}"));
    }

    let base_url = settings_string(settings, "aiBaseUrl");
    if base_url.is_empty() {
        return Err("AI Base URL is required for Agent".to_string());
    }
    let model = settings_string(settings, "aiDefaultModel");
    if model.is_empty() {
        return Err("AI default model is required for Agent".to_string());
    }
    let api_key = settings_string(settings, "aiApiKey");
    if provider != "local" && api_key.is_empty() {
        return Err("AI API key is required for Agent".to_string());
    }
    let temperature = settings
        .get("aiTemperature")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && (0.0..=2.0).contains(value))
        .unwrap_or(0.2);

    Ok(AgentAiConfig {
        provider,
        base_url,
        model,
        api_key,
        temperature,
    })
}

pub(super) fn agent_ai_config_from_db(db: &Database) -> Result<AgentAiConfig, String> {
    let value = db
        .get_setting("settings-general")
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "AI settings are not saved yet".to_string())?;
    let settings = serde_json::from_str::<Value>(&value)
        .map_err(|e| format!("Failed to parse AI settings: {e}"))?;
    agent_ai_config_from_settings(&settings)
}

pub async fn ask_ai_model(db: &Database, arguments: Value) -> Result<Value, String> {
    let started = Instant::now();
    let config = agent_ai_config_from_db(db)?;
    let prompt = arguments
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Missing prompt".to_string())?;
    let system = arguments
        .get("system")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let max_tokens = arguments
        .get("max_tokens")
        .and_then(Value::as_u64)
        .map(|value| value.clamp(1, 32_768));

    let mut messages = Vec::new();
    if let Some(system) = system {
        messages.push(json!({ "role": "system", "content": system }));
    }
    messages.push(json!({ "role": "user", "content": prompt }));

    let mut payload = json!({
        "model": config.model.clone(),
        "messages": messages,
        "temperature": config.temperature,
        "stream": false
    });
    if let Some(max_tokens) = max_tokens {
        payload["max_tokens"] = json!(max_tokens);
    }

    let url = ai_chat_completions_url(&config.base_url)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|error| format!("Failed to create Agent AI client: {error}"))?;
    let mut request = client.post(&url).json(&payload);
    if !config.api_key.trim().is_empty() {
        request = request.bearer_auth(config.api_key.trim());
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Agent AI request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "Agent AI request failed: HTTP {}{}",
            status.as_u16(),
            if body.trim().is_empty() {
                String::new()
            } else {
                format!(" {}", truncate_for_error(body.trim(), 240))
            }
        ));
    }
    let response_json = response
        .json::<Value>()
        .await
        .map_err(|error| format!("Agent AI response JSON failed: {error}"))?;
    let text = response_json
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| {
            choice
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(Value::as_str)
                .or_else(|| choice.get("text").and_then(Value::as_str))
        })
        .ok_or_else(|| "Agent AI response did not contain assistant text".to_string())?;
    let finish_reason = response_json
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("finish_reason"))
        .cloned()
        .unwrap_or(Value::Null);
    let usage = response_json.get("usage").cloned().unwrap_or(Value::Null);

    Ok(json!({
        "status": "ok",
        "provider": config.provider,
        "model": config.model,
        "text": text,
        "finish_reason": finish_reason,
        "usage": usage,
        "duration_ms": started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
    }))
}

pub(super) fn ai_chat_completions_url(base_url: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(base_url.trim())
        .map_err(|error| format!("Invalid AI URL for Agent: {error}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("AI Base URL for Agent must use http or https".to_string());
    }
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "AI Base URL cannot be used as an Agent base path".to_string())?;
        segments.pop_if_empty();
        segments.push("chat");
        segments.push("completions");
    }
    Ok(url.to_string())
}

pub(super) fn settings_string(settings: &Value, key: &str) -> String {
    settings
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

pub(super) fn truncate_for_error(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        value.to_string()
    } else {
        format!("{}...", value.chars().take(limit).collect::<String>())
    }
}

pub(super) async fn search_clipboard(
    app: &AppHandle,
    db: &Database,
    arguments: Value,
) -> Result<Value, String> {
    let text = app.clipboard().read_text().ok();
    if text
        .as_deref()
        .map(str::trim)
        .is_some_and(|text| !text.is_empty())
    {
        let cutoff = atools_core::utils::iso_days_ago(clipboard_retention_days(db));
        let _ = db.prune_clipboard_history(&cutoff);
    }
    search_clipboard_history(db, text.as_deref(), arguments)
}
