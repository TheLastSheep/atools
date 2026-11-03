//! Synthetic transports only; no plugin package or native dialog is executed.
use super::*;
use crate::plugin_loopback::BridgeServer;
use async_trait::async_trait;
use std::{
    io,
    pin::Pin,
    sync::atomic::{AtomicUsize, Ordering},
    task::{Context, Poll},
};
use tokio::{
    io::{DuplexStream, ReadBuf},
    net::TcpStream,
    sync::Notify,
};

const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
fn opaque_cors() -> VerifiedCorsOrigin<'static> {
    static POLICY: crate::plugin_loopback::OriginPolicy =
        crate::plugin_loopback::OriginPolicy::Opaque;
    POLICY.authorize(Some("null")).unwrap()
}
#[derive(Default)]
struct Handler {
    calls: AtomicUsize,
    active: AtomicUsize,
    entered: Notify,
    release: Notify,
    dropped: Notify,
}
struct Active<'a>(&'a Handler);
impl Drop for Active<'_> {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
        self.0.dropped.notify_one();
    }
}
#[async_trait]
impl RequestHandler for Handler {
    fn authenticated(&self, token: &str) -> bool {
        token == TOKEN
    }
    async fn handle(&self, _: &str, _: Value) -> Result<Value, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.active.fetch_add(1, Ordering::SeqCst);
        let _active = Active(self);
        self.entered.notify_one();
        self.release.notified().await;
        Ok(json!({"canceled":true,"paths":[]}))
    }
}
async fn started(reader: &mut (impl AsyncRead + Unpin)) -> (String, Vec<u8>) {
    let mut bytes = Vec::new();
    loop {
        let mut chunk = [0; 512];
        let read = tokio::time::timeout(Duration::from_secs(1), reader.read(&mut chunk))
            .await
            .unwrap()
            .unwrap();
        assert_ne!(read, 0);
        bytes.extend_from_slice(&chunk[..read]);
        if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            if bytes.len() > end + 4 {
                let body = bytes.split_off(end + 4);
                assert!(body.iter().all(u8::is_ascii_whitespace));
                let headers = String::from_utf8(bytes).unwrap();
                assert!(headers.contains("Connection: close\r\n"));
                assert!(!headers.contains("Content-Length:"));
                assert!(!headers.contains("Transfer-Encoding:"));
                return (headers, body);
            }
        }
    }
}
async fn finish(reader: &mut (impl AsyncRead + Unpin), mut body: Vec<u8>) {
    tokio::time::timeout(Duration::from_secs(1), reader.read_to_end(&mut body))
        .await
        .unwrap()
        .unwrap();
    // Parsing the complete body also rejects a second result or partial JSON.
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({"ok":true,"result":{"canceled":true,"paths":[]}})
    );
    assert!(body.len() < MAX_BODY);
}
fn spawn_duplex(
    handler: Arc<Handler>,
) -> (DuplexStream, tokio::task::JoinHandle<Result<(), String>>) {
    let (client, server) = tokio::io::duplex(8192);
    (
        client,
        tokio::spawn(serve(
            server,
            "HTTP/1.1",
            handler,
            TOKEN,
            json!({}),
            opaque_cors(),
        )),
    )
}

#[tokio::test(start_paused = true)]
async fn sixteen_second_active_wait_keeps_exactly_one_future_and_unique_result() {
    let handler = Arc::new(Handler::default());
    let (mut client, task) = spawn_duplex(handler.clone());
    let (_, mut body) = started(&mut client).await;
    handler.entered.notified().await;
    for _ in 0..8 {
        tokio::time::advance(HEARTBEAT).await;
        let mut byte = [0];
        client.read_exact(&mut byte).await.unwrap();
        assert_eq!(byte, [b' ']);
        body.extend(byte);
        assert_eq!(handler.calls.load(Ordering::SeqCst), 1);
        assert_eq!(handler.active.load(Ordering::SeqCst), 1);
        assert!(!task.is_finished());
    }
    handler.release.notify_one();
    finish(&mut client, body).await;
    task.await.unwrap().unwrap();
    assert_eq!(handler.active.load(Ordering::SeqCst), 0);
}
#[tokio::test(start_paused = true)]
async fn eof_releases_pending_future_and_its_activity_timer_without_replay() {
    let handler = Arc::new(Handler::default());
    let (mut client, task) = spawn_duplex(handler.clone());
    started(&mut client).await;
    handler.entered.notified().await;
    drop(client);
    assert!(task.await.unwrap().is_err());
    assert_eq!(handler.active.load(Ordering::SeqCst), 0);
    tokio::time::advance(Duration::from_secs(60)).await;
    assert_eq!(handler.calls.load(Ordering::SeqCst), 1);
}

struct FailedWrite {
    writes: usize,
    stall: bool,
}
impl AsyncRead for FailedWrite {
    fn poll_read(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        _: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Poll::Pending
    }
}
impl AsyncWrite for FailedWrite {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.writes == 0 {
            self.writes += 1;
            return Poll::Ready(Ok(bytes.len()));
        }
        if self.stall {
            Poll::Pending
        } else {
            Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()))
        }
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}
#[tokio::test(start_paused = true)]
async fn heartbeat_write_error_or_deadline_drops_the_same_pending_operation() {
    for stall in [false, true] {
        let handler = Arc::new(Handler::default());
        let task = tokio::spawn(serve(
            FailedWrite { writes: 0, stall },
            "HTTP/1.1",
            handler.clone(),
            TOKEN,
            json!({}),
            opaque_cors(),
        ));
        handler.entered.notified().await;
        tokio::time::advance(HEARTBEAT).await;
        assert!(task.await.unwrap().is_err());
        assert_eq!(handler.active.load(Ordering::SeqCst), 0);
        assert_eq!(handler.calls.load(Ordering::SeqCst), 1);
    }
}
async fn connect(
    server: &BridgeServer,
    namespace: &str,
    version: &str,
    token: &str,
    body: &str,
) -> TcpStream {
    connect_origin(server, namespace, version, token, body, "null").await
}
async fn connect_origin(
    server: &BridgeServer,
    namespace: &str,
    version: &str,
    token: &str,
    body: &str,
    origin: &str,
) -> TcpStream {
    let host = server.origin.strip_prefix("http://").unwrap();
    let mut stream = TcpStream::connect(host).await.unwrap();
    stream.write_all(format!("POST /{namespace}/{token} {version}\r\nHost: {host}\r\nOrigin: {origin}\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    stream
}
struct ExactHandler {
    inner: Arc<Handler>,
    policy: crate::plugin_loopback::OriginPolicy,
}
#[async_trait]
impl RequestHandler for ExactHandler {
    fn authenticated(&self, token: &str) -> bool {
        self.inner.authenticated(token)
    }
    fn origin_policy(&self, _: &str) -> crate::plugin_loopback::OriginPolicy {
        self.policy.clone()
    }
    async fn handle(&self, token: &str, request: Value) -> Result<Value, String> {
        self.inner.handle(token, request).await
    }
}
const EXACT_ORIGIN: &str = "atools-page://main-12345678123442349234123456789abc.localhost";
async fn exact_server() -> (Arc<Handler>, BridgeServer) {
    let inner = Arc::new(Handler::default());
    let handler = Arc::new(ExactHandler {
        inner: inner.clone(),
        policy: crate::plugin_loopback::OriginPolicy::exact(EXACT_ORIGIN).unwrap(),
    });
    let server = BridgeServer::start_scoped(handler, "dialog").await.unwrap();
    (inner, server)
}
#[tokio::test]
async fn exact_dialog_cors_is_verified_before_activity_and_keeps_one_pending_operation() {
    let (handler, server) = exact_server().await;
    let mut rejected = connect_origin(&server, "dialog", "HTTP/1.1", TOKEN, "{}", "null").await;
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(1), rejected.read_to_end(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    let rejected = String::from_utf8(bytes).unwrap();
    assert!(rejected.starts_with("HTTP/1.1 400"));
    assert!(!rejected.contains("Access-Control-Allow-Origin:"));
    assert_eq!(handler.calls.load(Ordering::SeqCst), 0);

    let mut stream = connect_origin(&server, "dialog", "HTTP/1.1", TOKEN, "{}", EXACT_ORIGIN).await;
    let (headers, mut body) = started(&mut stream).await;
    assert!(headers.contains(&format!("Access-Control-Allow-Origin: {EXACT_ORIGIN}\r\n")));
    assert!(!headers.contains("Access-Control-Allow-Origin: null"));
    assert!(!headers.contains("Access-Control-Allow-Origin: *"));
    handler.entered.notified().await;
    let mut byte = [0];
    tokio::time::timeout(Duration::from_secs(3), stream.read_exact(&mut byte))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(byte, [b' ']);
    body.extend(byte);
    assert_eq!(handler.calls.load(Ordering::SeqCst), 1);
    assert_eq!(handler.active.load(Ordering::SeqCst), 1);
    handler.release.notify_one();
    finish(&mut stream, body).await;
    assert_eq!(handler.calls.load(Ordering::SeqCst), 1);
    assert_eq!(handler.active.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn exact_dialog_eof_still_drops_its_single_operation_without_replay() {
    let (handler, server) = exact_server().await;
    let mut stream = connect_origin(&server, "dialog", "HTTP/1.1", TOKEN, "{}", EXACT_ORIGIN).await;
    started(&mut stream).await;
    handler.entered.notified().await;
    drop(stream);
    tokio::time::timeout(Duration::from_secs(1), handler.dropped.notified())
        .await
        .unwrap();
    assert_eq!(handler.calls.load(Ordering::SeqCst), 1);
    assert_eq!(handler.active.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn actual_socket_emits_activity_then_one_json_with_both_http_versions() {
    for version in ["HTTP/1.1", "HTTP/1.0"] {
        let handler = Arc::new(Handler::default());
        let server = BridgeServer::start_scoped(handler.clone(), "dialog")
            .await
            .unwrap();
        let mut stream = connect(&server, "dialog", version, TOKEN, "{}").await;
        let (headers, mut body) = started(&mut stream).await;
        assert!(headers.starts_with(&format!("{version} 200 ")));
        handler.entered.notified().await;
        if version == "HTTP/1.1" {
            let mut byte = [0];
            tokio::time::timeout(Duration::from_secs(3), stream.read_exact(&mut byte))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(byte, [b' ']);
            body.extend(byte);
        }
        handler.release.notify_one();
        finish(&mut stream, body).await;
        assert_eq!(handler.calls.load(Ordering::SeqCst), 1);
        assert_eq!(handler.active.load(Ordering::SeqCst), 0);
    }
}
#[tokio::test]
async fn unauthenticated_or_invalid_json_never_starts_stream_or_handler() {
    let handler = Arc::new(Handler::default());
    let server = BridgeServer::start_scoped(handler.clone(), "dialog")
        .await
        .unwrap();
    for (token, body, status) in [
        (
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "{}",
            "401",
        ),
        (TOKEN, "{", "400"),
    ] {
        let mut stream = connect(&server, "dialog", "HTTP/1.1", token, body).await;
        let mut bytes = Vec::new();
        tokio::time::timeout(Duration::from_secs(1), stream.read_to_end(&mut bytes))
            .await
            .unwrap()
            .unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.starts_with(&format!("HTTP/1.1 {status}")));
        assert!(text.contains("Content-Length:"));
        assert_eq!(handler.calls.load(Ordering::SeqCst), 0);
    }
}
#[tokio::test]
async fn non_dialog_connections_still_end_at_eight_seconds_without_activity_body() {
    let handler = Arc::new(Handler::default());
    let server = BridgeServer::start_scoped(handler.clone(), "node")
        .await
        .unwrap();
    let mut stream = connect(&server, "node", "HTTP/1.1", TOKEN, "{}").await;
    handler.entered.notified().await;
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(9), stream.read_to_end(&mut response))
        .await
        .unwrap()
        .unwrap();
    assert!(response.is_empty());
    assert_eq!(handler.calls.load(Ordering::SeqCst), 1);
    assert_eq!(handler.active.load(Ordering::SeqCst), 0);
}
#[test]
fn whitespace_allowance_keeps_the_final_json_within_the_existing_body_budget() {
    let bytes = result_body(Ok(json!({"oversized":"x".repeat(MAX_BODY)}))).unwrap();
    assert!(bytes.len() + WHITESPACE_BUDGET <= MAX_BODY);
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap()["ok"],
        false
    );
}
