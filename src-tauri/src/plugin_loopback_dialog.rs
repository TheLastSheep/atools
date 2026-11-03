//! One pending picker, one handler future, and a bounded active-only HTTP response.
use super::{RequestHandler, VerifiedCorsOrigin, MAX_BODY};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::time::{Instant, MissedTickBehavior};

const HEARTBEAT: Duration = Duration::from_secs(2);
const WRITE_DEADLINE: Duration = Duration::from_secs(1);
// The enclosing dialog connection deadline is 128s, so even a stalled picker
// cannot emit more than this allowance. Keep total response bytes below 1 MiB.
const WHITESPACE_BUDGET: usize = 65;

async fn write(writer: &mut (impl AsyncWrite + Unpin), bytes: &[u8]) -> Result<(), String> {
    tokio::time::timeout(WRITE_DEADLINE, writer.write_all(bytes))
        .await
        .map_err(|_| "Dialog response write timed out")?
        .map_err(|_| "Dialog response connection closed".into())
}
fn result_body(result: Result<Value, String>) -> Result<Vec<u8>, String> {
    let value = match result {
        Ok(result) => json!({"ok":true,"result":result}),
        Err(message) => json!({"ok":false,"error":{"message":message}}),
    };
    let bytes = serde_json::to_vec(&value).map_err(|_| "Dialog response encoding failed")?;
    if bytes.len() > MAX_BODY - WHITESPACE_BUDGET {
        Ok(br#"{"ok":false,"error":{"message":"Response exceeds 1 MiB"}}"#.to_vec())
    } else {
        Ok(bytes)
    }
}

pub(super) async fn serve<S: AsyncRead + AsyncWrite + Unpin>(
    stream: S,
    version: &str,
    handler: Arc<dyn RequestHandler>,
    token: &str,
    payload: Value,
    cors: VerifiedCorsOrigin<'_>,
) -> Result<(), String> {
    // Authentication and JSON parsing have already succeeded. Close-delimited
    // responses are valid in HTTP/1.0 and 1.1; neither CL nor TE is needed.
    let headers = format!("{version} 200 Response\r\nContent-Type: application/json\r\nConnection: close\r\nCache-Control: no-store\r\n{cors}\r\n ");
    let (mut reader, mut writer) = tokio::io::split(stream);
    #[cfg(any(test, feature = "legacy-node-smoke"))]
    handler.observe_transport(super::TransportObservation::RequestStart);
    write(&mut writer, headers.as_bytes()).await?;

    // Pin outside the loop: a heartbeat must never reconstruct or replay an
    // operation. Returning on EOF or a write failure drops this exact waiter.
    let operation = handler.handle(token, payload);
    tokio::pin!(operation);
    let mut heartbeat = tokio::time::interval_at(Instant::now() + HEARTBEAT, HEARTBEAT);
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut whitespace = 1;
    let mut disconnected = [0; 1];
    let result = loop {
        tokio::select! {
            result = &mut operation => {
                #[cfg(any(test, feature = "legacy-node-smoke"))]
                handler.observe_transport(super::TransportObservation::HandlerComplete);
                break result;
            },
            read = async {
                let read = reader.read(&mut disconnected).await;
                #[cfg(any(test, feature = "legacy-node-smoke"))]
                handler.observe_transport(match &read {
                    Ok(0) => super::TransportObservation::ReadEof,
                    Ok(_) => super::TransportObservation::ReadExtraBytes,
                    Err(error) => super::TransportObservation::ReadErrorKind(error.kind()),
                });
                read
            } => {
                let _ = read;
                return Err("Dialog connection closed".into());
            },
            _ = heartbeat.tick() => {
                if whitespace >= WHITESPACE_BUDGET {
                    return Err("Dialog response activity budget exceeded".into());
                }
                write(&mut writer, b" ").await?;
                whitespace += 1;
            },
        }
    };
    write(&mut writer, &result_body(result)?).await?;
    tokio::time::timeout(WRITE_DEADLINE, writer.shutdown())
        .await
        .map_err(|_| "Dialog response shutdown timed out")?
        .map_err(|_| "Dialog response connection closed".into())
}

#[cfg(test)]
#[path = "plugin_loopback_dialog_tests.rs"]
mod tests;
