use super::launch::NodeChildrenLaunch;
use super::protocol::{read_frame, write_frame};
use super::requests::{finish_child, handle_frame, ChildEntry};
use super::spawn::{owner_budget, ChildCommand};
use super::transport::accept_authenticated;
use crate::sidecar::SidecarError;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;
use tokio::time::{timeout, Duration};

const EVENT_QUEUE_CAPACITY: usize = 32;
const CONTROL_QUEUE_CAPACITY: usize = 16;
const CLOSE_BUDGET: Duration = Duration::from_secs(3);

#[derive(Clone)]
pub(crate) struct NodeChildrenOwner {
    shared: Arc<OwnerShared>,
}

struct OwnerShared {
    commands: mpsc::Sender<OwnerCommand>,
    result: tokio::sync::Mutex<watch::Receiver<Option<Result<(), SidecarError>>>>,
    close_gate: tokio::sync::Mutex<()>,
    cached: tokio::sync::Mutex<Option<Result<(), SidecarError>>>,
}

enum OwnerCommand {
    Close,
}

impl NodeChildrenOwner {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(super) fn start(launch: NodeChildrenLaunch) -> Self {
        let (commands, command_rx) = mpsc::channel(1);
        let (result_tx, result_rx) = watch::channel(None);
        tokio::spawn(async move {
            let result = run_owner(launch, command_rx).await;
            result_tx.send_replace(Some(result));
        });
        Self {
            shared: Arc::new(OwnerShared {
                commands,
                result: tokio::sync::Mutex::new(result_rx),
                close_gate: tokio::sync::Mutex::new(()),
                cached: tokio::sync::Mutex::new(None),
            }),
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    pub(super) fn unsupported() -> Self {
        let (commands, _) = mpsc::channel(1);
        let (_result_tx, result_rx) = watch::channel(Some(Ok(())));
        Self {
            shared: Arc::new(OwnerShared {
                commands,
                result: tokio::sync::Mutex::new(result_rx),
                close_gate: tokio::sync::Mutex::new(()),
                cached: tokio::sync::Mutex::new(Some(Ok(()))),
            }),
        }
    }

    pub(crate) async fn close(&self) -> Result<(), SidecarError> {
        let _gate = self.shared.close_gate.lock().await;
        if let Some(result) = self.shared.cached.lock().await.clone() {
            return result;
        }
        let _ = self.shared.commands.send(OwnerCommand::Close).await;
        let mut result = self.shared.result.lock().await;
        loop {
            let outcome = { result.borrow().clone() };
            if let Some(outcome) = outcome {
                *self.shared.cached.lock().await = Some(outcome.clone());
                return outcome;
            }
            if result.changed().await.is_err() {
                let error = SidecarError::Crashed(
                    "managed child owner stopped without a cleanup result".into(),
                );
                *self.shared.cached.lock().await = Some(Err(error.clone()));
                return Err(error);
            }
        }
    }
}

impl Drop for OwnerShared {
    fn drop(&mut self) {
        let _ = self.commands.try_send(OwnerCommand::Close);
    }
}

#[derive(Clone)]
enum ControlMessage {
    Frame(Value),
    Failed(SidecarError),
    Eof,
}

async fn run_owner(
    launch: NodeChildrenLaunch,
    mut commands: mpsc::Receiver<OwnerCommand>,
) -> Result<(), SidecarError> {
    let parts = launch.into_parts();
    let mut directory = parts.directory;
    let result = run_owner_connections(
        parts.control_listener,
        parts.event_listener,
        &parts.token,
        &mut commands,
    )
    .await;
    let cleanup = directory.cleanup().map_err(|error| {
        SidecarError::Crashed(format!(
            "managed child socket directory cleanup failed: {error}"
        ))
    });
    match (result, cleanup) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(error), Err(cleanup_error)) => {
            Err(SidecarError::Crashed(format!("{error}; {cleanup_error}")))
        }
    }
}

async fn run_owner_connections(
    control_listener: std::os::unix::net::UnixListener,
    event_listener: std::os::unix::net::UnixListener,
    token: &str,
    commands: &mut mpsc::Receiver<OwnerCommand>,
) -> Result<(), SidecarError> {
    let control_listener = UnixListener::from_std(control_listener).map_err(|error| {
        SidecarError::Crashed(format!(
            "managed child control listener setup failed: {error}"
        ))
    })?;
    let event_listener = UnixListener::from_std(event_listener).map_err(|error| {
        SidecarError::Crashed(format!(
            "managed child event listener setup failed: {error}"
        ))
    })?;
    let authenticated = tokio::select! {
        result = accept_authenticated(&control_listener, &event_listener, token) => Some(result?),
        _command = commands.recv() => None,
    };
    let Some((control, events)) = authenticated else {
        return Ok(());
    };
    run_connected_owner(control, events, commands).await
}

async fn run_connected_owner(
    control: UnixStream,
    events: UnixStream,
    commands: &mut mpsc::Receiver<OwnerCommand>,
) -> Result<(), SidecarError> {
    let (control_reader, mut control_writer) = control.into_split();
    let (_event_reader, event_writer) = events.into_split();
    let (control_tx, mut control_rx) = mpsc::channel(CONTROL_QUEUE_CAPACITY);
    let control_task = tokio::spawn(read_control(control_reader, control_tx));
    let (event_tx, event_rx) = mpsc::channel(EVENT_QUEUE_CAPACITY);
    let (writer_fault_tx, mut writer_fault_rx) = mpsc::channel(1);
    let mut event_task = tokio::spawn(async move {
        if let Err(error) = write_events(event_writer, event_rx).await {
            let _ = writer_fault_tx.send(error).await;
        }
    });
    let owner_budget = owner_budget();
    let mut child_tasks: JoinSet<(u64, Result<(), SidecarError>)> = JoinSet::new();
    let mut children = HashMap::<u64, ChildEntry>::new();
    let mut tombstones = VecDeque::new();
    let mut next_child_id = 1u64;
    let mut last_request_id = 0u64;
    let mut first_error = None;
    let mut stop = false;

    while !stop {
        tokio::select! {
            biased;
            command = commands.recv() => {
                if matches!(command, Some(OwnerCommand::Close) | None) { stop = true; }
            }
            message = control_rx.recv() => {
                match message {
                    Some(ControlMessage::Frame(value)) => {
                        if let Err(error) = handle_frame(
                            value, &mut last_request_id, &mut next_child_id, &mut children,
                            &owner_budget, &event_tx, &mut child_tasks,
                            &mut control_writer,
                        ).await {
                            first_error.get_or_insert(error);
                            stop = true;
                        }
                    }
                    Some(ControlMessage::Failed(error)) => { first_error.get_or_insert(error); stop = true; }
                    Some(ControlMessage::Eof) | None => stop = true,
                }
            }
            error = writer_fault_rx.recv() => {
                if let Some(error) = error { first_error.get_or_insert(error); stop = true; }
            }
            joined = child_tasks.join_next(), if !child_tasks.is_empty() => {
                match joined {
                    Some(Ok((id, result))) => finish_child(id, result, &mut children, &mut tombstones, &mut first_error),
                    Some(Err(error)) => { first_error.get_or_insert_with(|| SidecarError::Crashed(format!("managed child task failed: {error}"))); }
                    None => {}
                }
            }
        }
    }

    stop_children(&mut children, &mut child_tasks, &mut first_error).await;
    control_task.abort();
    event_task.abort();
    let _ = control_task.await;
    let _ = (&mut event_task).await;
    drop(event_tx);
    first_error.map_or(Ok(()), Err)
}

async fn read_control<R: AsyncRead + Unpin>(mut reader: R, output: mpsc::Sender<ControlMessage>) {
    loop {
        match read_frame(&mut reader).await {
            Ok(Some(value)) => {
                if output.send(ControlMessage::Frame(value)).await.is_err() {
                    return;
                }
            }
            Ok(None) => {
                let _ = output.send(ControlMessage::Eof).await;
                return;
            }
            Err(error) => {
                let _ = output.send(ControlMessage::Failed(error)).await;
                return;
            }
        }
    }
}

async fn write_events<W: AsyncWrite + Unpin>(
    mut writer: W,
    mut events: mpsc::Receiver<Value>,
) -> Result<(), SidecarError> {
    while let Some(event) = events.recv().await {
        write_frame(&mut writer, &event).await?;
    }
    Ok(())
}

async fn stop_children(
    children: &mut HashMap<u64, ChildEntry>,
    tasks: &mut JoinSet<(u64, Result<(), SidecarError>)>,
    first_error: &mut Option<SidecarError>,
) {
    for entry in children.values() {
        if let ChildEntry::Running(child) = entry {
            let _ = child.commands.send(ChildCommand::Shutdown).await;
        }
    }
    let joined = timeout(CLOSE_BUDGET, async {
        while let Some(result) = tasks.join_next().await {
            match result {
                Ok((id, outcome)) => {
                    if let Err(error) = outcome {
                        first_error.get_or_insert(error);
                    }
                    children.insert(id, ChildEntry::Finished);
                }
                Err(error) => {
                    first_error.get_or_insert_with(|| {
                        SidecarError::Crashed(format!(
                            "managed child task failed during close: {error}"
                        ))
                    });
                }
            }
        }
    })
    .await;
    if joined.is_err() {
        first_error.get_or_insert_with(|| SidecarError::Timeout(CLOSE_BUDGET.as_millis() as u64));
    }
}

#[cfg(all(test, target_os = "macos", target_arch = "aarch64"))]
#[path = "owner_tests.rs"]
mod tests;
