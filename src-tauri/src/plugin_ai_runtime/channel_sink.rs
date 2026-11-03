use super::types::{AiDeltaEnvelope, Request, ACK_LEASE, MAX_ENVELOPE};
use atools_core::ai_service::{AiDelta, AiErrorCode, AiServiceError};
use atools_core::Database;
use std::sync::Arc;
use tauri::ipc::Channel;
use tokio::time::timeout;

pub(super) struct ChannelSink {
    pub request: Arc<Request>,
    pub channel: Channel<AiDeltaEnvelope>,
    pub seq: u64,
    pub db: Arc<Database>,
    pub run_id: String,
}
impl ChannelSink {
    pub async fn terminal(
        &mut self,
        status: &str,
        bytes: usize,
        code: Option<AiErrorCode>,
    ) -> Result<(), AiServiceError> {
        self.seq = self.seq.saturating_add(1);
        let event = AiDeltaEnvelope {
            kind: "terminal".into(),
            request_id: self.request.id.clone(),
            seq: self.seq,
            delta: None,
            status: Some(status.into()),
            output_bytes: Some(bytes),
            code: code.map(code_name),
        };
        self.send_wait(event).await
    }
    async fn send_wait(&mut self, event: AiDeltaEnvelope) -> Result<(), AiServiceError> {
        super::executor::validate_current(&self.db, &self.request, &self.run_id)
            .map_err(|_| AiServiceError::new(AiErrorCode::Aborted))?;
        let data =
            serde_json::to_vec(&event).map_err(|_| AiServiceError::new(AiErrorCode::Transport))?;
        if data.len() > MAX_ENVELOPE {
            return Err(AiServiceError::new(AiErrorCode::PayloadTooLarge));
        }
        let notify = Arc::new(tokio::sync::Notify::new());
        {
            let mut slot = self.request.ack.lock();
            if slot.is_some() {
                return Err(AiServiceError::new(AiErrorCode::Busy));
            }
            *slot = Some((event.seq, false, notify.clone()));
        }
        if self.channel.send(event).is_err() {
            self.request.ack.lock().take();
            return Err(AiServiceError::new(AiErrorCode::Transport));
        }
        let waited = timeout(ACK_LEASE, async {
            loop {
                let notified = notify.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if self.request.cancel.is_cancelled() {
                    return Err(AiServiceError::new(AiErrorCode::Aborted));
                }
                let done = self
                    .request
                    .ack
                    .lock()
                    .as_ref()
                    .is_some_and(|(seq, acked, _)| *seq == self.seq && *acked);
                if done {
                    return Ok(());
                }
                notified.await;
            }
        })
        .await;
        self.request.ack.lock().take();
        waited
            .map_err(|_| AiServiceError::new(AiErrorCode::Timeout))?
            .map_err(|error| error)?;
        super::executor::validate_current(&self.db, &self.request, &self.run_id)
            .map_err(|_| AiServiceError::new(AiErrorCode::Aborted))
    }
}
#[async_trait::async_trait]
impl crate::ai_runtime::AiDeltaSink for ChannelSink {
    async fn send_delta(&mut self, delta: AiDelta) -> Result<(), AiServiceError> {
        for fragment in split_for_envelope(&self.request.id, self.seq, delta)? {
            self.seq = self.seq.saturating_add(1);
            let event = AiDeltaEnvelope {
                kind: "delta".into(),
                request_id: self.request.id.clone(),
                seq: self.seq,
                delta: Some(fragment),
                status: None,
                output_bytes: None,
                code: None,
            };
            self.send_wait(event).await?;
            *self.request.delta_count.lock() += 1;
        }
        Ok(())
    }
}

fn split_for_envelope(
    request_id: &str,
    base_seq: u64,
    delta: AiDelta,
) -> Result<Vec<AiDelta>, AiServiceError> {
    let mut fragments = Vec::new();
    if let Some(content) = delta.content.filter(|text| !text.is_empty()) {
        split_field(request_id, base_seq, &content, true, &mut fragments)?;
    }
    if let Some(reasoning) = delta.reasoning_content.filter(|text| !text.is_empty()) {
        split_field(request_id, base_seq, &reasoning, false, &mut fragments)?;
    }
    if fragments.is_empty() {
        return Err(AiServiceError::new(AiErrorCode::MalformedResponse));
    }
    Ok(fragments)
}

fn split_field(
    request_id: &str,
    base_seq: u64,
    text: &str,
    content: bool,
    out: &mut Vec<AiDelta>,
) -> Result<(), AiServiceError> {
    let mut offset = 0;
    while offset < text.len() {
        let seq = base_seq.saturating_add(out.len() as u64).saturating_add(1);
        let empty = if content {
            AiDelta {
                content: Some(String::new()),
                reasoning_content: None,
            }
        } else {
            AiDelta {
                content: None,
                reasoning_content: Some(String::new()),
            }
        };
        let envelope = AiDeltaEnvelope {
            kind: "delta".into(),
            request_id: request_id.into(),
            seq,
            delta: Some(empty),
            status: None,
            output_bytes: None,
            code: None,
        };
        let fixed = serde_json::to_vec(&envelope)
            .map_err(|_| AiServiceError::new(AiErrorCode::Transport))?
            .len();
        let budget = MAX_ENVELOPE
            .checked_sub(fixed)
            .ok_or_else(|| AiServiceError::new(AiErrorCode::PayloadTooLarge))?;
        let mut used = 0;
        let mut end = offset;
        for (relative, character) in text[offset..].char_indices() {
            let next = used + json_character_bytes(character);
            if end > offset && next > budget {
                break;
            }
            if next > budget {
                return Err(AiServiceError::new(AiErrorCode::PayloadTooLarge));
            }
            used = next;
            end = offset + relative + character.len_utf8();
        }
        if end == offset {
            return Err(AiServiceError::new(AiErrorCode::PayloadTooLarge));
        }
        let part = text[offset..end].to_owned();
        let fragment = if content {
            AiDelta {
                content: Some(part),
                reasoning_content: None,
            }
        } else {
            AiDelta {
                content: None,
                reasoning_content: Some(part),
            }
        };
        let event = AiDeltaEnvelope {
            kind: "delta".into(),
            request_id: request_id.into(),
            seq,
            delta: Some(fragment),
            status: None,
            output_bytes: None,
            code: None,
        };
        if serde_json::to_vec(&event)
            .map_err(|_| AiServiceError::new(AiErrorCode::Transport))?
            .len()
            > MAX_ENVELOPE
        {
            return Err(AiServiceError::new(AiErrorCode::PayloadTooLarge));
        }
        out.push(
            event
                .delta
                .ok_or_else(|| AiServiceError::new(AiErrorCode::Transport))?,
        );
        offset = end;
    }
    Ok(())
}

fn json_character_bytes(character: char) -> usize {
    match character {
        '"' | '\\' | '\u{08}' | '\u{09}' | '\u{0a}' | '\u{0c}' | '\u{0d}' => 2,
        '\u{00}'..='\u{1f}' => 6,
        _ => character.len_utf8(),
    }
}

fn code_name(code: AiErrorCode) -> String {
    match code {
        AiErrorCode::InvalidRequest => "invalid_request",
        AiErrorCode::UnsupportedContent => "unsupported_content",
        AiErrorCode::UnsupportedToolCall => "unsupported_tool_call",
        AiErrorCode::PayloadTooLarge => "payload_too_large",
        AiErrorCode::UnknownModel => "unknown_model",
        AiErrorCode::NotConfigured => "not_configured",
        AiErrorCode::Transport => "transport",
        AiErrorCode::HttpStatus => "http_status",
        AiErrorCode::ProviderError => "provider_error",
        AiErrorCode::TruncatedStream => "truncated_stream",
        AiErrorCode::MalformedResponse => "malformed_response",
        AiErrorCode::Timeout => "timeout",
        AiErrorCode::Aborted => "aborted",
        AiErrorCode::Busy => "busy",
    }
    .into()
}

#[cfg(test)]
#[path = "channel_sink_tests.rs"]
mod tests;
