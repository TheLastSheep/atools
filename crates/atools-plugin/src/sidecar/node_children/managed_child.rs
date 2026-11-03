use super::child_io::{
    output_reader, stdin_writer, CreditGate, OutputStream, StdinMessage, StreamMessage,
};
use super::error::RequestFailure;
use super::spawn::{ChildBudgetGuard, ChildCommand, StdioMode};
use crate::sidecar::process::{terminate_child, OwnedSidecarChild};
use crate::sidecar::SidecarError;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::time::Duration;
use tokio::process::{ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::mpsc;

const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(50);
const STDIN_QUEUE_CHUNKS: usize = 8;

pub(super) async fn run_managed_child(
    child_id: u64,
    mut child: OwnedSidecarChild,
    stdio: [StdioMode; 3],
    stdin: Option<ChildStdin>,
    stdout: Option<ChildStdout>,
    stderr: Option<ChildStderr>,
    mut budget: ChildBudgetGuard,
    mut commands: mpsc::Receiver<ChildCommand>,
    events: mpsc::Sender<Value>,
) -> (u64, Result<(), SidecarError>) {
    let (stream_tx, mut stream_rx) = mpsc::channel(4);
    let mut readers = Vec::new();
    let stdout_credit = std::sync::Arc::new(CreditGate::new(2));
    let stderr_credit = std::sync::Arc::new(CreditGate::new(2));
    let mut stdout_closed = stdio[1] == StdioMode::Ignore;
    let mut stderr_closed = stdio[2] == StdioMode::Ignore;
    let mut writer_closed = stdio[0] == StdioMode::Ignore;
    let mut stream_messages_open = true;
    let mut input_tx = None;
    let mut writer = None;

    if let Some(stdout) = stdout {
        readers.push(tokio::spawn(output_reader(
            stdout,
            child_id,
            OutputStream::Stdout,
            stdout_credit.clone(),
            events.clone(),
            stream_tx.clone(),
        )));
    }
    if let Some(stderr) = stderr {
        readers.push(tokio::spawn(output_reader(
            stderr,
            child_id,
            OutputStream::Stderr,
            stderr_credit.clone(),
            events.clone(),
            stream_tx.clone(),
        )));
    }
    if let Some(stdin) = stdin {
        let (writes_tx, writes_rx) = mpsc::channel(STDIN_QUEUE_CHUNKS);
        input_tx = Some(writes_tx);
        writer = Some(tokio::spawn(stdin_writer(
            stdin,
            child_id,
            writes_rx,
            events.clone(),
            stream_tx.clone(),
        )));
    }
    drop(stream_tx);

    let mut interval = tokio::time::interval(EXIT_POLL_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut exit = None;
    let mut terminal_events = VecDeque::new();
    let mut close_queued = false;
    let mut first_error = None;

    loop {
        queue_close_if_ready(
            child_id,
            exit.as_ref(),
            stdout_closed,
            stderr_closed,
            writer_closed,
            &mut close_queued,
            &mut terminal_events,
        );

        tokio::select! {
            permit = events.reserve(), if !terminal_events.is_empty() => {
                match permit {
                    Ok(permit) => { permit.send(terminal_events.pop_front().expect("event was queued")); }
                    Err(_) => {
                        first_error.get_or_insert_with(|| SidecarError::Crashed("managed child event channel closed".into()));
                        terminal_events.clear();
                    }
                }
            }
            command = commands.recv() => {
                match command {
                    Some(ChildCommand::Shutdown) | None => {
                        let result = terminate_and_drain(
                            child, readers, writer, budget, first_error,
                        ).await;
                        return (child_id, result);
                    }
                    Some(command) => handle_command(
                        command, &mut child, input_tx.as_ref(), &stdout_credit,
                        &stderr_credit, stdio, &mut first_error,
                    ).await,
                }
            }
            stream = stream_rx.recv(), if stream_messages_open => {
                if stream.is_none() {
                    stream_messages_open = false;
                }
                if let Some(event) = handle_stream_message(
                    child_id,
                    stream, &mut stdout_closed, &mut stderr_closed, &mut writer_closed,
                    &mut child, &mut first_error,
                ) {
                    terminal_events.push_back(event);
                }
            }
            _ = interval.tick(), if exit.is_none() => {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        let info = ExitInfo::from_status(&status);
                        queue_exit_event(child_id, &info, &mut terminal_events);
                        exit = Some(info);
                        input_tx.take();
                        if let Err(error) = child
                            .confirm_process_group_gone_after_reap(Duration::from_secs(1))
                            .await
                        {
                            first_error.get_or_insert(error);
                        }
                        match child.cleanup_result() {
                            Some(error) => { first_error.get_or_insert(error); }
                            None if child.process_group_cleanup_confirmed() => {}
                            None => {
                                first_error.get_or_insert_with(|| SidecarError::Crashed(
                                    "managed child process group cleanup was not confirmed".into(),
                                ));
                            }
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        let reason = SidecarError::Crashed(format!("managed child wait failed: {error}"));
                        let result = terminate_and_drain(
                            child, readers, writer, budget, Some(reason),
                        ).await;
                        return (child_id, result);
                    }
                }
            }
        }

        if close_queued && terminal_events.is_empty() {
            abort_tasks(readers, writer).await;
            let cleanup_error = child.cleanup_result().or_else(|| {
                (child.reaped() && !child.process_group_cleanup_confirmed()).then(|| {
                    SidecarError::Crashed(
                        "managed child process group cleanup was not confirmed".into(),
                    )
                })
            });
            if cleanup_error.is_none() && child.reaped() && child.process_group_cleanup_confirmed()
            {
                budget.confirm_cleanup();
            }
            return (child_id, first_error.or(cleanup_error).map_or(Ok(()), Err));
        }
    }
}

async fn handle_command(
    command: ChildCommand,
    child: &mut OwnedSidecarChild,
    input: Option<&mpsc::Sender<StdinMessage>>,
    stdout_credit: &CreditGate,
    stderr_credit: &CreditGate,
    stdio: [StdioMode; 3],
    first_error: &mut Option<SidecarError>,
) {
    match command {
        ChildCommand::Kill {
            signal,
            group,
            response,
        } => {
            let _ = response.send(
                child
                    .send_signal(signal, group)
                    .map_err(RequestFailure::signal),
            );
        }
        ChildCommand::Write {
            write_id,
            bytes,
            response,
        } => {
            let result = queue_stdin(input, stdio[0], StdinMessage::Write { write_id, bytes });
            let _ = response.send(result);
        }
        ChildCommand::End { write_id, response } => {
            let result = queue_stdin(input, stdio[0], StdinMessage::End { write_id });
            let _ = response.send(result);
        }
        ChildCommand::Credit {
            stream,
            count,
            response,
        } => {
            let result = match stream {
                OutputStream::Stdout if stdio[1] == StdioMode::Pipe => stdout_credit.grant(count),
                OutputStream::Stderr if stdio[2] == StdioMode::Pipe => stderr_credit.grant(count),
                _ => Err(RequestFailure::invalid(
                    "credit targets a stream that is not piped",
                )),
            };
            let _ = response.send(result);
        }
        ChildCommand::Shutdown => {
            first_error.get_or_insert(SidecarError::Cancelled);
        }
    }
}

fn queue_stdin(
    input: Option<&mpsc::Sender<StdinMessage>>,
    mode: StdioMode,
    message: StdinMessage,
) -> Result<(), RequestFailure> {
    if mode != StdioMode::Pipe {
        return Err(RequestFailure::new(
            "ERR_ATOOLS_CHILD_STDIN_UNAVAILABLE",
            "stdin is not configured as a pipe",
            Some(libc::EBADF),
        ));
    }
    let Some(input) = input else {
        return Err(RequestFailure::new(
            "ERR_ATOOLS_CHILD_STDIN_CLOSED",
            "stdin writer is already closed",
            Some(libc::EPIPE),
        ));
    };
    input.try_send(message).map_err(|error| match error {
        mpsc::error::TrySendError::Full(_) => RequestFailure::new(
            "ERR_ATOOLS_CHILD_WRITE_BACKPRESSURE",
            "managed child stdin queue is full",
            Some(libc::EAGAIN),
        ),
        mpsc::error::TrySendError::Closed(_) => RequestFailure::new(
            "ERR_ATOOLS_CHILD_STDIN_CLOSED",
            "stdin writer is already closed",
            Some(libc::EPIPE),
        ),
    })
}

fn handle_stream_message(
    child_id: u64,
    message: Option<StreamMessage>,
    stdout_closed: &mut bool,
    stderr_closed: &mut bool,
    writer_closed: &mut bool,
    child: &mut OwnedSidecarChild,
    first_error: &mut Option<SidecarError>,
) -> Option<Value> {
    match message {
        Some(StreamMessage::Closed(OutputStream::Stdout)) => {
            *stdout_closed = true;
            None
        }
        Some(StreamMessage::Closed(OutputStream::Stderr)) => {
            *stderr_closed = true;
            None
        }
        Some(StreamMessage::Failed(stream, message)) => {
            match stream {
                OutputStream::Stdout => *stdout_closed = true,
                OutputStream::Stderr => *stderr_closed = true,
            }
            first_error.get_or_insert_with(|| {
                SidecarError::Crashed(format!(
                    "managed child {} read failed: {message}",
                    stream.as_str()
                ))
            });
            if let Err(error) = child.send_signal(libc::SIGKILL, true) {
                first_error.get_or_insert_with(|| {
                    SidecarError::Crashed(format!(
                        "managed child stream failure cleanup failed: {error}"
                    ))
                });
            }
            Some(stream_error_event(child_id, stream, &message))
        }
        Some(StreamMessage::StdinClosed) => {
            *writer_closed = true;
            None
        }
        None => {
            *stdout_closed = true;
            *stderr_closed = true;
            *writer_closed = true;
            None
        }
    }
}

#[derive(Clone)]
struct ExitInfo {
    code: Option<i32>,
    signal: Option<String>,
}

impl ExitInfo {
    fn from_status(status: &std::process::ExitStatus) -> Self {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            Self {
                code: status.code(),
                signal: status.signal().map(signal_name),
            }
        }
        #[cfg(not(unix))]
        {
            Self {
                code: status.code(),
                signal: None,
            }
        }
    }
}

fn exit_event(child_id: u64, info: &ExitInfo) -> Value {
    json!({"childId":child_id.to_string(),"event":"exit","code":info.code,"signal":info.signal})
}

fn close_event(child_id: u64, info: &ExitInfo) -> Value {
    json!({"childId":child_id.to_string(),"event":"close","code":info.code,"signal":info.signal})
}

fn stream_error_event(child_id: u64, stream: OutputStream, message: &str) -> Value {
    json!({
        "childId":child_id.to_string(),
        "event":"streamError",
        "stream":stream.as_str(),
        "error":{
            "code":"ERR_ATOOLS_CHILD_OUTPUT_READ",
            "message":message,
        },
    })
}

fn queue_exit_event(child_id: u64, info: &ExitInfo, terminal_events: &mut VecDeque<Value>) {
    terminal_events.push_back(exit_event(child_id, info));
}

fn queue_close_if_ready(
    child_id: u64,
    exit: Option<&ExitInfo>,
    stdout_closed: bool,
    stderr_closed: bool,
    writer_closed: bool,
    close_queued: &mut bool,
    terminal_events: &mut VecDeque<Value>,
) {
    if !stdout_closed || !stderr_closed || !writer_closed || *close_queued {
        return;
    }
    let Some(info) = exit else {
        return;
    };
    terminal_events.push_back(close_event(child_id, info));
    *close_queued = true;
}

#[cfg(unix)]
fn signal_name(signal: i32) -> String {
    let name = match signal {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGKILL => "SIGKILL",
        libc::SIGTERM => "SIGTERM",
        libc::SIGABRT => "SIGABRT",
        libc::SIGALRM => "SIGALRM",
        libc::SIGCHLD => "SIGCHLD",
        libc::SIGCONT => "SIGCONT",
        libc::SIGSTOP => "SIGSTOP",
        libc::SIGTSTP => "SIGTSTP",
        libc::SIGUSR1 => "SIGUSR1",
        libc::SIGUSR2 => "SIGUSR2",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGWINCH => "SIGWINCH",
        _ => return format!("SIG{signal}"),
    };
    name.to_string()
}

#[cfg(test)]
#[path = "managed_child_tests.rs"]
mod tests;

async fn terminate_and_drain(
    mut child: OwnedSidecarChild,
    readers: Vec<tokio::task::JoinHandle<()>>,
    writer: Option<tokio::task::JoinHandle<()>>,
    mut budget: ChildBudgetGuard,
    prior_error: Option<SidecarError>,
) -> Result<(), SidecarError> {
    let cleanup_before_abort = if child.reaped() {
        match child.cleanup_result() {
            Some(error) => Err(error),
            None if child.process_group_cleanup_confirmed() => Ok(()),
            None => Ok(()),
        }
    } else {
        terminate_child(&mut child).await.and_then(|termination| {
            termination
                .group_error
                .or_else(|| child.cleanup_result())
                .map_or(Ok(()), Err)
        })
    };
    abort_tasks(readers, writer).await;
    if child.reaped()
        && child.cleanup_result().is_none()
        && !child.process_group_cleanup_confirmed()
    {
        let _ = child
            .confirm_process_group_gone_after_reap(Duration::from_secs(1))
            .await;
    }
    let cleanup = cleanup_before_abort
        .and_then(|_| child.cleanup_result().map_or(Ok(()), Err))
        .and_then(|_| {
            child
                .process_group_cleanup_confirmed()
                .then_some(())
                .ok_or_else(|| {
                    SidecarError::Crashed(
                        "managed child process group cleanup was not confirmed".into(),
                    )
                })
        });
    let result = match (prior_error, cleanup.clone()) {
        (Some(prior), Err(cleanup_error)) => Err(SidecarError::Crashed(format!(
            "{prior}; managed child cleanup also failed: {cleanup_error}"
        ))),
        (Some(prior), Ok(())) => Err(prior),
        (None, cleanup) => cleanup,
    };
    if cleanup.is_ok()
        && child.reaped()
        && child.cleanup_result().is_none()
        && child.process_group_cleanup_confirmed()
    {
        budget.confirm_cleanup();
    }
    result
}

async fn abort_tasks(
    readers: Vec<tokio::task::JoinHandle<()>>,
    writer: Option<tokio::task::JoinHandle<()>>,
) {
    for task in &readers {
        task.abort();
    }
    if let Some(writer) = &writer {
        writer.abort();
    }
    for task in readers {
        let _ = task.await;
    }
    if let Some(writer) = writer {
        let _ = writer.await;
    }
}
