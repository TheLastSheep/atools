//! Bounded opaque-frame loopback transport shared by private plugin capabilities.
#[path = "plugin_loopback_dialog.rs"]
mod dialog;
#[path = "plugin_loopback_origin.rs"]
mod origin;
use async_trait::async_trait;
pub use origin::OriginPolicy;
use origin::VerifiedCorsOrigin;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;

const MAX_BODY: usize = 1024 * 1024;
const MAX_HEADERS: usize = 16 * 1024;

#[cfg(any(test, feature = "legacy-node-smoke"))]
#[doc(hidden)]
pub enum TransportObservation {
    AuthenticationRejected,
    OriginRejected,
    PreflightAccepted,
    RequestStart,
    ReadEof,
    ReadExtraBytes,
    ReadErrorKind(std::io::ErrorKind),
    HandlerComplete,
}

#[async_trait]
pub trait RequestHandler: Send + Sync {
    async fn handle(&self, token: &str, request: Value) -> Result<Value, String>;
    fn authenticated(&self, token: &str) -> bool;
    /// An optional token-scoped raw UTF-8 request-body cap. The transport still
    /// applies its global maximum and checks Content-Length before reading body.
    fn max_request_body_bytes(&self, _token: &str) -> Option<usize> {
        None
    }
    /// Select only this token's immutable owner/generation policy. A missing
    /// Exact owner is never Opaque authority; handle must recheck revocation
    /// before execution because these transport checks are not an atomic grant.
    fn origin_policy(&self, _token: &str) -> OriginPolicy {
        OriginPolicy::Opaque
    }
    #[cfg(any(test, feature = "legacy-node-smoke"))]
    fn observe_transport(&self, _event: TransportObservation) {}
}

pub struct BridgeServer {
    pub origin: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for BridgeServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl BridgeServer {
    pub async fn start(handler: Arc<dyn RequestHandler>) -> Result<Self, String> {
        Self::start_scoped(handler, "node").await
    }
    pub async fn start_scoped(
        handler: Arc<dyn RequestHandler>,
        namespace: &'static str,
    ) -> Result<Self, String> {
        if !matches!(
            namespace,
            "node" | "host" | "data" | "dialog" | "display" | "secrets" | "file-drag"
        ) {
            return Err("Invalid transport namespace".into());
        }
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| e.to_string())?;
        let address = listener.local_addr().map_err(|e| e.to_string())?;
        let host = address.to_string();
        let origin = format!("http://{host}");
        let slots = Arc::new(Semaphore::new(16));
        let task = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((stream, peer)) = accepted else { break };
                        if !peer.ip().is_loopback() { continue; }
                        let Ok(permit) = slots.clone().try_acquire_owned() else { continue };
                        let handler = handler.clone();
                        let host = host.clone();
                        connections.spawn(async move {
                            let _permit = permit;
                            let deadline = if namespace == "dialog" { 128 } else { 8 };
                            let _ = tokio::time::timeout(Duration::from_secs(deadline), serve(stream, &host, namespace, handler)).await;
                        });
                    },
                    _ = connections.join_next(), if !connections.is_empty() => {}
                }
            }
        });
        Ok(Self { origin, task })
    }
}

struct Request {
    method: String,
    version: String,
    token: String,
    origin: Option<String>,
    body: Vec<u8>,
}
async fn read_request(
    stream: &mut TcpStream,
    expected_host: &str,
    namespace: &str,
    handler: &dyn RequestHandler,
) -> Result<Request, String> {
    let mut data = Vec::with_capacity(4096);
    let header_end = loop {
        if let Some(index) = data.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
        if data.len() >= MAX_HEADERS {
            return Err("Headers exceed limit".into());
        }
        let mut chunk = [0; 4096];
        let read = stream.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if read == 0 {
            return Err("Incomplete headers".into());
        }
        data.extend_from_slice(&chunk[..read]);
    };
    if header_end > MAX_HEADERS {
        return Err("Headers exceed limit".into());
    }
    let header = std::str::from_utf8(&data[..header_end]).map_err(|_| "Invalid headers")?;
    let mut lines = header.split("\r\n");
    let first = lines.next().ok_or("Missing request line")?;
    let parts: Vec<_> = first.split(' ').collect();
    if parts.len() != 3 || !matches!(parts[2], "HTTP/1.1" | "HTTP/1.0") {
        return Err("Invalid request line".into());
    }
    if !matches!(parts[0], "POST" | "OPTIONS") {
        return Err("Method not allowed".into());
    }
    let token = parts[1]
        .strip_prefix(&format!("/{namespace}/"))
        .ok_or("Invalid endpoint")?;
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid credential".into());
    }
    let mut host = None;
    let mut length = None;
    let mut origin = None;
    for line in lines.filter(|line| !line.is_empty()) {
        let (key, value) = line.split_once(':').ok_or("Invalid header")?;
        let value = value.trim();
        if key.eq_ignore_ascii_case("host") {
            if host.replace(value).is_some() {
                return Err("Duplicate host".into());
            }
        } else if key.eq_ignore_ascii_case("content-length") {
            if length.is_some() {
                return Err("Duplicate length".into());
            }
            length = Some(value.parse::<usize>().map_err(|_| "Invalid length")?);
        } else if key.eq_ignore_ascii_case("transfer-encoding") {
            return Err("Chunked requests are not supported".into());
        } else if key.eq_ignore_ascii_case("origin") {
            if value.len() > 128 {
                return Err("Origin exceeds limit".into());
            }
            if origin.replace(value).is_some() {
                return Err("Duplicate origin".into());
            }
        }
    }
    if host != Some(expected_host) {
        return Err("Unexpected host".into());
    }
    // Matching is deferred until authentication selects the immutable session
    // policy. Host, token framing and duplicate security headers remain strict.
    let method = parts[0].to_string();
    let version = parts[2].to_string();
    let token = token.to_string();
    let origin = origin.map(str::to_owned);
    let length = if method == "OPTIONS" {
        length.unwrap_or(0)
    } else {
        length.ok_or("Missing length")?
    };
    let body_limit = handler
        .max_request_body_bytes(&token)
        .unwrap_or(MAX_BODY)
        .min(MAX_BODY);
    if length > body_limit {
        return Err("Body exceeds limit".into());
    }
    while data.len() - header_end < length {
        let remaining = length - (data.len() - header_end);
        let mut chunk = vec![0; remaining.min(8192)];
        let read = stream.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if read == 0 {
            return Err("Incomplete body".into());
        }
        data.extend_from_slice(&chunk[..read]);
    }
    Ok(Request {
        method,
        version,
        token,
        origin,
        body: data[header_end..header_end + length].to_vec(),
    })
}
async fn serve(
    mut stream: TcpStream,
    host: &str,
    namespace: &str,
    handler: Arc<dyn RequestHandler>,
) -> Result<(), String> {
    let request = match tokio::time::timeout(
        Duration::from_secs(8),
        read_request(&mut stream, host, namespace, handler.as_ref()),
    )
    .await
    {
        Ok(Ok(request)) => request,
        _ => {
            return respond(
                &mut stream,
                400,
                None,
                json!({"ok":false,"error":{"message":"Invalid request"}}),
            )
            .await
        }
    };
    if !handler.authenticated(&request.token) {
        #[cfg(any(test, feature = "legacy-node-smoke"))]
        handler.observe_transport(TransportObservation::AuthenticationRejected);
        return respond(
            &mut stream,
            401,
            None,
            json!({"ok":false,"error":{"message":"Session unavailable"}}),
        )
        .await;
    }
    let policy = handler.origin_policy(&request.token);
    let Some(cors) = policy.authorize(request.origin.as_deref()) else {
        #[cfg(any(test, feature = "legacy-node-smoke"))]
        handler.observe_transport(TransportObservation::OriginRejected);
        return respond(
            &mut stream,
            400,
            None,
            json!({"ok":false,"error":{"message":"Unexpected origin"}}),
        )
        .await;
    };
    if request.method == "OPTIONS" {
        #[cfg(any(test, feature = "legacy-node-smoke"))]
        handler.observe_transport(TransportObservation::PreflightAccepted);
        return respond(&mut stream, 200, Some(cors), Value::Null).await;
    }
    let payload = match serde_json::from_slice(&request.body) {
        Ok(payload) => payload,
        Err(_) => {
            return respond(
                &mut stream,
                400,
                Some(cors),
                json!({"ok":false,"error":{"message":"Invalid JSON"}}),
            )
            .await
        }
    };
    if namespace == "dialog" {
        return dialog::serve(
            stream,
            &request.version,
            handler,
            &request.token,
            payload,
            cors,
        )
        .await;
    }
    let result = handler.handle(&request.token, payload).await;
    let value = match result {
        Ok(result) => json!({"ok":true,"result":result}),
        Err(message) => json!({"ok":false,"error":{"message":message}}),
    };
    respond(&mut stream, 200, Some(cors), value).await
}
async fn respond(
    stream: &mut TcpStream,
    status: u16,
    cors: Option<VerifiedCorsOrigin<'_>>,
    value: Value,
) -> Result<(), String> {
    let mut body = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
    if body.len() > MAX_BODY {
        body = br#"{"ok":false,"error":{"message":"Response exceeds 1 MiB"}}"#.to_vec();
    }
    let cors = cors.unwrap_or_default();
    let headers = format!("HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n{cors}\r\n", body.len());
    stream
        .write_all(headers.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stream.write_all(&body).await.map_err(|e| e.to_string())?;
    stream.shutdown().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod request_body_limit_tests {
    use super::*;
    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    struct LimitedHandler(Option<usize>);
    #[async_trait]
    impl RequestHandler for LimitedHandler {
        async fn handle(&self, _: &str, _: Value) -> Result<Value, String> {
            Ok(Value::Null)
        }
        fn authenticated(&self, _: &str) -> bool {
            true
        }
        fn max_request_body_bytes(&self, _: &str) -> Option<usize> {
            self.0
        }
    }

    async fn read_wire_body(
        limit: Option<usize>,
        body_len: usize,
        transmit_body: bool,
    ) -> Result<usize, String> {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let host = address.to_string();
        let client_host = host.clone();
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(address).await.unwrap();
            let headers = format!(
                "POST /host/{TOKEN} HTTP/1.1\r\nHost: {client_host}\r\nContent-Length: {body_len}\r\n\r\n"
            );
            stream.write_all(headers.as_bytes()).await.unwrap();
            if transmit_body {
                stream.write_all(&vec![b' '; body_len]).await.unwrap();
            }
            stream.shutdown().await.unwrap();
        });
        let (mut stream, _) = listener.accept().await.unwrap();
        let handler = LimitedHandler(limit);
        let result = read_request(&mut stream, &host, "host", &handler)
            .await
            .map(|request| request.body.len());
        client.await.unwrap();
        result
    }

    #[tokio::test]
    async fn raw_image_envelope_limit_counts_whitespace_and_keeps_other_routes_at_one_mib() {
        let image_limit = 700 * 1024;
        assert_eq!(
            read_wire_body(Some(image_limit), image_limit, true)
                .await
                .unwrap(),
            image_limit
        );
        assert_eq!(
            read_wire_body(Some(image_limit), image_limit + 1, false)
                .await
                .unwrap_err(),
            "Body exceeds limit"
        );
        let ordinary_body = image_limit + 1;
        assert_eq!(
            read_wire_body(None, ordinary_body, true).await.unwrap(),
            ordinary_body
        );
        assert_eq!(
            read_wire_body(None, MAX_BODY + 1, false).await.unwrap_err(),
            "Body exceeds limit"
        );
    }
}
