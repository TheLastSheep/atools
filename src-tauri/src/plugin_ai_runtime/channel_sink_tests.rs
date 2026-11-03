use super::split_for_envelope;
use crate::plugin_ai_runtime::types::{AiDeltaEnvelope, MAX_ENVELOPE};
use atools_core::ai_service::AiDelta;

#[test]
fn escaped_unicode_deltas_fit_complete_envelopes_without_losing_text() {
    let request_id = "a4a5f69e-f233-4775-b747-009be42b343b";
    let content = format!("{}{}", "\"\\\n\u{1}".repeat(8_000), "中文🙂".repeat(2_000));
    let reasoning = format!("{}{}", "\u{0}\t".repeat(5_000), "分析🧭".repeat(1_500));
    let pieces = split_for_envelope(
        request_id,
        40,
        AiDelta {
            content: Some(content.clone()),
            reasoning_content: Some(reasoning.clone()),
        },
    )
    .expect("bounded fragments");
    let mut joined_content = String::new();
    let mut joined_reasoning = String::new();
    for (offset, piece) in pieces.iter().enumerate() {
        let seq = 41 + offset as u64;
        let envelope = AiDeltaEnvelope {
            kind: "delta".into(),
            request_id: request_id.into(),
            seq,
            delta: Some(AiDelta {
                content: piece.content.clone(),
                reasoning_content: piece.reasoning_content.clone(),
            }),
            status: None,
            output_bytes: None,
            code: None,
        };
        let wire = serde_json::to_vec(&envelope).expect("serializable event");
        assert!(
            wire.len() <= MAX_ENVELOPE,
            "complete event exceeded envelope budget"
        );
        match (&piece.content, &piece.reasoning_content) {
            (Some(text), None) => joined_content.push_str(text),
            (None, Some(text)) => joined_reasoning.push_str(text),
            _ => panic!("each fragment must contain one text channel"),
        }
    }
    assert!(pieces.len() > 2, "test input must exercise splitting");
    assert_eq!(joined_content, content);
    assert_eq!(joined_reasoning, reasoning);
}
