use super::http::{BridgeServer, RequestHandler};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Notify;

const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const UNKNOWN_TOKEN: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MAX_BODY: usize = 1024 * 1024;

#[derive(Default)]
struct FakeHandler {
    calls: AtomicUsize,
    active: AtomicUsize,
    blocked: AtomicBool,
    entered: Notify,
    release: Notify,
    large_response: AtomicBool,
}

struct ActiveCall<'a>(&'a AtomicUsize);
impl Drop for ActiveCall<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[async_trait]
impl RequestHandler for FakeHandler {
    fn authenticated(&self, token: &str) -> bool {
        token == TOKEN
    }

    async fn handle(&self, token: &str, request: Value) -> Result<Value, String> {
        assert_eq!(token, TOKEN);
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.active.fetch_add(1, Ordering::SeqCst);
        let _active = ActiveCall(&self.active);
        self.entered.notify_one();
        if self.blocked.load(Ordering::SeqCst) {
            self.release.notified().await;
        }
        if self.large_response.load(Ordering::SeqCst) {
            Ok(json!("x".repeat(MAX_BODY + 1)))
        } else {
            Ok(request)
        }
    }
}

async fn server() -> (BridgeServer, Arc<FakeHandler>, String) {
    let handler = Arc::new(FakeHandler::default());
    let server = BridgeServer::start(handler.clone()).await.unwrap();
    let host = server.origin.strip_prefix("http://").unwrap().to_string();
    assert!(host.starts_with("127.0.0.1:"));
    (server, handler, host)
}

fn post(host: &str, token: &str, extra_headers: &str, body: &str) -> Vec<u8> {
    format!("POST /node/{token} HTTP/1.1\r\nHost: {host}\r\nContent-Length: {}\r\n{extra_headers}\r\n{body}", body.len()).into_bytes()
}

async fn exchange(host: &str, request: &[u8]) -> Vec<u8> {
    let mut stream = TcpStream::connect(host).await.unwrap();
    stream.write_all(request).await.unwrap();
    let mut response = Vec::new();
    if let Err(error) =
        tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut response))
            .await
            .expect("HTTP request did not finish promptly")
    {
        // Rejecting oversized headers can close the socket with unread peer bytes.
        // Still require a complete framed HTTP response below; never hide truncation.
        assert!(
            error.kind() == std::io::ErrorKind::ConnectionReset && !response.is_empty(),
            "{error}"
        );
    }
    response
}

fn response(bytes: &[u8]) -> (u16, String, Value) {
    let text = std::str::from_utf8(bytes).unwrap();
    let (headers, body) = text.split_once("\r\n\r\n").unwrap();
    let status = headers
        .lines()
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let length: usize = headers
        .lines()
        .find_map(|line| line.strip_prefix("Content-Length: "))
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(
        body.len(),
        length,
        "response body must match Content-Length"
    );
    (
        status,
        headers.to_string(),
        serde_json::from_str(body).unwrap(),
    )
}

fn assert_rejected(bytes: &[u8], status: u16) {
    let (actual, headers, body) = response(bytes);
    assert_eq!(actual, status);
    assert_eq!(body["ok"], false);
    assert!(!headers.contains("Access-Control-Allow-Origin"));
}

#[tokio::test]
async fn opaque_origin_is_authenticated_and_cors_is_not_an_authorization_shortcut() {
    let (_server, handler, host) = server().await;
    let (status, headers, body) = response(
        &exchange(
            &host,
            &post(
                &host,
                TOKEN,
                "Origin: null\r\nContent-Type: application/json\r\n",
                "{\"value\":42}",
            ),
        )
        .await,
    );
    assert_eq!(status, 200);
    assert!(headers.contains("Access-Control-Allow-Origin: null\r\n"));
    assert!(headers.contains("Cache-Control: no-store"));
    assert_eq!(body, json!({"ok":true,"result":{"value":42}}));
    assert_rejected(
        &exchange(&host, &post(&host, UNKNOWN_TOKEN, "Origin: null\r\n", "{}")).await,
        401,
    );
    assert_rejected(
        &exchange(&host, &post(&host, "invalid", "Origin: null\r\n", "{}")).await,
        400,
    );
    assert_eq!(handler.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn native_clients_may_omit_origin_but_normal_web_origins_are_rejected() {
    let (_server, handler, host) = server().await;
    assert_eq!(
        response(&exchange(&host, &post(&host, TOKEN, "", "{}")).await).0,
        200
    );
    for origin in [
        "https://example.com",
        "http://127.0.0.1",
        "http://localhost:1420",
        "Null",
    ] {
        assert_rejected(
            &exchange(
                &host,
                &post(&host, TOKEN, &format!("Origin: {origin}\r\n"), "{}"),
            )
            .await,
            400,
        );
    }
    assert_eq!(handler.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn exact_bound_host_rejects_rebinding_aliases_ports_and_duplicate_security_headers() {
    let (_server, handler, host) = server().await;
    let port = host.split(':').nth(1).unwrap();
    for other in [
        format!("attacker.example:{port}"),
        format!("localhost:{port}"),
        "127.0.0.1".into(),
        "127.0.0.1:1".into(),
    ] {
        assert_rejected(
            &exchange(&host, &post(&other, TOKEN, "Origin: null\r\n", "{}")).await,
            400,
        );
    }
    for duplicate in [
        format!("hOsT: {host}\r\n"),
        "content-LENGTH: 2\r\n".into(),
        "Origin: null\r\noRiGiN: null\r\n".into(),
        "Transfer-Encoding: chunked\r\n".into(),
    ] {
        assert_rejected(
            &exchange(&host, &post(&host, TOKEN, &duplicate, "{}")).await,
            400,
        );
    }
    assert_eq!(handler.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn authenticated_preflight_allows_only_the_documented_method_headers_and_private_network() {
    let (_server, handler, host) = server().await;
    let preflight = |token| {
        format!("OPTIONS /node/{token} HTTP/1.1\r\nHost: {host}\r\nOrigin: null\r\nAccess-Control-Request-Method: POST\r\nAccess-Control-Request-Headers: content-type\r\nAccess-Control-Request-Private-Network: true\r\n\r\n")
    };
    let (status, headers, body) = response(&exchange(&host, preflight(TOKEN).as_bytes()).await);
    assert_eq!(status, 200);
    assert_eq!(body, Value::Null);
    assert!(headers.contains("Access-Control-Allow-Origin: null"));
    assert!(headers.contains("Access-Control-Allow-Methods: POST, OPTIONS"));
    assert!(headers.contains("Access-Control-Allow-Headers: Content-Type"));
    assert!(headers.contains("Access-Control-Allow-Private-Network: true"));
    assert_rejected(
        &exchange(&host, preflight(UNKNOWN_TOKEN).as_bytes()).await,
        401,
    );
    assert_eq!(handler.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn content_length_and_utf8_body_are_read_across_multiple_tcp_fragments() {
    let (_server, handler, host) = server().await;
    let body = json!({"text":"站酷 🧰".repeat(1500)}).to_string();
    let raw = post(&host, TOKEN, "Origin: null\r\n", &body);
    let mut stream = TcpStream::connect(&host).await.unwrap();
    for chunk in raw.chunks(997) {
        stream.write_all(chunk).await.unwrap();
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        response(&bytes).2,
        json!({"ok":true,"result":serde_json::from_str::<Value>(&body).unwrap()})
    );
    assert_eq!(handler.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn malformed_framing_and_header_body_size_limits_never_reach_the_handler() {
    let (_server, handler, host) = server().await;
    let oversized_body = format!(
        "POST /node/{TOKEN} HTTP/1.1\r\nHost: {host}\r\nContent-Length: {}\r\n\r\n",
        MAX_BODY + 1
    );
    assert_rejected(&exchange(&host, oversized_body.as_bytes()).await, 400);
    let headers = format!("X-Padding: {}\r\n", "x".repeat(17 * 1024));
    assert_rejected(
        &exchange(&host, &post(&host, TOKEN, &headers, "{}")).await,
        400,
    );
    for length in ["-1", "bogus", "184467440737095516160"] {
        let raw = format!(
            "POST /node/{TOKEN} HTTP/1.1\r\nHost: {host}\r\nContent-Length: {length}\r\n\r\n"
        );
        assert_rejected(&exchange(&host, raw.as_bytes()).await, 400);
    }
    let missing = format!("POST /node/{TOKEN} HTTP/1.1\r\nHost: {host}\r\n\r\n");
    assert_rejected(&exchange(&host, missing.as_bytes()).await, 400);
    assert_eq!(handler.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn invalid_json_and_oversized_responses_report_errors_with_bounded_bodies() {
    let (_server, handler, host) = server().await;
    let (status, headers, body) =
        response(&exchange(&host, &post(&host, TOKEN, "Origin: null\r\n", "not-json")).await);
    assert_eq!(status, 400);
    assert!(headers.contains("Access-Control-Allow-Origin: null"));
    assert_eq!(body["ok"], false);
    assert_eq!(handler.calls.load(Ordering::SeqCst), 0);
    handler.large_response.store(true, Ordering::SeqCst);
    let raw = exchange(&host, &post(&host, TOKEN, "Origin: null\r\n", "{}")).await;
    assert!(raw.len() < 2048);
    assert_eq!(
        response(&raw).2["error"]["message"],
        "Response exceeds 1 MiB"
    );
}

#[tokio::test]
async fn dropping_server_stops_accepted_connections_and_in_flight_handlers() {
    let (server, handler, host) = server().await;
    handler.blocked.store(true, Ordering::SeqCst);
    let request_host = host.clone();
    let request = tokio::spawn(async move {
        let mut stream = TcpStream::connect(&request_host).await.unwrap();
        stream
            .write_all(&post(&request_host, TOKEN, "Origin: null\r\n", "{}"))
            .await
            .unwrap();
        let mut bytes = Vec::new();
        let _ = stream.read_to_end(&mut bytes).await;
        bytes
    });
    tokio::time::timeout(Duration::from_secs(1), handler.entered.notified())
        .await
        .unwrap();
    assert_eq!(handler.active.load(Ordering::SeqCst), 1);
    drop(server);
    tokio::time::timeout(Duration::from_secs(1), async {
        while handler.active.load(Ordering::SeqCst) != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("server drop must cancel its existing handler tasks");
    let bytes = tokio::time::timeout(Duration::from_secs(1), request)
        .await
        .unwrap()
        .unwrap();
    assert!(bytes.is_empty());
    assert!(
        TcpStream::connect(&host).await.is_err(),
        "listener must close on drop"
    );
}

#[tokio::test]
async fn more_than_sixteen_concurrent_requests_are_rejected_without_starting_more_handlers() {
    let (_server, handler, host) = server().await;
    handler.blocked.store(true, Ordering::SeqCst);
    let mut connections = Vec::new();
    for _ in 0..16 {
        let mut stream = TcpStream::connect(&host).await.unwrap();
        stream
            .write_all(&post(&host, TOKEN, "Origin: null\r\n", "{}"))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), handler.entered.notified())
            .await
            .unwrap();
        connections.push(stream);
    }
    assert_eq!(handler.calls.load(Ordering::SeqCst), 16);
    let mut excess = TcpStream::connect(&host).await.unwrap();
    let _ = excess
        .write_all(&post(&host, TOKEN, "Origin: null\r\n", "{}"))
        .await;
    let mut bytes = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(1), excess.read_to_end(&mut bytes))
        .await
        .expect("over-capacity connection must close promptly");
    assert!(bytes.is_empty() || bytes.starts_with(b"HTTP/1.1 503"));
    assert_eq!(handler.calls.load(Ordering::SeqCst), 16);
    handler.release.notify_waiters();
    drop(connections);
}

#[tokio::test]
async fn slow_or_incomplete_connections_expire_without_handler_execution() {
    let (_server, handler, host) = server().await;
    let mut stream = TcpStream::connect(&host).await.unwrap();
    stream.write_all(b"P").await.unwrap();
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), stream.read_to_end(&mut bytes))
        .await
        .expect("partial headers must expire within the connection limit")
        .unwrap();
    // The framing and connection deadlines both expire at eight seconds. Either
    // the outer deadline closes silently or the framing deadline returns 400.
    if !bytes.is_empty() {
        assert_rejected(&bytes, 400);
    }
    assert_eq!(handler.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn namespaces_never_accept_credentials_at_another_runtime_route() {
    let node_handler = Arc::new(FakeHandler::default());
    let host_handler = Arc::new(FakeHandler::default());
    let node = BridgeServer::start(node_handler.clone()).await.unwrap();
    let host = BridgeServer::start_scoped(host_handler.clone(), "host")
        .await
        .unwrap();
    let node_address = node.origin.strip_prefix("http://").unwrap();
    let host_address = host.origin.strip_prefix("http://").unwrap();
    let node_route_on_host = post(host_address, TOKEN, "Origin: null\r\n", "{}");
    assert_rejected(&exchange(host_address, &node_route_on_host).await, 400);
    let host_route_on_node = String::from_utf8(post(node_address, TOKEN, "Origin: null\r\n", "{}"))
        .unwrap()
        .replacen("/node/", "/host/", 1);
    assert_rejected(
        &exchange(node_address, host_route_on_node.as_bytes()).await,
        400,
    );
    // Even the exact same credential is insufficient at the wrong namespace.
    assert_eq!(node_handler.calls.load(Ordering::SeqCst), 0);
    assert_eq!(host_handler.calls.load(Ordering::SeqCst), 0);
    let valid_host = String::from_utf8(post(host_address, TOKEN, "Origin: null\r\n", "{}"))
        .unwrap()
        .replacen("/node/", "/host/", 1);
    assert_eq!(
        response(&exchange(host_address, valid_host.as_bytes()).await).2["ok"],
        true
    );
    assert_eq!(host_handler.calls.load(Ordering::SeqCst), 1);
}
