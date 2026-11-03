use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
};

use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpListener,
    sync::oneshot,
    task::JoinHandle,
};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tower::ServiceExt;

use atools_sync_server::{router, AppState, BootstrapUser, Config};

#[tokio::test]
async fn auth_refresh_sync_tombstone_checkpoint_and_user_isolation() {
    let directory = TempDir::new().unwrap();
    let config = test_config(directory.path());
    let state = AppState::open(config).unwrap();
    let app = router(state);
    let (address, shutdown, server) = serve_loopback(app.clone()).await;

    let bootstrap_login = http_json(
        app.clone(),
        Method::POST,
        "/api/login",
        json!({"uid":"owner", "password":"owner password"}),
    )
    .await;
    assert_eq!(bootstrap_login.status, StatusCode::OK);
    let denied_login = http_json(
        app.clone(),
        Method::POST,
        "/api/login",
        json!({"uid":"owner", "password":"wrong password"}),
    )
    .await;
    assert_eq!(denied_login.status, StatusCode::UNAUTHORIZED);

    let first_auth = http_json(
        app.clone(),
        Method::POST,
        "/api/auth",
        json!({"uid":"alice", "password":"correct horse battery staple"}),
    )
    .await;
    assert_eq!(first_auth.status, StatusCode::OK);
    assert_eq!(first_auth.body["isNew"], true);
    let original_refresh = first_auth.body["refreshToken"].as_str().unwrap().to_owned();

    let refreshed = http_json(
        app.clone(),
        Method::POST,
        "/api/auth/refresh",
        json!({"refreshToken": original_refresh}),
    )
    .await;
    assert_eq!(refreshed.status, StatusCode::OK);
    let alice_token = refreshed.body["token"].as_str().unwrap().to_owned();
    let replayed = http_json(
        app.clone(),
        Method::POST,
        "/api/auth/refresh",
        json!({"refreshToken": original_refresh}),
    )
    .await;
    assert_eq!(replayed.status, StatusCode::UNAUTHORIZED);

    let url = format!("ws://{address}/");
    let (mut alice, _) = connect_async(url).await.unwrap();
    send(&mut alice, json!({"type":"ping"})).await;
    assert_eq!(read(&mut alice).await["type"], "pong");
    send(&mut alice, json!({
        "type":"auth", "token":alice_token, "deviceId":"device-a", "deviceName":"test", "protocolVersion":2
    })).await;
    let authenticated = read(&mut alice).await;
    assert_eq!(authenticated["type"], "auth_ok");
    assert_eq!(authenticated["features"]["attachments"], false);
    assert_eq!(authenticated["features"]["revisionRetention"], false);
    assert_eq!(authenticated["features"]["tombstones"], true);
    assert_eq!(authenticated["serverSeq"], 0);

    send(
        &mut alice,
        json!({
            "type":"push", "changes":[{
                "docId":"note-1", "rev":"1-a", "deleted":false, "timestamp":1,
                "doc":{"text":"persisted"}, "docType":"note", "protocolVersion":2
            }]
        }),
    )
    .await;
    let created = read(&mut alice).await;
    assert_eq!(created["type"], "push_ok");
    let created_seq = created["seq"].as_i64().unwrap();
    assert!(created_seq > 0);

    send(&mut alice, json!({"type":"pull", "since":0})).await;
    let initial_pull = read(&mut alice).await;
    assert_eq!(initial_pull["type"], "changes");
    assert_eq!(initial_pull["changes"][0]["doc"]["text"], "persisted");
    assert_eq!(initial_pull["seq"], created_seq);

    send(
        &mut alice,
        json!({
            "type":"put_checkpoint", "checkpoint":{
                "id":"laptop", "sourceId":"local", "targetId":"remote",
                "lastSeq":created_seq, "data":{"cursor":"accepted"}
            }
        }),
    )
    .await;
    let saved_checkpoint = read(&mut alice).await;
    assert_eq!(saved_checkpoint["type"], "checkpoint_ok");
    assert_eq!(saved_checkpoint["checkpoint"]["lastSeq"], created_seq);

    send(
        &mut alice,
        json!({
            "type":"push", "changes":[{
                "docId":"note-1", "rev":"2-b", "parentRev":"1-a", "revisionHistory":["2-b"],
                "deleted":true, "timestamp":2, "doc":null, "docType":"note", "protocolVersion":2
            }]
        }),
    )
    .await;
    let tombstone_ack = read(&mut alice).await;
    let tombstone_seq = tombstone_ack["seq"].as_i64().unwrap();
    assert!(tombstone_seq > created_seq);
    send(
        &mut alice,
        json!({
            "type":"push", "changes":[{
                "docId":"note-1", "rev":"3-late", "parentRev":"1-a",
                "deleted":false, "doc":{"text":"late branch"}
            }]
        }),
    )
    .await;
    let late_branch = read(&mut alice).await;
    assert_eq!(late_branch["type"], "error");
    assert!(late_branch["message"]
        .as_str()
        .unwrap()
        .contains("parent revision"));
    alice.send(Message::Close(None)).await.unwrap();

    let (mut resumed, _) = connect_async(format!("ws://{address}/ws")).await.unwrap();
    send(
        &mut resumed,
        json!({"type":"auth", "token":alice_token, "deviceId":"device-a", "protocolVersion":2}),
    )
    .await;
    let resumed_auth = read(&mut resumed).await;
    assert_eq!(resumed_auth["serverSeq"], tombstone_seq);
    send(&mut resumed, json!({"type":"pull", "since":created_seq})).await;
    let after_reconnect = read(&mut resumed).await;
    assert_eq!(after_reconnect["changes"].as_array().unwrap().len(), 1);
    assert_eq!(after_reconnect["changes"][0]["deleted"], true);
    assert_eq!(after_reconnect["seq"], tombstone_seq);

    send(
        &mut resumed,
        json!({"type":"get_checkpoint", "checkpointId":"laptop"}),
    )
    .await;
    let restored_checkpoint = read(&mut resumed).await;
    assert_eq!(
        restored_checkpoint["checkpoint"]["data"]["cursor"],
        "accepted"
    );
    send(&mut resumed, json!({"type":"pull", "snapshot":true})).await;
    let snapshot = read(&mut resumed).await;
    assert_eq!(snapshot["snapshot"], true);
    assert_eq!(snapshot["changes"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["changes"][0]["deleted"], true);
    assert_eq!(snapshot["changes"][0]["winnerRev"], "2-b");
    assert_eq!(snapshot["changes"][0]["isWinner"], true);

    send(
        &mut resumed,
        json!({
            "type":"push", "changes":[{
                "docId":"with-file", "rev":"1-file", "deleted":false,
                "doc":{"_attachments":{"image.png":{"digest":"md5-unavailable"}}}
            }]
        }),
    )
    .await;
    let unsupported = read(&mut resumed).await;
    assert_eq!(unsupported["type"], "error");
    assert!(unsupported["message"]
        .as_str()
        .unwrap()
        .contains("attachments"));
    send(
        &mut resumed,
        json!({
            "type":"push", "changes":[{
                "docId":"branching", "rev":"2-b", "parentRev":"1-a",
                "revisionHistory":["2-b","1-a"], "deleted":false, "doc":{"value":2}
            }]
        }),
    )
    .await;
    let unsupported_history = read(&mut resumed).await;
    assert_eq!(unsupported_history["type"], "error");
    assert!(unsupported_history["message"]
        .as_str()
        .unwrap()
        .contains("revision history"));
    send(
        &mut resumed,
        json!({
            "type":"push", "changes":[{
                "docId":"with-resolution", "rev":"1-r", "doc":{}, "resolution":null
            }]
        }),
    )
    .await;
    let unsupported_resolution = read(&mut resumed).await;
    assert_eq!(unsupported_resolution["type"], "error");
    assert!(unsupported_resolution["message"]
        .as_str()
        .unwrap()
        .contains("revision resolution"));
    send(&mut resumed, json!({"type":"pull", "since":tombstone_seq})).await;
    assert_eq!(
        read(&mut resumed).await["changes"]
            .as_array()
            .unwrap()
            .len(),
        0
    );

    let second_auth = http_json(
        app.clone(),
        Method::POST,
        "/api/auth",
        json!({"uid":"bob", "password":"another secure password"}),
    )
    .await;
    assert_eq!(second_auth.status, StatusCode::OK);
    let bob_token = second_auth.body["token"].as_str().unwrap();
    let (mut bob, _) = connect_async(format!("ws://{address}/ws")).await.unwrap();
    send(
        &mut bob,
        json!({"type":"auth", "token":bob_token, "deviceId":"device-b", "protocolVersion":2}),
    )
    .await;
    assert_eq!(read(&mut bob).await["serverSeq"], 0);
    send(
        &mut bob,
        json!({"type":"get_checkpoint", "checkpointId":"laptop"}),
    )
    .await;
    assert_eq!(read(&mut bob).await["checkpoint"]["lastSeq"], 0);
    send(&mut bob, json!({"type":"pull", "since":0})).await;
    let bob_pull = read(&mut bob).await;
    assert_eq!(bob_pull["changes"].as_array().unwrap().len(), 0);
    assert_eq!(bob_pull["seq"], 0);

    resumed.send(Message::Close(None)).await.unwrap();
    bob.send(Message::Close(None)).await.unwrap();
    let _ = shutdown.send(());
    server.await.unwrap();
}

#[tokio::test]
async fn root_route_serves_protocol_identity() {
    let directory = TempDir::new().unwrap();
    let state = AppState::open(test_config(directory.path())).unwrap();
    let app = router(state);
    let response = app
        .clone()
        .oneshot(Request::get("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    let identity: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(identity["name"], "ZTools Sync Server");
    assert_eq!(identity["protocolVersion"], 2);
}

struct HttpResult {
    status: StatusCode,
    body: Value,
}

async fn http_json(
    app: axum::Router,
    method: Method,
    uri: &str,
    request_body: Value,
) -> HttpResult {
    let response = app
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header("content-type", "application/json")
                .body(Body::from(request_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    HttpResult { status, body }
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

async fn send<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>, message: Value)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    socket
        .send(Message::Text(message.to_string().into()))
        .await
        .unwrap();
}

async fn read<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>) -> Value
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    loop {
        match socket.next().await.unwrap().unwrap() {
            Message::Text(text) => return serde_json::from_str(text.as_ref()).unwrap(),
            Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await.unwrap(),
            Message::Close(_) => panic!("unexpected server close"),
            _ => {}
        }
    }
}

fn test_config(data_dir: &std::path::Path) -> Config {
    Config {
        data_dir: PathBuf::from(data_dir),
        database_path: data_dir.join("private-sync.db"),
        jwt_secret: vec![0x73; 32],
        bootstrap_user: Some(BootstrapUser {
            uid: "owner".into(),
            password: "owner password".into(),
        }),
        allow_registration: true,
        listen_address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
    }
}
