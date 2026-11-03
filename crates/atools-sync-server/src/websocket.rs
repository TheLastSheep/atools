mod operations;

use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use axum::extract::ws::{Message, WebSocket};
use futures::{SinkExt, StreamExt};
use serde_json::from_str;
use tokio::{
    sync::OwnedSemaphorePermit,
    time::{timeout_at, Instant},
};
use tracing::warn;

use crate::{
    model::{ClientMessage, ServerMessage},
    AppState,
};

const PROTOCOL_VERSION: i32 = 2;
const AUTH_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_WS_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

pub(crate) fn max_message_size() -> usize {
    MAX_WS_MESSAGE_BYTES
}

pub(crate) async fn serve(
    mut socket: WebSocket,
    state: AppState,
    _connection_permit: OwnedSemaphorePermit,
) {
    let auth_deadline = Instant::now() + AUTH_TIMEOUT;
    let mut uid: Option<String> = None;
    let mut device_id = String::new();
    let mut client_version = 1_i32;
    let mut active = None;

    loop {
        let incoming = if uid.is_none() {
            match timeout_at(auth_deadline, socket.next()).await {
                Ok(frame) => frame,
                Err(_) => {
                    let _ = send(
                        &mut socket,
                        &state,
                        ServerMessage::error("Authentication timeout"),
                    )
                    .await;
                    break;
                }
            }
        } else {
            socket.next().await
        };
        let Some(Ok(frame)) = incoming else { break };
        match frame {
            Message::Text(text) => {
                let request = match from_str::<ClientMessage>(text.as_str()) {
                    Ok(request) => request,
                    Err(_) => {
                        if !send(&mut socket, &state, ServerMessage::error("Invalid message")).await
                        {
                            break;
                        }
                        continue;
                    }
                };
                if request.kind == "ping" {
                    if !send(&mut socket, &state, ServerMessage::new("pong")).await {
                        break;
                    }
                    continue;
                }
                if request.kind == "auth" {
                    if uid.is_some() {
                        if !send(
                            &mut socket,
                            &state,
                            ServerMessage::error("Already authenticated"),
                        )
                        .await
                        {
                            break;
                        }
                        continue;
                    }
                    match operations::authenticate(&mut socket, &state, request).await {
                        operations::AuthOutcome::Accepted {
                            user,
                            device,
                            version,
                        } => {
                            uid = Some(user);
                            device_id = device;
                            client_version = version;
                            active = Some(ActiveConnection::new(state.active_connections.clone()));
                        }
                        operations::AuthOutcome::Rejected => break,
                        operations::AuthOutcome::Retry => continue,
                    }
                    continue;
                }
                let Some(user) = uid.as_deref() else {
                    if !send(
                        &mut socket,
                        &state,
                        ServerMessage::error("Not authenticated"),
                    )
                    .await
                    {
                        break;
                    }
                    continue;
                };
                let request_kind = request.kind.clone();
                let result = match request_kind.as_str() {
                    "pull" => operations::pull(&mut socket, &state, user, request).await,
                    "get_checkpoint" => {
                        operations::get_checkpoint(
                            &mut socket,
                            &state,
                            user,
                            &request.checkpoint_id,
                        )
                        .await
                    }
                    "put_checkpoint" => {
                        operations::put_checkpoint(&mut socket, &state, user, request.checkpoint)
                            .await
                    }
                    "push" => {
                        operations::push(
                            &mut socket,
                            &state,
                            user,
                            &device_id,
                            client_version,
                            request,
                        )
                        .await
                    }
                    _ => {
                        send(
                            &mut socket,
                            &state,
                            ServerMessage::error(format!("Unknown message type: {}", request.kind)),
                        )
                        .await
                    }
                };
                if !result {
                    break;
                }
            }
            Message::Ping(bytes) => {
                if socket.send(Message::Pong(bytes)).await.is_err() {
                    break;
                }
            }
            Message::Close(_) => break,
            Message::Pong(_) => {}
            Message::Binary(_) => {
                if !send(
                    &mut socket,
                    &state,
                    ServerMessage::error("Binary messages are not supported"),
                )
                .await
                {
                    break;
                }
            }
        }
    }
    drop(active);
    let _ = socket.close().await;
}

pub(super) async fn send(
    socket: &mut WebSocket,
    state: &AppState,
    mut response: ServerMessage,
) -> bool {
    response.protocol_version = PROTOCOL_VERSION;
    response.sync_epoch = state.sync_epoch;
    match serde_json::to_string(&response) {
        Ok(json) => socket.send(Message::Text(json.into())).await.is_ok(),
        Err(error) => {
            warn!("failed to encode sync response: {error}");
            false
        }
    }
}

struct ActiveConnection(Arc<AtomicUsize>);

impl ActiveConnection {
    fn new(counter: Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::Relaxed);
        Self(counter)
    }
}

impl Drop for ActiveConnection {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}
