use serde::Serialize;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, ReadBuf};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct StartupStdoutReadSnapshot {
    pub reader_polled: bool,
    pub bytes_read: u64,
    pub eof: bool,
    pub read_error: bool,
}

#[derive(Default)]
struct ObservationState {
    snapshot: StartupStdoutReadSnapshot,
    sealed: bool,
}

pub(crate) struct StartupStdoutReadObserver {
    state: Mutex<ObservationState>,
    sealed_fast: AtomicBool,
}

impl StartupStdoutReadObserver {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(ObservationState::default()),
            sealed_fast: AtomicBool::new(false),
        }
    }

    fn update(&self, update: impl FnOnce(&mut StartupStdoutReadSnapshot)) {
        if self.sealed_fast.load(Ordering::Acquire) {
            return;
        }
        if let Ok(mut state) = self.state.lock() {
            if !state.sealed {
                update(&mut state.snapshot);
            }
        }
    }

    pub(crate) fn mark_polled(&self) {
        self.update(|snapshot| snapshot.reader_polled = true);
    }

    pub(crate) fn record_bytes(&self, count: u64) {
        self.update(|snapshot| snapshot.bytes_read = snapshot.bytes_read.saturating_add(count));
    }

    pub(crate) fn mark_eof(&self) {
        self.update(|snapshot| snapshot.eof = true);
    }

    pub(crate) fn mark_read_error(&self) {
        self.update(|snapshot| snapshot.read_error = true);
    }

    pub(crate) fn seal(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.sealed = true;
            self.sealed_fast.store(true, Ordering::Release);
        }
    }

    pub(crate) fn snapshot(&self) -> StartupStdoutReadSnapshot {
        self.state
            .lock()
            .map(|state| state.snapshot)
            .unwrap_or_default()
    }
}

/// Counts metadata for an authorized startup trace without retaining stdout bytes.
pub(crate) struct ObservedStdoutReader<R> {
    inner: R,
    observer: Arc<StartupStdoutReadObserver>,
}

impl<R> ObservedStdoutReader<R> {
    pub(crate) fn new(inner: R, observer: Arc<StartupStdoutReadObserver>) -> Self {
        Self { inner, observer }
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for ObservedStdoutReader<R> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if buffer.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }

        this.observer.mark_polled();
        let before = buffer.filled().len();
        match Pin::new(&mut this.inner).poll_read(cx, buffer) {
            Poll::Ready(Ok(())) => {
                let count = buffer.filled().len().saturating_sub(before);
                if count == 0 {
                    this.observer.mark_eof();
                } else {
                    this.observer
                        .record_bytes(u64::try_from(count).unwrap_or(u64::MAX));
                }
                Poll::Ready(Ok(()))
            }
            Poll::Ready(Err(error)) => {
                this.observer.mark_read_error();
                Poll::Ready(Err(error))
            }
            Poll::Pending => Poll::Pending,
        }
    }
}
