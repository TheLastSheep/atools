//! Policy and actual local TCP framing only; no plugin or native window executes.
use super::*;
use crate::plugin_loopback::{BridgeServer, RequestHandler, TransportObservation};
use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEXT_TOKEN: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ORIGIN: &str = "atools-page://main-12345678123442349234123456789abc.localhost";
const NEXT_ORIGIN: &str = "atools-page://main-8765432187654321987687654321abcd.localhost";

#[test]
fn exact_constructor_accepts_only_canonical_generated_instance_origins() {
    for scheme in ["atools-page", "atools-plugin", "atools-origin"] {
        for host in [
            "main-12345678123442349234123456789abc.localhost",
            "12345678123442349234123456789abc.localhost",
        ] {
            let origin = format!("{scheme}://{host}");
            assert!(OriginPolicy::exact(&origin).is_ok(), "{origin}");
        }
    }
    for origin in [
        "https://main-12345678123442349234123456789abc.localhost",
        "atools-page://main.localhost",
        "atools-page://-12345678123442349234123456789abc.localhost",
        "atools-page://main--12345678123442349234123456789abc.localhost",
        "atools-page://MAIN-12345678123442349234123456789abc.localhost",
        "atools-page://main-12345678123442349234123456789ABC.localhost",
        "atools-page://main-00000000000000000000000000000000.localhost",
        "atools-page://abcdefghijklmnopqrstuvwxy-12345678123442349234123456789abc.localhost",
        "atools-page://main-12345678123442349234123456789abc.localhost.evil",
        "atools-page://main-12345678123442349234123456789abc.localhost.",
        "atools-page://main-12345678123442349234123456789abc.localhost:80",
        "atools-page://user@main-12345678123442349234123456789abc.localhost",
        "atools-page://main-12345678123442349234123456789abc.localhost/",
        "atools-page://main-12345678123442349234123456789abc.localhost/path",
        "atools-page://main-12345678123442349234123456789abc.localhost?query",
        "atools-page://main-12345678123442349234123456789abc.localhost#fragment",
        " atools-page://main-12345678123442349234123456789abc.localhost",
        "atools-page://main-12345678123442349234123456789abc.localhost\r\nInjected: yes",
    ] {
        assert!(OriginPolicy::exact(origin).is_err(), "{origin}");
    }
}

#[test]
fn policy_matching_keeps_opaque_native_compatibility_and_exact_never_downgrades() {
    assert_eq!(OriginPolicy::default(), OriginPolicy::Opaque);
    let opaque = OriginPolicy::Opaque;
    for origin in [None, Some("null"), Some(ORIGIN)] {
        assert!(OriginPolicy::Deny.authorize(origin).is_none());
    }
    for origin in [None, Some("null")] {
        let verified = opaque.authorize(origin).unwrap();
        assert!(verified
            .to_string()
            .starts_with("Access-Control-Allow-Origin: null\r\n"));
    }
    let exact = OriginPolicy::exact(ORIGIN).unwrap();
    let headers = exact.authorize(Some(ORIGIN)).unwrap().to_string();
    assert!(headers.starts_with(&format!("Access-Control-Allow-Origin: {ORIGIN}\r\n")));
    assert!(headers.contains("Vary: Origin\r\n"));
    assert!(!headers.contains('*'));
    for origin in [
        None,
        Some("null"),
        Some("Null"),
        Some(""),
        Some(NEXT_ORIGIN),
        Some("https://example.com"),
    ] {
        assert!(exact.authorize(origin).is_none(), "{origin:?}");
    }
    for origin in [Some(ORIGIN), Some("Null"), Some("https://example.com")] {
        assert!(OriginPolicy::Opaque.authorize(origin).is_none());
    }
}

#[derive(Default)]
struct OpaqueHandler(AtomicUsize);
#[async_trait]
impl RequestHandler for OpaqueHandler {
    fn authenticated(&self, token: &str) -> bool {
        token == TOKEN
    }
    async fn handle(&self, _: &str, _: Value) -> Result<Value, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(json!({"scope":"synthetic"}))
    }
}
struct ExactHandler {
    current: Mutex<(&'static str, OriginPolicy)>,
    calls: AtomicUsize,
    policy_reads: AtomicUsize,
    gates: GateCounts,
}
#[derive(Default)]
struct GateCounts {
    authentication_rejected: AtomicUsize,
    origin_rejected: AtomicUsize,
    preflight_accepted: AtomicUsize,
}
impl ExactHandler {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            current: Mutex::new((TOKEN, OriginPolicy::exact(ORIGIN).unwrap())),
            calls: AtomicUsize::new(0),
            policy_reads: AtomicUsize::new(0),
            gates: GateCounts::default(),
        })
    }
}
#[async_trait]
impl RequestHandler for ExactHandler {
    fn observe_transport(&self, event: TransportObservation) {
        let counter = match event {
            TransportObservation::AuthenticationRejected => &self.gates.authentication_rejected,
            TransportObservation::OriginRejected => &self.gates.origin_rejected,
            TransportObservation::PreflightAccepted => &self.gates.preflight_accepted,
            _ => return,
        };
        counter.fetch_add(1, Ordering::SeqCst);
    }
    fn authenticated(&self, token: &str) -> bool {
        self.current.lock().0 == token
    }
    fn origin_policy(&self, _: &str) -> OriginPolicy {
        self.policy_reads.fetch_add(1, Ordering::SeqCst);
        self.current.lock().1.clone()
    }
    async fn handle(&self, token: &str, _: Value) -> Result<Value, String> {
        if self.current.lock().0 != token {
            return Err("Synthetic owner was revoked before execution".into());
        }
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(json!({"scope":"synthetic"}))
    }
}
fn request(
    host: &str,
    namespace: &str,
    token: &str,
    method: &str,
    headers: &str,
    body: &str,
) -> String {
    format!("{method} /{namespace}/{token} HTTP/1.1\r\nHost: {host}\r\n{headers}Content-Length: {}\r\n\r\n{body}", body.len())
}
fn host(server: &BridgeServer) -> &str {
    server.origin.strip_prefix("http://").unwrap()
}
async fn exchange(server: &BridgeServer, request: String) -> (u16, String, Value) {
    let mut stream = TcpStream::connect(host(server)).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        stream.read_to_end(&mut bytes),
    )
    .await
    .unwrap()
    .unwrap();
    let text = String::from_utf8(bytes).unwrap();
    let (headers, body) = text.split_once("\r\n\r\n").unwrap();
    let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, headers.into(), serde_json::from_str(body).unwrap())
}
fn rejected(response: (u16, String, Value), status: u16) {
    assert_eq!(response.0, status);
    assert!(!response.1.contains("Access-Control-Allow-Origin:"));
    assert_eq!(response.2["ok"], false);
}

#[tokio::test]
async fn default_router_policy_keeps_existing_opaque_and_native_requests_only() {
    for namespace in ["node", "host", "data"] {
        let handler = Arc::new(OpaqueHandler::default());
        let server = BridgeServer::start_scoped(handler.clone(), namespace)
            .await
            .unwrap();
        assert_eq!(handler.origin_policy(TOKEN), OriginPolicy::Opaque);
        for headers in ["", "Origin: null\r\n"] {
            let response = exchange(
                &server,
                request(host(&server), namespace, TOKEN, "POST", headers, "{}"),
            )
            .await;
            assert_eq!(response.0, 200);
            assert!(response.1.contains("Access-Control-Allow-Origin: null\r\n"));
        }
        for headers in [
            format!("Origin: {ORIGIN}\r\n"),
            "Origin: https://example.com\r\n".into(),
        ] {
            rejected(
                exchange(
                    &server,
                    request(host(&server), namespace, TOKEN, "POST", &headers, "{}"),
                )
                .await,
                400,
            );
        }
        assert_eq!(handler.0.load(Ordering::SeqCst), 2);
    }
}

#[tokio::test]
async fn exact_policy_gates_post_options_json_and_rotated_tokens_before_dispatch() {
    let handler = ExactHandler::new();
    let server = BridgeServer::start_scoped(handler.clone(), "data")
        .await
        .unwrap();
    let headers = format!("Origin: {ORIGIN}\r\n");
    for method in ["POST", "OPTIONS"] {
        let response = exchange(
            &server,
            request(host(&server), "data", TOKEN, method, &headers, "{}"),
        )
        .await;
        assert_eq!(response.0, 200);
        assert!(response
            .1
            .contains(&format!("Access-Control-Allow-Origin: {ORIGIN}\r\n")));
        assert!(!response.1.contains("Access-Control-Allow-Origin: null"));
    }
    for method in ["POST", "OPTIONS"] {
        for origin in [
            None,
            Some("null"),
            Some(NEXT_ORIGIN),
            Some("https://example.com"),
        ] {
            let header = origin.map_or(String::new(), |origin| format!("Origin: {origin}\r\n"));
            rejected(
                exchange(
                    &server,
                    request(host(&server), "data", TOKEN, method, &header, "{}"),
                )
                .await,
                400,
            );
        }
    }
    rejected(
        exchange(
            &server,
            request(
                host(&server),
                "data",
                TOKEN,
                "POST",
                "",
                &json!({"expectedOrigin": ORIGIN}).to_string(),
            ),
        )
        .await,
        400,
    );
    let invalid_json = exchange(
        &server,
        request(host(&server), "data", TOKEN, "POST", &headers, "{"),
    )
    .await;
    assert_eq!(invalid_json.0, 400);
    assert!(invalid_json
        .1
        .contains(&format!("Access-Control-Allow-Origin: {ORIGIN}\r\n")));
    assert_eq!(handler.calls.load(Ordering::SeqCst), 1);

    *handler.current.lock() = (NEXT_TOKEN, OriginPolicy::exact(NEXT_ORIGIN).unwrap());
    let before = handler.policy_reads.load(Ordering::SeqCst);
    for method in ["POST", "OPTIONS"] {
        rejected(
            exchange(
                &server,
                request(host(&server), "data", TOKEN, method, &headers, "{}"),
            )
            .await,
            401,
        );
    }
    assert_eq!(
        handler.policy_reads.load(Ordering::SeqCst),
        before,
        "unknown/old tokens cannot choose an origin policy"
    );
    rejected(
        exchange(
            &server,
            request(host(&server), "data", NEXT_TOKEN, "POST", &headers, "{}"),
        )
        .await,
        400,
    );
    let response = exchange(
        &server,
        request(
            host(&server),
            "data",
            NEXT_TOKEN,
            "POST",
            &format!("Origin: {NEXT_ORIGIN}\r\n"),
            "{}",
        ),
    )
    .await;
    assert_eq!(response.0, 200);
    assert!(response
        .1
        .contains(&format!("Access-Control-Allow-Origin: {NEXT_ORIGIN}\r\n")));
    assert_eq!(handler.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn exact_policy_does_not_weaken_host_duplicate_origin_or_header_budgets() {
    let handler = ExactHandler::new();
    let server = BridgeServer::start_scoped(handler.clone(), "node")
        .await
        .unwrap();
    for (host_header, headers) in [
        (
            host(&server).to_owned(),
            format!("Origin: {ORIGIN}\r\noRiGiN: {ORIGIN}\r\n"),
        ),
        (
            host(&server).replace("127.0.0.1", "localhost"),
            format!("Origin: {ORIGIN}\r\n"),
        ),
        (
            host(&server).to_owned(),
            format!("Origin: {}\r\n", "x".repeat(129)),
        ),
    ] {
        rejected(
            exchange(
                &server,
                request(&host_header, "node", TOKEN, "POST", &headers, "{}"),
            )
            .await,
            400,
        );
    }
    assert_eq!(handler.policy_reads.load(Ordering::SeqCst), 0);
    assert_eq!(handler.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn static_gate_observations_distinguish_auth_origin_and_accepted_preflight_only() {
    let handler = ExactHandler::new();
    let server = BridgeServer::start_scoped(handler.clone(), "host")
        .await
        .unwrap();
    let valid = format!("Origin: {ORIGIN}\r\n");
    let accepted = exchange(
        &server,
        request(host(&server), "host", TOKEN, "OPTIONS", &valid, ""),
    )
    .await;
    assert_eq!(accepted.0, 200);
    rejected(
        exchange(
            &server,
            request(
                host(&server),
                "host",
                TOKEN,
                "OPTIONS",
                "Origin: null\r\n",
                "",
            ),
        )
        .await,
        400,
    );
    rejected(
        exchange(
            &server,
            request(host(&server), "host", NEXT_TOKEN, "OPTIONS", &valid, ""),
        )
        .await,
        401,
    );
    let duplicate = format!("Origin: {ORIGIN}\r\nOrigin: {ORIGIN}\r\n");
    rejected(
        exchange(
            &server,
            request(host(&server), "host", TOKEN, "OPTIONS", &duplicate, ""),
        )
        .await,
        400,
    );
    assert_eq!(handler.gates.preflight_accepted.load(Ordering::SeqCst), 1);
    assert_eq!(handler.gates.origin_rejected.load(Ordering::SeqCst), 1);
    assert_eq!(
        handler.gates.authentication_rejected.load(Ordering::SeqCst),
        1
    );
    assert_eq!(handler.policy_reads.load(Ordering::SeqCst), 2);
    assert_eq!(handler.calls.load(Ordering::SeqCst), 0);
}
