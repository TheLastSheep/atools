use super::contract::{AiContent, AiDelta, AiErrorCode, AiModel, AiPart, AiRequest, AiServiceError};

pub const AI_LIMITS: AiLimits = AiLimits {
    messages: 64,
    text_part_bytes: 32 * 1024,
    total_text_bytes: 256 * 1024,
    image_parts: 4,
    image_bytes_each: 1024 * 1024,
    image_bytes_total: 2 * 1024 * 1024,
    parts_per_message: 32,
    request_json_bytes: 3 * 1024 * 1024,
    model_count: 256,
    model_id_bytes: 256,
    model_directory_json_bytes: 64 * 1024,
    model_response_body_bytes: 1024 * 1024,
    collected_output_bytes: 1024 * 1024,
    delta_field_bytes: 16 * 1024,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AiLimits {
    pub messages: usize,
    pub text_part_bytes: usize,
    pub total_text_bytes: usize,
    pub image_parts: usize,
    pub image_bytes_each: usize,
    pub image_bytes_total: usize,
    pub parts_per_message: usize,
    pub request_json_bytes: usize,
    pub model_count: usize,
    pub model_id_bytes: usize,
    pub model_directory_json_bytes: usize,
    pub model_response_body_bytes: usize,
    pub collected_output_bytes: usize,
    pub delta_field_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequestBudget {
    pub message_count: usize,
    pub text_bytes: usize,
    pub image_count: usize,
    pub image_bytes: usize,
}

pub fn validate_request(request: &AiRequest) -> Result<RequestBudget, AiServiceError> {
    if request.messages.is_empty() || request.messages.len() > AI_LIMITS.messages {
        return Err(AiServiceError::new(AiErrorCode::InvalidRequest));
    }
    if request.model.as_deref().is_some_and(|model| !valid_model_id(model)) {
        return Err(AiServiceError::new(AiErrorCode::InvalidRequest));
    }

    let mut budget = RequestBudget { message_count: request.messages.len(), text_bytes: 0, image_count: 0, image_bytes: 0 };
    for message in &request.messages {
        if let Some(reasoning) = &message.reasoning_content {
            if message.role != super::contract::AiRole::Assistant {
                return Err(AiServiceError::new(AiErrorCode::InvalidRequest));
            }
            add_text(&mut budget, reasoning)?;
        }
        match &message.content {
            AiContent::Text(text) => add_text(&mut budget, text)?,
            AiContent::Parts(parts) => {
                if parts.is_empty() || parts.len() > AI_LIMITS.parts_per_message {
                    return Err(AiServiceError::new(AiErrorCode::InvalidRequest));
                }
                for part in parts {
                    match part {
                        AiPart::Text { text } => add_text(&mut budget, text)?,
                        AiPart::ImageUrl { image_url } => {
                            let bytes = image_data_uri_size(&image_url.url)?;
                            budget.image_count += 1;
                            budget.image_bytes = budget.image_bytes.saturating_add(bytes);
                            if budget.image_count > AI_LIMITS.image_parts
                                || bytes > AI_LIMITS.image_bytes_each
                                || budget.image_bytes > AI_LIMITS.image_bytes_total
                            {
                                return Err(AiServiceError::new(AiErrorCode::PayloadTooLarge));
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(budget)
}

fn add_text(budget: &mut RequestBudget, text: &str) -> Result<(), AiServiceError> {
    let bytes = text.len();
    if bytes > AI_LIMITS.text_part_bytes {
        return Err(AiServiceError::new(AiErrorCode::PayloadTooLarge));
    }
    budget.text_bytes = budget.text_bytes.saturating_add(bytes);
    if budget.text_bytes > AI_LIMITS.total_text_bytes {
        return Err(AiServiceError::new(AiErrorCode::PayloadTooLarge));
    }
    Ok(())
}

fn image_data_uri_size(value: &str) -> Result<usize, AiServiceError> {
    let (metadata, payload) = value.split_once(',')
        .ok_or_else(|| AiServiceError::new(AiErrorCode::UnsupportedContent))?;
    if !matches!(metadata, "data:image/png;base64" | "data:image/jpeg;base64" | "data:image/webp;base64") {
        return Err(AiServiceError::new(AiErrorCode::UnsupportedContent));
    }
    if payload.is_empty() || payload.len() % 4 != 0 {
        return Err(AiServiceError::new(AiErrorCode::UnsupportedContent));
    }
    let bytes = payload.as_bytes();
    let padding = if bytes.ends_with(b"==") { 2 } else if bytes.ends_with(b"=") { 1 } else { 0 };
    if bytes[..bytes.len() - padding].iter().any(|byte| !byte.is_ascii_alphanumeric() && *byte != b'+' && *byte != b'/')
        || bytes[bytes.len() - padding..].iter().any(|byte| *byte != b'=')
    {
        return Err(AiServiceError::new(AiErrorCode::UnsupportedContent));
    }
    if padding > 0 {
        let last = base64_value(bytes[bytes.len() - padding - 1])
            .ok_or_else(|| AiServiceError::new(AiErrorCode::UnsupportedContent))?;
        if (padding == 2 && last & 0x0f != 0) || (padding == 1 && last & 0x03 != 0) {
            return Err(AiServiceError::new(AiErrorCode::UnsupportedContent));
        }
    }
    Ok((bytes.len() / 4) * 3 - padding)
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

pub fn valid_model_id(model: &str) -> bool {
    !model.is_empty() && model.len() <= AI_LIMITS.model_id_bytes
        && !model.chars().any(char::is_control)
}

pub fn validate_delta(delta: &AiDelta) -> Result<(), AiServiceError> {
    if delta.content.as_ref().is_some_and(|value| value.len() > AI_LIMITS.delta_field_bytes)
        || delta.reasoning_content.as_ref().is_some_and(|value| value.len() > AI_LIMITS.delta_field_bytes)
    {
        return Err(AiServiceError::new(AiErrorCode::PayloadTooLarge));
    }
    if delta.content.as_deref().unwrap_or_default().is_empty()
        && delta.reasoning_content.as_deref().unwrap_or_default().is_empty()
    {
        return Err(AiServiceError::new(AiErrorCode::MalformedResponse));
    }
    let encoded = serde_json::to_vec(delta)
        .map_err(|_| AiServiceError::new(AiErrorCode::MalformedResponse))?;
    if encoded.len() > AI_LIMITS.delta_field_bytes {
        return Err(AiServiceError::new(AiErrorCode::PayloadTooLarge));
    }
    Ok(())
}

pub fn split_delta(delta: AiDelta) -> Result<Vec<AiDelta>, AiServiceError> {
    const ESCAPED_FIELD_BUDGET: usize = (AI_LIMITS.delta_field_bytes - 64) / 2;
    let content = escaped_chunks(delta.content, ESCAPED_FIELD_BUDGET);
    let reasoning = escaped_chunks(delta.reasoning_content, ESCAPED_FIELD_BUDGET);
    let count = content.len().max(reasoning.len());
    if count == 0 { return Err(AiServiceError::new(AiErrorCode::MalformedResponse)); }
    let mut output = Vec::with_capacity(count);
    for index in 0..count {
        let fragment = AiDelta {
            content: content.get(index).cloned(),
            reasoning_content: reasoning.get(index).cloned(),
        };
        validate_delta(&fragment)?;
        output.push(fragment);
    }
    Ok(output)
}

fn escaped_chunks(value: Option<String>, max_escaped_bytes: usize) -> Vec<String> {
    let Some(value) = value.filter(|value| !value.is_empty()) else { return Vec::new(); };
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut escaped_bytes = 0usize;
    for character in value.chars() {
        let size = json_character_bytes(character);
        if escaped_bytes > 0 && escaped_bytes + size > max_escaped_bytes {
            chunks.push(std::mem::take(&mut current));
            escaped_bytes = 0;
        }
        current.push(character);
        escaped_bytes += size;
    }
    if !current.is_empty() { chunks.push(current); }
    chunks
}

fn json_character_bytes(character: char) -> usize {
    match character {
        '"' | '\\' | '\u{08}' | '\u{09}' | '\u{0a}' | '\u{0c}' | '\u{0d}' => 2,
        '\u{00}'..='\u{1f}' => 6,
        _ => character.len_utf8(),
    }
}

pub fn validate_model_directory(models: &[AiModel]) -> Result<(), AiServiceError> {
    if models.len() > AI_LIMITS.model_count {
        return Err(AiServiceError::new(AiErrorCode::PayloadTooLarge));
    }
    let mut seen = std::collections::HashSet::with_capacity(models.len());
    for model in models {
        if !valid_model_id(&model.id) || model.value.is_empty() || model.label.is_empty()
            || model.value.len() > AI_LIMITS.model_id_bytes || model.label.len() > AI_LIMITS.model_id_bytes
            || model.value.chars().any(char::is_control) || model.label.chars().any(char::is_control)
            || !seen.insert(model.id.as_str())
        {
            return Err(AiServiceError::new(AiErrorCode::MalformedResponse));
        }
    }
    let encoded = serde_json::to_vec(models)
        .map_err(|_| AiServiceError::new(AiErrorCode::MalformedResponse))?;
    if encoded.len() > AI_LIMITS.model_directory_json_bytes {
        return Err(AiServiceError::new(AiErrorCode::PayloadTooLarge));
    }
    Ok(())
}
