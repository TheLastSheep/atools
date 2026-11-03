use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    time::Duration,
};

use atools_sync_server::{router, AppState, Config};
use futures::SinkExt;
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Error as WsError, Message},
};

const MAX_CONNECTIONS: usize = 16;

#[tokio::test]
async fn preauth_connections_are_bounded_and_close_releases_a_slot() {
    let directory = tempfile::tempdir().unwrap();
    let state = AppState::open(Config {
        data_dir: directory.path().to_path_buf(),
        database_path: directory.path().join("sync.db"),
        jwt_secret: vec![0x52; 32],
        bootstrap_user: None,
        allow_registration: false,
        listen_address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
    })
    .unwrap();
    let (address, shutdown, server) = serve_loopback(router(state)).await;
    let endpoint = format!("ws://{address}/ws");
    let mut held = Vec::new();
    for _ in 0..MAX_CONNECTIONS {
        held.push(connect_async(&endpoint).await.unwrap().0);
    }

    let overloaded = match connect_async(&endpoint).await {
        Err(error) => error,
        Ok(_) => panic!("connection should be rejected at the configured limit"),
    };
    match overloaded {
        WsError::Http(response) => assert_eq!(response.status().as_u16(), 503),
        other => panic!("expected HTTP 503 at connection limit, got {other}"),
    }

    held[0].send(Message::Close(None)).await.unwrap();
    let mut replacement = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match connect_async(&endpoint).await {
                Ok((socket, _)) => break socket,
                Err(WsError::Http(response)) if response.status().as_u16() == 503 => {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                Err(error) => panic!("unexpected reconnect error: {error}"),
            }
        }
    })
    .await
    .expect("closing one preauth socket should release a connection permit");
    replacement.send(Message::Close(None)).await.unwrap();
    for socket in held.iter_mut().skip(1) {
        let _ = socket.send(Message::Close(None)).await;
    }
    let _ = shutdown.send(());
    server.await.unwrap();
}

async fn serve_loopback(app: axum::Router) -> (SocketAddr, oneshot::Sender<()>, JoinHandle<()>) {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown, receive) = oneshot::channel();
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = receive.await;
            })
            .await
            .unwrap();
    });
    (address, shutdown, task)
}
