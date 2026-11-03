use super::*;
use atools_core::ai_service::{AiContent, AiMessage, AiPart, AiRole};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};

struct Reply {
    status: &'static str,
    content_type: &'static str,
    body: Vec<u8>,
    fragment: bool,
    allow_early_close: bool,
}
struct RequestObservation {
    path: String,
    authorized: bool,
    json: Value,
}

async fn fixture(replies: Vec<Reply>) -> (String, JoinHandle<Vec<RequestObservation>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let mut observed = Vec::new();
        for reply in replies {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let header_end = loop {
                if let Some(index) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    break index + 4;
                }
                let mut buffer = [0; 4096];
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
            };
            let headers = String::from_utf8_lossy(&request[..header_end]).into_owned();
            let length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            while request.len() < header_end + length {
                let mut buffer = [0; 4096];
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
            }
            let first = headers.lines().next().unwrap_or_default();
            let path = first
                .split_whitespace()
                .nth(1)
                .unwrap_or_default()
                .to_string();
            let authorized = headers
                .lines()
                .any(|line| line.eq_ignore_ascii_case("authorization: Bearer fixture-secret"));
            let body = if length == 0 {
                Value::Null
            } else {
                serde_json::from_slice(&request[header_end..header_end + length])
                    .unwrap_or(Value::Null)
            };
            observed.push(RequestObservation {
                path,
                authorized,
                json: body,
            });
            let response_header = format!("HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                reply.status, reply.content_type, reply.body.len());
            socket.write_all(response_header.as_bytes()).await.unwrap();
            if reply.fragment && reply.body.len() > 1 {
                let split = reply.body.len() / 2;
                socket.write_all(&reply.body[..split]).await.unwrap();
                tokio::task::yield_now().await;
                socket.write_all(&reply.body[split..]).await.unwrap();
            } else {
                if let Err(error) = socket.write_all(&reply.body).await {
                    assert!(
                        reply.allow_early_close
                            && matches!(
                                error.kind(),
                                std::io::ErrorKind::BrokenPipe
                                    | std::io::ErrorKind::ConnectionReset
                            ),
                        "unexpected fixture response write failure: {error}"
                    );
                }
            }
        }
        observed
    });
    (format!("http://127.0.0.1:{port}/v1"), task)
}

fn config(base_url: &str) -> AiProviderConfig {
    AiProviderConfig::from_settings(&json!({"aiProvider":"compatible","aiBaseUrl":base_url,
        "aiDefaultModel":"fixture-model","aiApiKey":"fixture-secret","proxyEnabled":false}))
    .ok()
    .unwrap()
}

fn reply(body: &str, content_type: &'static str, fragment: bool) -> Reply {
    Reply {
        status: "200 OK",
        content_type,
        body: body.as_bytes().to_vec(),
        fragment,
        allow_early_close: false,
    }
}

fn chat_request(content: AiContent) -> AiRequest {
    AiRequest {
        messages: vec![AiMessage {
            role: AiRole::User,
            content,
            reasoning_content: None,
        }],
        model: None,
    }
}

#[derive(Default)]
struct RecordingSink(Vec<AiDelta>);

#[async_trait::async_trait]
impl AiDeltaSink for RecordingSink {
    async fn send_delta(&mut self, delta: AiDelta) -> Result<(), AiServiceError> {
        self.0.push(delta);
        Ok(())
    }
}

struct CancelOnDeltaSink {
    cancel: AiCancelHandle,
    calls: Arc<AtomicUsize>,
}

#[async_trait::async_trait]
impl AiDeltaSink for CancelOnDeltaSink {
    async fn send_delta(&mut self, _delta: AiDelta) -> Result<(), AiServiceError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.cancel.cancel();
        Ok(())
    }
}

struct BlockingSink {
    started: Option<tokio::sync::oneshot::Sender<()>>,
    release: Option<tokio::sync::oneshot::Receiver<()>>,
    calls: Arc<AtomicUsize>,
}

struct StalledSink;

#[async_trait::async_trait]
impl AiDeltaSink for StalledSink {
    async fn send_delta(&mut self, _delta: AiDelta) -> Result<(), AiServiceError> {
        std::future::pending::<Result<(), AiServiceError>>().await
    }
}

#[async_trait::async_trait]
impl AiDeltaSink for BlockingSink {
    async fn send_delta(&mut self, _delta: AiDelta) -> Result<(), AiServiceError> {
        if let Some(started) = self.started.take() {
            let _ = started.send(());
        }
        if let Some(release) = self.release.take() {
            release
                .await
                .map_err(|_| AiServiceError::new(AiErrorCode::Aborted))?;
        }
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

#[tokio::test]
async fn configured_models_and_stream_or_collect_share_bounded_provider_transport() {
    let sse = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"hello \"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"checking\",\"content\":\"world\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n");
    let (base, server) = fixture(vec![
        reply(
            r#"{"data":[{"id":"fixture-model","value":"fixture-value","label":"Fixture model"}]}"#,
            "application/json",
            false,
        ),
        reply(sse, "text/event-stream", true),
        reply(sse, "text/event-stream", true),
    ])
    .await;
    let transport = AiTransport::new(config(&base)).unwrap();
    let cancel = AiCancelHandle::new();
    let models = transport.list_models(&cancel).await.unwrap();
    assert_eq!(
        models,
        vec![AiModel {
            id: "fixture-model".into(),
            value: "fixture-value".into(),
            label: "Fixture model".into()
        }]
    );
    let mut deltas = RecordingSink::default();
    let streamed = transport
        .chat(
            &chat_request(AiContent::Text("hello".into())),
            &models,
            AiOutputMode::Stream,
            &cancel,
            &mut deltas,
        )
        .await
        .unwrap();
    assert!(streamed.message.is_none());
    assert_eq!(streamed.finish_reason.as_deref(), Some("stop"));
    assert_eq!(deltas.0.len(), 2);
    assert_eq!(deltas.0[1].reasoning_content.as_deref(), Some("checking"));
    let mut no_deltas = RecordingSink::default();
    let collected = transport
        .chat(
            &chat_request(AiContent::Parts(vec![
                AiPart::Text {
                    text: "hello".into(),
                },
                AiPart::ImageUrl {
                    image_url: atools_core::ai_service::AiImageUrl {
                        url: "data:image/png;base64,AQ==".into(),
                        detail: Some(atools_core::ai_service::AiImageDetail::Low),
                    },
                },
            ])),
            &models,
            AiOutputMode::Collect,
            &cancel,
            &mut no_deltas,
        )
        .await
        .unwrap();
    assert_eq!(collected.message.unwrap().content, "hello world");
    let requests = server.await.unwrap();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[0].path, "/v1/models");
    assert_eq!(requests[1].path, "/v1/chat/completions");
    assert!(requests.iter().all(|request| request.authorized));
    assert_eq!(requests[1].json["stream"], true);
    assert_eq!(
        requests[2].json["messages"][0]["content"][1]["type"],
        "image_url"
    );
}

#[tokio::test]
async fn collect_requires_done_or_valid_finish_and_rejects_tool_calls() {
    let (base, server) = fixture(vec![
        reply("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n", "text/event-stream", false),
        reply("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n", "text/event-stream", false),
        reply("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"id\":\"call-1\"}]},\"finish_reason\":null}]}\n\n", "text/event-stream", false),
        reply("data: {\"choices\":[{\"delta\":{\"function_call\":{\"name\":\"run\"}},\"finish_reason\":null}]}\n\n", "text/event-stream", false),
        reply("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n", "text/event-stream", false),
    ]).await;
    let transport = AiTransport::new(config(&base)).unwrap();
    let catalog = vec![AiModel {
        id: "fixture-model".into(),
        value: "fixture-model".into(),
        label: "fixture-model".into(),
    }];
    let mut sink = RecordingSink::default();
    let complete = transport
        .chat(
            &chat_request(AiContent::Text("x".into())),
            &catalog,
            AiOutputMode::Collect,
            &AiCancelHandle::new(),
            &mut sink,
        )
        .await
        .unwrap();
    assert_eq!(complete.message.unwrap().content, "ok");
    let truncated = transport
        .chat(
            &chat_request(AiContent::Text("x".into())),
            &catalog,
            AiOutputMode::Collect,
            &AiCancelHandle::new(),
            &mut sink,
        )
        .await
        .err()
        .unwrap();
    assert_eq!(truncated.code, AiErrorCode::TruncatedStream);
    let unsupported = transport
        .chat(
            &chat_request(AiContent::Text("x".into())),
            &catalog,
            AiOutputMode::Collect,
            &AiCancelHandle::new(),
            &mut sink,
        )
        .await
        .err()
        .unwrap();
    assert_eq!(unsupported.code, AiErrorCode::UnsupportedToolCall);
    for _ in 0..2 {
        let unsupported = transport
            .chat(
                &chat_request(AiContent::Text("x".into())),
                &catalog,
                AiOutputMode::Collect,
                &AiCancelHandle::new(),
                &mut sink,
            )
            .await
            .err()
            .unwrap();
        assert_eq!(unsupported.code, AiErrorCode::UnsupportedToolCall);
    }
    server.await.unwrap();
}

#[tokio::test]
async fn final_nonempty_delta_is_delivered_before_finish_reason() {
    let event = r#"{"choices":[{"delta":{"content":"last","reasoning_content":"why"},"finish_reason":"stop"}]}"#;
    let body = format!("data: {event}\n\n");
    let (base, server) = fixture(vec![reply(&body, "text/event-stream", false)]).await;
    let transport = AiTransport::new(config(&base)).unwrap();
    let catalog = vec![AiModel {
        id: "fixture-model".into(),
        value: "fixture-model".into(),
        label: "fixture-model".into(),
    }];
    let mut sink = RecordingSink::default();
    let result = transport
        .chat(
            &chat_request(AiContent::Text("x".into())),
            &catalog,
            AiOutputMode::Stream,
            &AiCancelHandle::new(),
            &mut sink,
        )
        .await
        .unwrap();
    assert_eq!(result.finish_reason.as_deref(), Some("stop"));
    assert_eq!(sink.0.len(), 1);
    assert_eq!(sink.0[0].content.as_deref(), Some("last"));
    assert_eq!(sink.0[0].reasoning_content.as_deref(), Some("why"));
    server.await.unwrap();
}

#[tokio::test]
async fn stalled_sink_obeys_total_deadline_and_cancellation() {
    let mut sink = StalledSink;
    let cancel = AiCancelHandle::new();
    let deadline = Instant::now() + Duration::from_millis(10);
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut finish_reason = None;
    let mut output_bytes = 0;
    let result = process_event(
        r#"{"choices":[{"delta":{"content":"x"},"finish_reason":null}]}"#,
        deadline,
        AiOutputMode::Stream,
        &cancel,
        &mut sink,
        &mut content,
        &mut reasoning,
        &mut finish_reason,
        &mut output_bytes,
    )
    .await;
    assert_eq!(result.unwrap_err().code, AiErrorCode::Timeout);

    let cancel = AiCancelHandle::new();
    let cancelling = cancel.clone();
    tokio::spawn(async move {
        tokio::task::yield_now().await;
        cancelling.cancel();
    });
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut finish_reason = None;
    let mut output_bytes = 0;
    let result = process_event(
        r#"{"choices":[{"delta":{"content":"x"},"finish_reason":null}]}"#,
        Instant::now() + Duration::from_secs(1),
        AiOutputMode::Stream,
        &cancel,
        &mut sink,
        &mut content,
        &mut reasoning,
        &mut finish_reason,
        &mut output_bytes,
    )
    .await;
    assert_eq!(result.unwrap_err().code, AiErrorCode::Aborted);
}

#[tokio::test]
async fn model_raw_response_has_its_own_one_mib_cap() {
    let oversized = vec![b' '; AI_LIMITS.model_response_body_bytes + 1];
    let (base, server) = fixture(vec![Reply {
        status: "200 OK",
        content_type: "application/json",
        body: oversized,
        fragment: false,
        allow_early_close: true,
    }])
    .await;
    let transport = AiTransport::new(config(&base)).unwrap();
    let error = transport
        .list_models(&AiCancelHandle::new())
        .await
        .unwrap_err();
    assert_eq!(error.code, AiErrorCode::PayloadTooLarge);
    server.await.unwrap();
}

#[tokio::test]
async fn cancellation_during_delta_prevents_later_events_from_same_network_chunk() {
    let body = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"first\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"late\"},\"finish_reason\":null}]}\n\n",
        "data: [DONE]\n\n"
    );
    let (base, server) = fixture(vec![reply(body, "text/event-stream", false)]).await;
    let transport = AiTransport::new(config(&base)).unwrap();
    let catalog = vec![AiModel {
        id: "fixture-model".into(),
        value: "fixture-model".into(),
        label: "fixture-model".into(),
    }];
    let cancel = AiCancelHandle::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut sink = CancelOnDeltaSink {
        cancel: cancel.clone(),
        calls: Arc::clone(&calls),
    };
    let error = transport
        .chat(
            &chat_request(AiContent::Text("x".into())),
            &catalog,
            AiOutputMode::Stream,
            &cancel,
            &mut sink,
        )
        .await
        .err()
        .unwrap();
    assert_eq!(error.code, AiErrorCode::Aborted);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    server.await.unwrap();
}

#[tokio::test]
async fn async_delta_sink_ack_is_backpressure_before_next_delta() {
    let body = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"first\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"second\"},\"finish_reason\":null}]}\n\n",
        "data: [DONE]\n\n"
    );
    let (base, server) = fixture(vec![reply(body, "text/event-stream", false)]).await;
    let transport = AiTransport::new(config(&base)).unwrap();
    let catalog = vec![AiModel {
        id: "fixture-model".into(),
        value: "fixture-model".into(),
        label: "fixture-model".into(),
    }];
    let request = chat_request(AiContent::Text("x".into()));
    let cancel = AiCancelHandle::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let mut sink = BlockingSink {
        started: Some(started_tx),
        release: Some(release_rx),
        calls: Arc::clone(&calls),
    };
    let task = tokio::spawn(async move {
        transport
            .chat(&request, &catalog, AiOutputMode::Stream, &cancel, &mut sink)
            .await
    });
    started_rx.await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(!task.is_finished());
    release_tx.send(()).unwrap();
    task.await.unwrap().unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    server.await.unwrap();
}

#[tokio::test]
async fn response_errors_are_fixed_and_do_not_echo_provider_body() {
    let (base, server) = fixture(vec![Reply {
        status: "401 Unauthorized",
        content_type: "application/json",
        body: b"secret provider response".to_vec(),
        fragment: false,
        allow_early_close: false,
    }])
    .await;
    let transport = AiTransport::new(config(&base)).unwrap();
    let error = transport
        .list_models(&AiCancelHandle::new())
        .await
        .unwrap_err();
    assert_eq!(error.code, AiErrorCode::HttpStatus);
    assert_eq!(error.http_status, Some(401));
    assert!(!error.to_string().contains("secret provider response"));
    server.await.unwrap();
}
