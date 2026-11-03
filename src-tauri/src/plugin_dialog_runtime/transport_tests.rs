//! Local transport tests only: no package code, Node process or native panel.
use crate::plugin_loopback::{BridgeServer, RequestHandler};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::Notify,
};
const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
#[derive(Default)]
struct Handler {
    entered: Notify,
    release: Notify,
    dropped: Notify,
    active: AtomicUsize,
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
        self.active.fetch_add(1, Ordering::SeqCst);
        let _active = Active(self);
        self.entered.notify_one();
        self.release.notified().await;
        Ok(json!({"canceled":true,"paths":[]}))
    }
}
async fn connect(server: &BridgeServer) -> TcpStream {
    let host = server.origin.strip_prefix("http://").unwrap();
    let mut stream = TcpStream::connect(host).await.unwrap();
    let request=format!("POST /dialog/{TOKEN} HTTP/1.1\r\nHost: {host}\r\nOrigin: null\r\nContent-Length: 2\r\n\r\n{{}}");
    stream.write_all(request.as_bytes()).await.unwrap();
    stream
}
#[tokio::test]
async fn dialog_namespace_waits_beyond_existing_eight_second_node_deadline_without_replaying() {
    let handler = Arc::new(Handler::default());
    let server = BridgeServer::start_scoped(handler.clone(), "dialog")
        .await
        .unwrap();
    let mut stream = connect(&server).await;
    handler.entered.notified().await;
    tokio::time::sleep(Duration::from_millis(8100)).await;
    assert_eq!(
        handler.active.load(Ordering::SeqCst),
        1,
        "dialog was dropped at the legacy Node timeout"
    );
    handler.release.notify_one();
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(1), stream.read_to_end(&mut response))
        .await
        .unwrap()
        .unwrap();
    assert!(String::from_utf8(response)
        .unwrap()
        .contains("\"paths\":[]"));
    assert_eq!(handler.active.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn client_disconnect_drops_waiter_so_native_cancellation_lease_can_close_real_panel() {
    let handler = Arc::new(Handler::default());
    let server = BridgeServer::start_scoped(handler.clone(), "dialog")
        .await
        .unwrap();
    let stream = connect(&server).await;
    handler.entered.notified().await;
    drop(stream);
    tokio::time::timeout(Duration::from_secs(1), handler.dropped.notified())
        .await
        .unwrap();
    assert_eq!(handler.active.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn closing_last_dialog_session_can_release_listener_and_all_pending_waiters() {
    let handler = Arc::new(Handler::default());
    let server = BridgeServer::start_scoped(handler.clone(), "dialog")
        .await
        .unwrap();
    let _stream = connect(&server).await;
    handler.entered.notified().await;
    let host = server.origin.strip_prefix("http://").unwrap().to_string();
    drop(server);
    tokio::time::timeout(Duration::from_secs(1), handler.dropped.notified())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        while TcpStream::connect(&host).await.is_ok() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(handler.active.load(Ordering::SeqCst), 0);
}
