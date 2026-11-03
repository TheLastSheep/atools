use std::collections::BTreeMap;

use axum::extract::ws::WebSocket;
use futures::SinkExt;
use tracing::warn;

use super::send;
use crate::{
    auth::AuthError,
    budgets::{run_bounded, BoundedTaskError},
    model::{CheckpointPayload, ClientMessage, ServerMessage},
    AppState, StoreError,
};

pub(super) enum AuthOutcome {
    Accepted {
        user: String,
        device: String,
        version: i32,
    },
    Rejected,
    Retry,
}

enum AuthSetupError {
    InvalidToken,
    Store,
}

pub(super) async fn authenticate(
    socket: &mut WebSocket,
    state: &AppState,
    request: ClientMessage,
) -> AuthOutcome {
    let device = if request.device_id.trim().is_empty() {
        "unknown".to_owned()
    } else {
        request.device_id
    };
    let version = request.protocol_version.max(1);
    let token = request.token;
    let device_name = request.device_name;
    let device_for_store = device.clone();
    let auth = state.auth.clone();
    let store = state.store.clone();
    let result = run_bounded(state.budgets.auth_work.clone(), move || {
        let user = auth.verify(&token).map_err(|error| match error {
            AuthError::InvalidAccessToken => AuthSetupError::InvalidToken,
            _ => AuthSetupError::Store,
        })?;
        store
            .upsert_device(&user, &device_for_store, &device_name)
            .map_err(|_| AuthSetupError::Store)?;
        let server_seq = store
            .max_user_seq(&user)
            .map_err(|_| AuthSetupError::Store)?;
        Ok::<_, AuthSetupError>((user, server_seq))
    })
    .await;
    let (user, server_seq) = match result {
        Ok(Ok(result)) => result,
        Ok(Err(AuthSetupError::InvalidToken)) => {
            let _ = send(socket, state, ServerMessage::error("Invalid token")).await;
            let _ = socket.close().await;
            return AuthOutcome::Rejected;
        }
        Ok(Err(AuthSetupError::Store)) | Err(BoundedTaskError::Worker) => {
            let _ = send(socket, state, ServerMessage::error("Authentication failed")).await;
            return AuthOutcome::Retry;
        }
        Err(BoundedTaskError::Busy) => {
            let _ = send(
                socket,
                state,
                ServerMessage::error("Authentication is busy"),
            )
            .await;
            return AuthOutcome::Retry;
        }
    };

    let mut response = ServerMessage::new("auth_ok");
    response.server_instance_id = Some(state.server_instance_id().to_owned());
    response.server_seq = server_seq;
    response.features = Some(BTreeMap::from([
        ("documentSync", true),
        ("tombstones", true),
        ("checkpoints", true),
        ("snapshotPull", true),
        ("revisionRetention", false),
        ("attachments", false),
        ("automaticSnapshotThreshold", false),
        ("liveBroadcast", false),
        ("boundedPayloads", true),
    ]));
    if !send(socket, state, response).await {
        return AuthOutcome::Rejected;
    }
    AuthOutcome::Accepted {
        user,
        device,
        version,
    }
}

pub(super) async fn pull(
    socket: &mut WebSocket,
    state: &AppState,
    uid: &str,
    request: ClientMessage,
) -> bool {
    let store = state.store.clone();
    let uid = uid.to_owned();
    let since = request.since.max(0);
    let snapshot = request.snapshot;
    match run_bounded(state.budgets.pulls.clone(), move || {
        store.pull_changes(&uid, since, snapshot)
    })
    .await
    {
        Ok(Ok((changes, sequence))) => {
            let mut response = ServerMessage::new("changes");
            response.changes = Some(changes);
            response.seq = sequence;
            response.snapshot = snapshot;
            response.reset = snapshot;
            send(socket, state, response).await
        }
        Ok(Err(error)) => {
            warn!("sync pull failed: {error}");
            let message = match error {
                StoreError::SnapshotTooLarge => "Snapshot exceeds the configured size budget",
                _ => "Pull failed",
            };
            send(socket, state, ServerMessage::error(message)).await
        }
        Err(BoundedTaskError::Busy) => {
            send(socket, state, ServerMessage::error("Pull capacity is full")).await
        }
        Err(BoundedTaskError::Worker) => {
            warn!("sync pull blocking worker failed");
            send(socket, state, ServerMessage::error("Pull failed")).await
        }
    }
}

pub(super) async fn get_checkpoint(
    socket: &mut WebSocket,
    state: &AppState,
    uid: &str,
    id: &str,
) -> bool {
    let store = state.store.clone();
    let uid = uid.to_owned();
    let id = id.to_owned();
    match run_bounded(state.budgets.auxiliary_db.clone(), move || {
        store.get_checkpoint(&uid, &id)
    })
    .await
    {
        Ok(Ok(checkpoint)) => {
            let mut response = ServerMessage::new("checkpoint");
            response.checkpoint = Some(checkpoint);
            send(socket, state, response).await
        }
        Ok(Err(error)) => {
            warn!("checkpoint read failed: {error}");
            send(socket, state, ServerMessage::error("Get checkpoint failed")).await
        }
        Err(BoundedTaskError::Busy) => {
            send(
                socket,
                state,
                ServerMessage::error("Storage capacity is full"),
            )
            .await
        }
        Err(BoundedTaskError::Worker) => {
            send(socket, state, ServerMessage::error("Get checkpoint failed")).await
        }
    }
}

pub(super) async fn put_checkpoint(
    socket: &mut WebSocket,
    state: &AppState,
    uid: &str,
    checkpoint: Option<CheckpointPayload>,
) -> bool {
    let Some(checkpoint) = checkpoint else {
        return send(socket, state, ServerMessage::error("Missing checkpoint")).await;
    };
    let store = state.store.clone();
    let uid = uid.to_owned();
    let sync_epoch = state.sync_epoch;
    match run_bounded(state.budgets.auxiliary_db.clone(), move || {
        store.upsert_checkpoint(&uid, checkpoint, sync_epoch)
    })
    .await
    {
        Ok(Ok(checkpoint)) => {
            let mut response = ServerMessage::new("checkpoint_ok");
            response.checkpoint = Some(checkpoint);
            send(socket, state, response).await
        }
        Ok(Err(error)) => {
            warn!("checkpoint write failed: {error}");
            send(socket, state, ServerMessage::error("Put checkpoint failed")).await
        }
        Err(BoundedTaskError::Busy) => {
            send(
                socket,
                state,
                ServerMessage::error("Storage capacity is full"),
            )
            .await
        }
        Err(BoundedTaskError::Worker) => {
            send(socket, state, ServerMessage::error("Put checkpoint failed")).await
        }
    }
}

pub(super) async fn push(
    socket: &mut WebSocket,
    state: &AppState,
    uid: &str,
    device_id: &str,
    client_version: i32,
    request: ClientMessage,
) -> bool {
    if request.changes.is_empty() {
        return send(socket, state, ServerMessage::new("push_ok")).await;
    }
    let version = if request.protocol_version > 0 {
        request.protocol_version
    } else {
        client_version
    };
    let store = state.store.clone();
    let uid = uid.to_owned();
    let device_id = device_id.to_owned();
    let changes = request.changes;
    match run_bounded(state.budgets.pushes.clone(), move || {
        store.push_changes(&uid, &device_id, &changes, version)
    })
    .await
    {
        Ok(Ok(sequence)) => {
            let mut response = ServerMessage::new("push_ok");
            response.seq = sequence;
            send(socket, state, response).await
        }
        Ok(Err(StoreError::UnsupportedPayload(feature))) => {
            send(
                socket,
                state,
                ServerMessage::error(format!("Unsupported payload: {feature}")),
            )
            .await
        }
        Ok(Err(StoreError::RevisionConflict(reason))) => {
            send(
                socket,
                state,
                ServerMessage::error(format!("Unsupported revision update: {reason}")),
            )
            .await
        }
        Ok(Err(StoreError::MissingRevision | StoreError::MissingDocumentId)) => {
            send(
                socket,
                state,
                ServerMessage::error("Document identity is required"),
            )
            .await
        }
        Ok(Err(StoreError::PayloadTooLarge)) => {
            send(
                socket,
                state,
                ServerMessage::error("Sync payload exceeds the configured size budget"),
            )
            .await
        }
        Ok(Err(error)) => {
            warn!("document push failed: {error}");
            send(socket, state, ServerMessage::error("Push failed")).await
        }
        Err(BoundedTaskError::Busy) => {
            send(socket, state, ServerMessage::error("Push capacity is full")).await
        }
        Err(BoundedTaskError::Worker) => {
            warn!("sync push blocking worker failed");
            send(socket, state, ServerMessage::error("Push failed")).await
        }
    }
}
