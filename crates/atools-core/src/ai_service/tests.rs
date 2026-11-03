use super::*;
use serde_json::json;

fn text_request(text: &str) -> AiRequest {
    AiRequest { messages: vec![AiMessage { role: AiRole::User, content: AiContent::Text(text.to_string()), reasoning_content: None }], model: None }
}

#[test]
fn request_requires_messages_and_rejects_extra_fields_and_tool_roles() {
    assert!(serde_json::from_value::<AiRequest>(json!({"model":"m"})).is_err());
    assert!(serde_json::from_value::<AiRequest>(json!({"messages":[],"api_key":"secret"})).is_err());
    assert!(serde_json::from_value::<AiRequest>(json!({"messages":[{"role":"tool","content":"x"}]})).is_err());
}

#[test]
fn request_enforces_message_part_and_utf8_budgets() {
    let exact = text_request(&"x".repeat(AI_LIMITS.text_part_bytes));
    assert_eq!(validate_request(&exact).unwrap().text_bytes, AI_LIMITS.text_part_bytes);
    assert_eq!(validate_request(&text_request(&"x".repeat(AI_LIMITS.text_part_bytes + 1))).unwrap_err().code, AiErrorCode::PayloadTooLarge);
    let many = AiRequest { messages: (0..9).map(|_| AiMessage { role: AiRole::User, content: AiContent::Text("x".repeat(AI_LIMITS.text_part_bytes)), reasoning_content: None }).collect(), model: None };
    assert_eq!(validate_request(&many).unwrap_err().code, AiErrorCode::PayloadTooLarge);
    let too_many = AiRequest { messages: (0..=AI_LIMITS.messages).map(|_| AiMessage { role: AiRole::User, content: AiContent::Text("x".into()), reasoning_content: None }).collect(), model: None };
    assert_eq!(validate_request(&too_many).unwrap_err().code, AiErrorCode::InvalidRequest);
}

#[test]
fn image_support_is_data_uri_only_and_checks_canonical_base64() {
    let valid = AiRequest { messages: vec![AiMessage { role: AiRole::User, content: AiContent::Parts(vec![AiPart::ImageUrl { image_url: AiImageUrl { url: "data:image/png;base64,AQ==".into(), detail: Some(AiImageDetail::High) } }]), reasoning_content: None }], model: None };
    assert_eq!(validate_request(&valid).unwrap().image_bytes, 1);
    for url in ["https://example.invalid/image.png", "data:image/gif;base64,AQ==", "data:image/png;base64,AR==", "data:image/png;base64,AA=A"] {
        let request = AiRequest { messages: vec![AiMessage { role: AiRole::User, content: AiContent::Parts(vec![AiPart::ImageUrl { image_url: AiImageUrl { url: url.into(), detail: None } }]), reasoning_content: None }], model: None };
        assert_eq!(validate_request(&request).unwrap_err().code, AiErrorCode::UnsupportedContent);
    }
}

#[test]
fn reasoning_is_assistant_only_and_uses_the_shared_text_budget() {
    let assistant = AiRequest { messages: vec![AiMessage { role: AiRole::Assistant,
        content: AiContent::Text("answer".into()), reasoning_content: Some("reason".into()) }], model: None };
    assert_eq!(validate_request(&assistant).unwrap().text_bytes, 12);
    let wrong_role = AiRequest { messages: vec![AiMessage { role: AiRole::User,
        content: AiContent::Text("question".into()), reasoning_content: Some("injected".into()) }], model: None };
    assert_eq!(validate_request(&wrong_role).unwrap_err().code, AiErrorCode::InvalidRequest);
    for detail in ["auto", "low", "high"] {
        assert!(serde_json::from_value::<AiImageUrl>(json!({"url":"data:image/png;base64,AQ==","detail":detail})).is_ok());
    }
    assert!(serde_json::from_value::<AiImageUrl>(json!({"url":"data:image/png;base64,AQ==","detail":"ultra"})).is_err());
}

#[test]
fn model_directory_keeps_provider_entries_and_rejects_duplicates() {
    let one = AiModel { id: "configured-default".into(), value: "configured-default".into(), label: "configured-default".into() };
    assert!(validate_model_directory(std::slice::from_ref(&one)).is_ok());
    assert_eq!(validate_model_directory(&[one.clone(), one]).unwrap_err().code, AiErrorCode::MalformedResponse);
    let provider_entry = AiModel { id: "actual-id".into(), value: "actual-id".into(), label: "Provider label".into() };
    assert!(validate_model_directory(&[provider_entry]).is_ok());
    let too_many = (0..=AI_LIMITS.model_count).map(|index| AiModel {
        id: format!("m{index}"), value: format!("m{index}"), label: format!("m{index}"),
    }).collect::<Vec<_>>();
    assert_eq!(validate_model_directory(&too_many).unwrap_err().code, AiErrorCode::PayloadTooLarge);
    let too_wide = AiModel { id: "x".repeat(AI_LIMITS.model_id_bytes + 1),
        value: "x".into(), label: "x".into() };
    assert_eq!(validate_model_directory(&[too_wide]).unwrap_err().code, AiErrorCode::MalformedResponse);
}

#[test]
fn large_delta_splits_without_loss_at_unicode_boundaries_and_caps_wire_json() {
    let source = "🙂\n\\\"".repeat(8_000);
    let fragments = split_delta(AiDelta { content: Some(source.clone()), reasoning_content: Some("推理".repeat(3_000)) }).unwrap();
    assert!(fragments.len() > 1);
    assert!(fragments.iter().all(|fragment| serde_json::to_vec(fragment).unwrap().len() <= AI_LIMITS.delta_field_bytes));
    let content = fragments.iter().filter_map(|part| part.content.as_deref())
        .fold(String::new(), |mut result, fragment| { result.push_str(fragment); result });
    let reasoning = fragments.iter().filter_map(|part| part.reasoning_content.as_deref())
        .fold(String::new(), |mut result, fragment| { result.push_str(fragment); result });
    assert_eq!(content, source);
    assert_eq!(reasoning, "推理".repeat(3_000));
}
