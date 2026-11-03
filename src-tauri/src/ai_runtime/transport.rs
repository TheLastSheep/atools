use super::{provider_config::AiProviderConfig, sse::SseDecoder};
use atools_core::ai_service::{
    split_delta, validate_model_directory, validate_request, AiAssistantMessage, AiDelta,
    AiErrorCode, AiMessage, AiModel, AiOutputMode, AiRequest, AiRole, AiServiceError, AI_LIMITS,
};
use futures::StreamExt;
use reqwest::{header, redirect::Policy, Client, Response, StatusCode};
use serde::Serialize;
use serde_json::Value;
#[cfg(test)]
#[path = "transport_tests.rs"]
mod tests;

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::sync::Notify;

#[async_trait::async_trait]
pub(crate) trait AiDeltaSink: Send {
    async fn send_delta(&mut self, delta: AiDelta) -> Result<(), AiServiceError>;
}

const MODEL_LIST_BUDGET: Duration = Duration::from_secs(15);
const FIRST_RESPONSE_BUDGET: Duration = Duration::from_secs(20);
const IDLE_BUDGET: Duration = Duration::from_secs(15);
const STREAM_TOTAL_BUDGET: Duration = Duration::from_secs(120);
const HTTP_BODY_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone)]
pub struct AiCancelHandle(Arc<CancelState>);

struct CancelState {
    cancelled: AtomicBool,
    notify: Notify,
}

impl AiCancelHandle {
    pub fn new() -> Self {
        Self(Arc::new(CancelState {
            cancelled: AtomicBool::new(false),
            notify: Notify::new(),
        }))
    }

    pub fn cancel(&self) {
        if !self.0.cancelled.swap(true, Ordering::AcqRel) {
            self.0.notify.notify_waiters();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::Acquire)
    }

    async fn cancelled(&self) {
        loop {
            let notified = self.0.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

impl Default for AiCancelHandle {
    fn default() -> Self {
        Self::new()
    }
}

pub struct AiChatOutcome {
    pub message: Option<AiAssistantMessage>,
    pub finish_reason: Option<String>,
    pub output_bytes: usize,
}

pub struct AiTransport {
    client: Client,
    config: AiProviderConfig,
}

impl AiTransport {
    pub fn new(config: AiProviderConfig) -> Result<Self, AiServiceError> {
        let mut builder = Client::builder()
            .redirect(Policy::none())
            .timeout(STREAM_TOTAL_BUDGET);
        if let Some(proxy) = config.proxy_url() {
            let proxy = reqwest::Proxy::all(proxy)
                .map_err(|_| AiServiceError::new(AiErrorCode::NotConfigured))?;
            builder = builder.proxy(proxy);
        }
        let client = builder
            .build()
            .map_err(|_| AiServiceError::new(AiErrorCode::Transport))?;
        Ok(Self { client, config })
    }

    pub async fn list_models(
        &self,
        cancel: &AiCancelHandle,
    ) -> Result<Vec<AiModel>, AiServiceError> {
        let started = Instant::now();
        let deadline = started + MODEL_LIST_BUDGET;
        let mut request = self
            .client
            .get(self.config.models_url()?)
            .header(header::ACCEPT, "application/json");
        if !self.config.api_key().is_empty() {
            request = request.bearer_auth(self.config.api_key());
        }
        let response = self
            .send_with_deadline(request.send(), deadline, cancel)
            .await?;
        ensure_success(response.status())?;
        let body = read_body(
            response,
            AI_LIMITS.model_response_body_bytes,
            deadline,
            IDLE_BUDGET,
            cancel,
        )
        .await?;
        let payload: Value = serde_json::from_slice(&body)
            .map_err(|_| AiServiceError::new(AiErrorCode::MalformedResponse))?;
        let rows = payload
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| AiServiceError::new(AiErrorCode::MalformedResponse))?;
        if rows.len() > AI_LIMITS.model_count {
            return Err(AiServiceError::new(AiErrorCode::PayloadTooLarge));
        }
        let mut models = Vec::with_capacity(rows.len());
        for row in rows {
            let id = row
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| {
                    !id.is_empty()
                        && id.len() <= AI_LIMITS.model_id_bytes
                        && !id.chars().any(char::is_control)
                })
                .ok_or_else(|| AiServiceError::new(AiErrorCode::MalformedResponse))?
                .to_string();
            let value = optional_model_text(row.get("value"))?.unwrap_or_else(|| id.clone());
            let label = optional_model_text(row.get("label"))?.unwrap_or_else(|| id.clone());
            models.push(AiModel { id, value, label });
        }
        validate_model_directory(&models)?;
        Ok(models)
    }

    pub async fn chat<S>(
        &self,
        request: &AiRequest,
        catalog: &[AiModel],
        mode: AiOutputMode,
        cancel: &AiCancelHandle,
        sink: &mut S,
    ) -> Result<AiChatOutcome, AiServiceError>
    where
        S: AiDeltaSink,
    {
        let budget = validate_request(request)?;
        validate_model_directory(catalog)?;
        if cancel.is_cancelled() {
            return Err(AiServiceError::new(AiErrorCode::Aborted));
        }
        let model = self
            .config
            .resolve_model(request.model.as_deref(), catalog)?;
        let body = serde_json::to_vec(&ChatPayload {
            model: &model,
            messages: &request.messages,
            temperature: self.config.temperature(),
            stream: true,
        })
        .map_err(|_| AiServiceError::new(AiErrorCode::InvalidRequest))?;
        if body.len() > AI_LIMITS.request_json_bytes
            || budget.image_bytes > AI_LIMITS.image_bytes_total
        {
            return Err(AiServiceError::new(AiErrorCode::PayloadTooLarge));
        }
        let started = Instant::now();
        let deadline = started + STREAM_TOTAL_BUDGET;
        let first_delta_deadline = started + FIRST_RESPONSE_BUDGET;
        let mut builder = self
            .client
            .post(self.config.chat_completions_url()?)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, "text/event-stream")
            .body(body);
        if !self.config.api_key().is_empty() {
            builder = builder.bearer_auth(self.config.api_key());
        }
        let first_deadline = std::cmp::min(deadline, started + FIRST_RESPONSE_BUDGET);
        let response = self
            .send_with_deadline(builder.send(), first_deadline, cancel)
            .await?;
        ensure_success(response.status())?;
        let mut stream = response.bytes_stream();
        let mut decoder = SseDecoder::default();
        let mut response_bytes = 0usize;
        let mut output_bytes = 0usize;
        let mut content = String::new();
        let mut reasoning = String::new();
        let mut finish_reason = None;
        let mut done = false;

        while !done {
            let read_deadline = if output_bytes == 0 {
                first_delta_deadline
            } else {
                deadline
            };
            let wait = remaining(read_deadline.min(deadline), IDLE_BUDGET)?;
            let next = tokio::select! {
                _ = cancel.cancelled() => return Err(AiServiceError::new(AiErrorCode::Aborted)),
                result = tokio::time::timeout(wait, stream.next()) => result,
            }
            .map_err(|_| AiServiceError::new(AiErrorCode::Timeout))?;
            let Some(chunk) = next else {
                break;
            };
            let chunk = chunk.map_err(|_| AiServiceError::new(AiErrorCode::Transport))?;
            response_bytes = response_bytes.saturating_add(chunk.len());
            if response_bytes > HTTP_BODY_BYTES {
                return Err(AiServiceError::new(AiErrorCode::PayloadTooLarge));
            }
            for event in decoder.push(&chunk)? {
                if process_event(
                    &event,
                    deadline,
                    mode,
                    cancel,
                    sink,
                    &mut content,
                    &mut reasoning,
                    &mut finish_reason,
                    &mut output_bytes,
                )
                .await?
                    == EventAction::Done
                {
                    done = true;
                    break;
                }
            }
        }
        if !done {
            for event in decoder.finish()? {
                if process_event(
                    &event,
                    deadline,
                    mode,
                    cancel,
                    sink,
                    &mut content,
                    &mut reasoning,
                    &mut finish_reason,
                    &mut output_bytes,
                )
                .await?
                    == EventAction::Done
                {
                    done = true;
                }
            }
        }
        if cancel.is_cancelled() {
            return Err(AiServiceError::new(AiErrorCode::Aborted));
        }
        if !done && finish_reason.is_none() {
            return Err(AiServiceError::new(AiErrorCode::TruncatedStream));
        }
        let message = if mode == AiOutputMode::Collect {
            Some(AiAssistantMessage {
                role: AiRole::Assistant,
                content,
                reasoning_content: if reasoning.is_empty() {
                    None
                } else {
                    Some(reasoning)
                },
            })
        } else {
            None
        };
        Ok(AiChatOutcome {
            message,
            finish_reason,
            output_bytes,
        })
    }

    async fn send_with_deadline<F>(
        &self,
        future: F,
        deadline: Instant,
        cancel: &AiCancelHandle,
    ) -> Result<Response, AiServiceError>
    where
        F: std::future::Future<Output = Result<Response, reqwest::Error>>,
    {
        let wait = deadline.saturating_duration_since(Instant::now());
        tokio::select! {
            _ = cancel.cancelled() => Err(AiServiceError::new(AiErrorCode::Aborted)),
            result = tokio::time::timeout(wait, future) => match result {
                Err(_) => Err(AiServiceError::new(AiErrorCode::Timeout)),
                Ok(Err(_)) => Err(AiServiceError::new(AiErrorCode::Transport)),
                Ok(Ok(response)) => Ok(response),
            }
        }
    }
}

#[derive(Serialize)]
struct ChatPayload<'a> {
    model: &'a str,
    messages: &'a [AiMessage],
    temperature: f64,
    stream: bool,
}

fn ensure_success(status: StatusCode) -> Result<(), AiServiceError> {
    if status.is_success() {
        Ok(())
    } else {
        Err(AiServiceError::http_status(status.as_u16()))
    }
}

fn optional_model_text(value: Option<&Value>) -> Result<Option<String>, AiServiceError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(AiServiceError::new(AiErrorCode::MalformedResponse)),
    }
}

async fn read_body(
    response: Response,
    cap: usize,
    deadline: Instant,
    idle: Duration,
    cancel: &AiCancelHandle,
) -> Result<Vec<u8>, AiServiceError> {
    if response
        .content_length()
        .is_some_and(|size| size > cap as u64)
    {
        return Err(AiServiceError::new(AiErrorCode::PayloadTooLarge));
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    loop {
        let wait = remaining(deadline, idle)?;
        let next = tokio::select! {
            _ = cancel.cancelled() => return Err(AiServiceError::new(AiErrorCode::Aborted)),
            result = tokio::time::timeout(wait, stream.next()) => result,
        }
        .map_err(|_| AiServiceError::new(AiErrorCode::Timeout))?;
        let Some(chunk) = next else {
            break;
        };
        let chunk = chunk.map_err(|_| AiServiceError::new(AiErrorCode::Transport))?;
        if body.len().saturating_add(chunk.len()) > cap {
            return Err(AiServiceError::new(AiErrorCode::PayloadTooLarge));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn remaining(deadline: Instant, idle: Duration) -> Result<Duration, AiServiceError> {
    let time = deadline.saturating_duration_since(Instant::now());
    if time.is_zero() {
        Err(AiServiceError::new(AiErrorCode::Timeout))
    } else {
        Ok(time.min(idle))
    }
}

fn remaining_total(deadline: Instant) -> Result<Duration, AiServiceError> {
    let time = deadline.saturating_duration_since(Instant::now());
    if time.is_zero() {
        Err(AiServiceError::new(AiErrorCode::Timeout))
    } else {
        Ok(time)
    }
}

#[derive(Debug, PartialEq, Eq)]
enum EventAction {
    Continue,
    Done,
}

async fn process_event<S: AiDeltaSink>(
    event: &str,
    deadline: Instant,
    mode: AiOutputMode,
    cancel: &AiCancelHandle,
    sink: &mut S,
    content: &mut String,
    reasoning: &mut String,
    finish_reason: &mut Option<String>,
    output_bytes: &mut usize,
) -> Result<EventAction, AiServiceError> {
    if cancel.is_cancelled() {
        return Err(AiServiceError::new(AiErrorCode::Aborted));
    }
    match parse_event(event)? {
        EventResult::Ignore => Ok(EventAction::Continue),
        EventResult::Done => Ok(EventAction::Done),
        EventResult::Finish(reason) => {
            if finish_reason.replace(reason).is_some() {
                return Err(AiServiceError::new(AiErrorCode::MalformedResponse));
            }
            Ok(EventAction::Continue)
        }
        EventResult::Delta(delta, terminal_reason) => {
            if finish_reason.is_some() {
                return Err(AiServiceError::new(AiErrorCode::MalformedResponse));
            }
            for fragment in split_delta(delta)? {
                let fragment_bytes = fragment
                    .content
                    .as_ref()
                    .map_or(0, String::len)
                    .saturating_add(fragment.reasoning_content.as_ref().map_or(0, String::len));
                *output_bytes = (*output_bytes).saturating_add(fragment_bytes);
                if *output_bytes > AI_LIMITS.collected_output_bytes {
                    return Err(AiServiceError::new(AiErrorCode::PayloadTooLarge));
                }
                if mode == AiOutputMode::Collect {
                    if let Some(value) = &fragment.content {
                        content.push_str(value);
                    }
                    if let Some(value) = &fragment.reasoning_content {
                        reasoning.push_str(value);
                    }
                } else {
                    let wait = remaining_total(deadline)?;
                    tokio::select! {
                        _ = cancel.cancelled() => return Err(AiServiceError::new(AiErrorCode::Aborted)),
                        result = tokio::time::timeout(wait, sink.send_delta(fragment)) => match result {
                            Err(_) => return Err(AiServiceError::new(AiErrorCode::Timeout)),
                            Ok(result) => result?,
                        },
                    }
                }
                if cancel.is_cancelled() {
                    return Err(AiServiceError::new(AiErrorCode::Aborted));
                }
            }
            if let Some(reason) = terminal_reason {
                if finish_reason.replace(reason).is_some() {
                    return Err(AiServiceError::new(AiErrorCode::MalformedResponse));
                }
            }
            Ok(EventAction::Continue)
        }
    }
}

enum EventResult {
    Ignore,
    Delta(AiDelta, Option<String>),
    Finish(String),
    Done,
}

fn parse_event(event: &str) -> Result<EventResult, AiServiceError> {
    if event == "[DONE]" {
        return Ok(EventResult::Done);
    }
    let value: Value = serde_json::from_str(event)
        .map_err(|_| AiServiceError::new(AiErrorCode::MalformedResponse))?;
    if value.get("error").is_some() {
        return Err(AiServiceError::new(AiErrorCode::ProviderError));
    }
    let choices = value
        .get("choices")
        .and_then(Value::as_array)
        .ok_or_else(|| AiServiceError::new(AiErrorCode::MalformedResponse))?;
    if choices.len() != 1 {
        return Err(AiServiceError::new(AiErrorCode::UnsupportedContent));
    }
    let Some(choice) = choices.first() else {
        return Err(AiServiceError::new(AiErrorCode::MalformedResponse));
    };
    let delta = choice.get("delta").and_then(Value::as_object);
    if delta.is_some_and(|delta| {
        nonempty_tool_payload(delta.get("tool_calls"))
            || nonempty_tool_payload(delta.get("function_call"))
    }) {
        return Err(AiServiceError::new(AiErrorCode::UnsupportedToolCall));
    }
    if let Some(delta) = delta {
        if delta
            .keys()
            .any(|key| !matches!(key.as_str(), "content" | "reasoning_content" | "role"))
        {
            return Err(AiServiceError::new(AiErrorCode::UnsupportedContent));
        }
        if delta
            .get("role")
            .is_some_and(|role| role.as_str() != Some("assistant"))
        {
            return Err(AiServiceError::new(AiErrorCode::MalformedResponse));
        }
    }
    if choice
        .get("finish_reason")
        .is_some_and(|reason| !reason.is_null())
    {
        let reason = choice
            .get("finish_reason")
            .and_then(Value::as_str)
            .ok_or_else(|| AiServiceError::new(AiErrorCode::MalformedResponse))?
            .to_string();
        if reason == "tool_calls" || reason == "function_call" {
            return Err(AiServiceError::new(AiErrorCode::UnsupportedToolCall));
        }
        if !matches!(
            reason.as_str(),
            "stop" | "length" | "content_filter" | "eos" | "end_turn" | "stop_sequence"
        ) {
            return Err(AiServiceError::new(AiErrorCode::MalformedResponse));
        }
        let final_delta = if let Some(delta) = delta {
            let content = optional_string(delta.get("content"))?;
            let reasoning = optional_string(delta.get("reasoning_content"))?;
            if content.as_deref().unwrap_or_default().is_empty()
                && reasoning.as_deref().unwrap_or_default().is_empty()
            {
                None
            } else {
                Some(AiDelta {
                    content,
                    reasoning_content: reasoning,
                })
            }
        } else {
            None
        };
        return Ok(match final_delta {
            Some(delta) => EventResult::Delta(delta, Some(reason)),
            None => EventResult::Finish(reason),
        });
    }
    let delta = delta.ok_or_else(|| AiServiceError::new(AiErrorCode::MalformedResponse))?;
    let content = optional_string(delta.get("content"))?;
    let reasoning = optional_string(delta.get("reasoning_content"))?;
    if content.as_deref().unwrap_or_default().is_empty()
        && reasoning.as_deref().unwrap_or_default().is_empty()
    {
        return Ok(EventResult::Ignore);
    }
    Ok(EventResult::Delta(
        AiDelta {
            content,
            reasoning_content: reasoning,
        },
        None,
    ))
}

fn nonempty_tool_payload(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(fields)) => !fields.is_empty(),
        Some(Value::String(value)) => !value.is_empty(),
        _ => false,
    }
}

fn optional_string(value: Option<&Value>) -> Result<Option<String>, AiServiceError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(AiServiceError::new(AiErrorCode::MalformedResponse)),
    }
}
