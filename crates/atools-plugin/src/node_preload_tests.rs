use super::write_preload_input;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::AsyncWrite;

struct PendingWriter {
    started: Arc<AtomicBool>,
    dropped: Arc<AtomicBool>,
}

impl AsyncWrite for PendingWriter {
    fn poll_write(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
        _buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.started.store(true, Ordering::Release);
        Poll::Pending
    }

    fn poll_flush(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
    ) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
    ) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl Drop for PendingWriter {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::Release);
    }
}

#[tokio::test]
async fn stalled_preload_input_is_bounded_by_the_shared_operation_deadline() {
    let started = Arc::new(AtomicBool::new(false));
    let dropped = Arc::new(AtomicBool::new(false));
    let writer = PendingWriter {
        started: Arc::clone(&started),
        dropped: Arc::clone(&dropped),
    };
    let began = tokio::time::Instant::now();
    let deadline = began + Duration::from_millis(25);

    let error = write_preload_input(writer, b"bounded fixture", deadline)
        .await
        .expect_err("a backpressured writer must not outlive the operation deadline");

    assert!(format!("{error:#}").contains("timed out after 15s while sending request"));
    assert!(started.load(Ordering::Acquire), "the writer was actually polled");
    assert!(dropped.load(Ordering::Acquire), "timeout drops the owned stdin writer");
    assert!(began.elapsed() < Duration::from_secs(1));
}

#[derive(Clone, Copy)]
enum FailurePoint {
    Write,
    Shutdown,
}

struct FailingWriter(FailurePoint);

impl AsyncWrite for FailingWriter {
    fn poll_write(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.0 {
            FailurePoint::Write => Poll::Ready(Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "fixture write failure",
            ))),
            FailurePoint::Shutdown => Poll::Ready(Ok(buffer.len())),
        }
    }

    fn poll_flush(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
    ) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
    ) -> Poll<io::Result<()>> {
        match self.0 {
            FailurePoint::Write => Poll::Ready(Ok(())),
            FailurePoint::Shutdown => Poll::Ready(Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "fixture shutdown failure",
            ))),
        }
    }
}

#[tokio::test]
async fn preload_input_write_and_shutdown_failures_keep_context() {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    let write_error = write_preload_input(FailingWriter(FailurePoint::Write), b"payload", deadline)
        .await
        .expect_err("write errors must propagate");
    assert!(format!("{write_error:#}").contains("Failed writing NodePreloadBridge request"));

    let shutdown_error = write_preload_input(
        FailingWriter(FailurePoint::Shutdown),
        b"payload",
        deadline,
    )
    .await
    .expect_err("shutdown errors must propagate");
    assert!(format!("{shutdown_error:#}").contains("Failed closing NodePreloadBridge stdin"));
}
