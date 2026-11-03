use super::startup_diagnostics::{StartupParseOutcome, StartupTrace};
use super::stdout_observation::ObservedStdoutReader;
use super::SidecarError;
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, RwLock};

const MAX_PROTOCOL_LINE_BYTES: usize = 8 * 1024 * 1024;
const MAX_STDERR_LINE_BYTES: usize = 4096;
const MAX_STDERR_LINES: usize = 200;
const STDIN_WRITE_TIMEOUT: Duration = Duration::from_millis(500);

pub(super) async fn write_message(
    stdin: &mut tokio::process::ChildStdin,
    value: &Value,
) -> Result<usize, SidecarError> {
    let mut bytes =
        serde_json::to_vec(value).map_err(|error| SidecarError::Protocol(error.to_string()))?;
    bytes.push(b'\n');
    let written = bytes.len();
    tokio::time::timeout(STDIN_WRITE_TIMEOUT, async {
        stdin
            .write_all(&bytes)
            .await
            .map_err(|error| SidecarError::Crashed(error.to_string()))?;
        stdin
            .flush()
            .await
            .map_err(|error| SidecarError::Crashed(error.to_string()))?;
        Ok(written)
    })
    .await
    .map_err(|_| SidecarError::Timeout(STDIN_WRITE_TIMEOUT.as_millis() as u64))?
}

pub(super) async fn read_stdout_lines<R: AsyncRead + Unpin>(
    stdout: R,
    line_tx: mpsc::Sender<Result<Value, SidecarError>>,
    diagnostics: Option<Arc<StartupTrace>>,
) {
    match diagnostics {
        Some(trace) => {
            let observed = ObservedStdoutReader::new(stdout, trace.stdout_read_observer());
            read_stdout_lines_from(BufReader::new(observed), line_tx, Some(trace)).await;
        }
        None => read_stdout_lines_from(BufReader::new(stdout), line_tx, None).await,
    }
}

async fn read_stdout_lines_from<R: AsyncRead + Unpin>(
    mut reader: BufReader<R>,
    line_tx: mpsc::Sender<Result<Value, SidecarError>>,
    diagnostics: Option<Arc<StartupTrace>>,
) {
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        match (&mut reader)
            .take((MAX_PROTOCOL_LINE_BYTES + 1) as u64)
            .read_until(b'\n', &mut buffer)
            .await
        {
            Ok(0) => break,
            Ok(_) if buffer.len() > MAX_PROTOCOL_LINE_BYTES => {
                if let Some(trace) = &diagnostics {
                    trace.record_first_stdout(StartupParseOutcome::Oversized);
                }
                let _ = line_tx
                    .send(Err(SidecarError::Protocol(
                        "stdout JSON message exceeded size limit".to_string(),
                    )))
                    .await;
                break;
            }
            Ok(_) => {
                while matches!(buffer.last(), Some(b'\n' | b'\r')) {
                    buffer.pop();
                }
                if buffer.is_empty() {
                    continue;
                }
                let value = serde_json::from_slice::<Value>(&buffer).map_err(|error| {
                    SidecarError::Protocol(format!(
                        "stdout must contain only JSON-RPC messages: {error}"
                    ))
                });
                if let Some(trace) = &diagnostics {
                    trace.record_first_stdout(if value.is_ok() {
                        StartupParseOutcome::Parsed
                    } else {
                        StartupParseOutcome::InvalidJson
                    });
                }
                if line_tx.send(value).await.is_err() {
                    break;
                }
            }
            Err(error) => {
                if let Some(trace) = &diagnostics {
                    trace.record_first_stdout(StartupParseOutcome::ReadError);
                }
                let _ = line_tx
                    .send(Err(SidecarError::Crashed(error.to_string())))
                    .await;
                break;
            }
        }
    }
}

pub(super) async fn capture_stderr(
    stderr: tokio::process::ChildStderr,
    captured: Arc<RwLock<VecDeque<String>>>,
    diagnostics: Option<Arc<StartupTrace>>,
) {
    let mut reader = BufReader::new(stderr);
    loop {
        let mut bytes = Vec::new();
        match (&mut reader)
            .take((MAX_STDERR_LINE_BYTES + 1) as u64)
            .read_until(b'\n', &mut bytes)
            .await
        {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if let Some(trace) = &diagnostics {
            trace.record_stderr(&bytes);
        }
        let truncated = bytes.len() > MAX_STDERR_LINE_BYTES;
        bytes.truncate(MAX_STDERR_LINE_BYTES);
        let mut line = String::from_utf8_lossy(&bytes).trim_end().to_string();
        if truncated {
            line.push_str(" [truncated]");
        }
        let mut captured = captured.write().await;
        captured.push_back(line);
        while captured.len() > MAX_STDERR_LINES {
            captured.pop_front();
        }
    }
}
