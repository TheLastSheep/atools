use super::error::RequestFailure;
use super::protocol::{error_errno, MAX_CREDIT_GRANT, MAX_OUTPUT_BYTES, MAX_STREAM_CREDIT};
use base64::Engine;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::ChildStdin;
use tokio::sync::{mpsc, Semaphore};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum OutputStream {
    Stdout,
    Stderr,
}

impl OutputStream {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
        }
    }
}

pub(super) enum StreamMessage {
    Closed(OutputStream),
    Failed(OutputStream, String),
    StdinClosed,
}

pub(super) enum StdinMessage {
    Write { write_id: u64, bytes: Vec<u8> },
    End { write_id: u64 },
}

pub(super) struct CreditGate {
    semaphore: Arc<Semaphore>,
    outstanding: AtomicUsize,
}

impl CreditGate {
    pub(super) fn new(initial: usize) -> Self {
        Self {
            semaphore: Arc::new(Semaphore::new(initial)),
            outstanding: AtomicUsize::new(initial),
        }
    }

    pub(super) fn grant(&self, count: usize) -> Result<(), RequestFailure> {
        if count == 0 || count > MAX_CREDIT_GRANT {
            return Err(RequestFailure::invalid(
                "credit count is outside the allowed range",
            ));
        }
        self.outstanding
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current.checked_add(count)? <= MAX_STREAM_CREDIT).then_some(current + count)
            })
            .map_err(|_| RequestFailure::invalid("stream credit budget exceeded"))?;
        self.semaphore.add_permits(count);
        Ok(())
    }

    pub(super) async fn consume(self: &Arc<Self>) -> Option<CreditLease> {
        match Arc::clone(&self.semaphore).acquire_owned().await {
            Ok(permit) => {
                permit.forget();
                Some(CreditLease {
                    gate: Arc::clone(self),
                })
            }
            Err(_) => None,
        }
    }
}

pub(super) struct CreditLease {
    gate: Arc<CreditGate>,
}

impl Drop for CreditLease {
    fn drop(&mut self) {
        self.gate.outstanding.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(super) async fn output_reader<R: AsyncRead + Unpin + Send + 'static>(
    mut reader: R,
    child_id: u64,
    stream: OutputStream,
    credits: Arc<CreditGate>,
    events: mpsc::Sender<Value>,
    stream_events: mpsc::Sender<StreamMessage>,
) {
    let mut buffer = [0u8; MAX_OUTPUT_BYTES];
    loop {
        let Some(_credit) = credits.consume().await else {
            return;
        };
        match reader.read(&mut buffer).await {
            Ok(0) => {
                let event =
                    json!({"childId":child_id.to_string(),"event":"end","stream":stream.as_str()});
                if events.send(event).await.is_ok() {
                    let _ = stream_events.send(StreamMessage::Closed(stream)).await;
                }
                return;
            }
            Ok(length) => {
                let event = json!({
                    "childId":child_id.to_string(),
                    "event":"data",
                    "stream":stream.as_str(),
                    "data":base64::engine::general_purpose::STANDARD.encode(&buffer[..length]),
                });
                if events.send(event).await.is_err() {
                    return;
                }
            }
            Err(error) => {
                let _ = stream_events
                    .send(StreamMessage::Failed(stream, error.to_string()))
                    .await;
                return;
            }
        }
    }
}

pub(super) async fn stdin_writer(
    mut stdin: ChildStdin,
    child_id: u64,
    mut writes: mpsc::Receiver<StdinMessage>,
    events: mpsc::Sender<Value>,
    stream_events: mpsc::Sender<StreamMessage>,
) {
    while let Some(message) = writes.recv().await {
        let is_end = matches!(message, StdinMessage::End { .. });
        let (write_id, result) = match message {
            StdinMessage::Write { write_id, bytes } => (write_id, stdin.write_all(&bytes).await),
            StdinMessage::End { write_id } => (write_id, stdin.shutdown().await),
        };
        let event = match result {
            Ok(()) => json!({"childId":child_id.to_string(),"event":"writeAck","writeId":write_id}),
            Err(error) => {
                let mut failure = json!({
                    "code":"ERR_ATOOLS_CHILD_STDIN_WRITE",
                    "message":error.to_string(),
                });
                if let Some(errno) = error_errno(&error) {
                    failure["errno"] = json!(errno);
                }
                json!({"childId":child_id.to_string(),"event":"writeAck","writeId":write_id,"error":failure})
            }
        };
        if events.send(event).await.is_err() {
            return;
        }
        if is_end {
            let _ = stream_events.send(StreamMessage::StdinClosed).await;
            return;
        }
    }
    let _ = stream_events.send(StreamMessage::StdinClosed).await;
}

#[cfg(test)]
mod tests {
    use super::{output_reader, CreditGate, OutputStream, StreamMessage};
    use std::io;
    use std::pin::Pin;
    use std::sync::Arc;
    use std::task::{Context, Poll};
    use tokio::io::{AsyncRead, ReadBuf};
    use tokio::sync::mpsc;
    use tokio::time::{timeout, Duration};

    struct FailedReader;

    impl AsyncRead for FailedReader {
        fn poll_read(
            self: Pin<&mut Self>,
            _context: &mut Context<'_>,
            _buffer: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            Poll::Ready(Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "fixture output read failure",
            )))
        }
    }

    #[tokio::test]
    async fn output_read_failure_reaches_actor_while_external_event_queue_is_full() {
        let (events_tx, mut events_rx) = mpsc::channel(1);
        let (stream_tx, mut stream_rx) = mpsc::channel(1);
        events_tx
            .send(serde_json::json!({"event":"occupies-queue"}))
            .await
            .unwrap();
        timeout(
            Duration::from_millis(100),
            output_reader(
                FailedReader,
                42,
                OutputStream::Stdout,
                Arc::new(CreditGate::new(1)),
                events_tx,
                stream_tx,
            ),
        )
        .await
        .expect("output failure must not wait for the external event queue");

        assert!(matches!(
            stream_rx.recv().await,
            Some(StreamMessage::Failed(OutputStream::Stdout, message))
                if message == "fixture output read failure"
        ));
        assert_eq!(
            events_rx.recv().await.unwrap()["event"],
            "occupies-queue",
            "the output reader leaves terminal event delivery to its actor"
        );
    }
}
