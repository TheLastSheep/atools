use super::io::read_stdout_lines;
use super::startup_diagnostics::{
    StartupParseOutcome, StartupPhase, StartupProcessStatus, StartupResolutionSource,
    StartupResponseOutcome, StartupTrace, StartupTryWait,
};
use super::stdout_observation::StartupStdoutReadObserver;
use crate::sidecar::SidecarError;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{duplex, AsyncWriteExt};
use tokio::sync::mpsc;

fn snapshot(trace: &StartupTrace) -> super::startup_diagnostics::StartupDiagnosticSnapshot {
    trace.snapshot(None, StartupProcessStatus::Running, false)
}

#[tokio::test]
async fn partial_unterminated_stdout_is_observed_before_line_framing_completes() {
    let trace = Arc::new(StartupTrace::new());
    let (mut writer, reader) = duplex(128);
    let (line_tx, mut line_rx) = mpsc::channel(4);
    let task = tokio::spawn(read_stdout_lines(reader, line_tx, Some(trace.clone())));
    let partial = b"{\"jsonrpc\":\"2.0\"";
    writer.write_all(partial).await.unwrap();

    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if snapshot(&trace).stdout_read.bytes_read > 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("reader should count partial bytes while read_until waits for LF");
    let waiting = snapshot(&trace);
    assert!(waiting.stdout_read.reader_polled);
    assert_eq!(waiting.stdout_read.bytes_read, partial.len() as u64);
    assert!(!waiting.stdout_read.eof);
    assert!(!waiting.stdout_read.read_error);
    assert!(!waiting.events.iter().any(|event| {
        event.phase == super::startup_diagnostics::StartupPhase::FirstStdoutParsed
    }));
    assert!(serde_json::to_vec(&waiting).unwrap().len() <= 2048);
    assert!(!serde_json::to_string(&waiting)
        .unwrap()
        .contains(std::str::from_utf8(partial).unwrap()));

    drop(writer);
    task.await.unwrap();
    assert!(matches!(
        line_rx.recv().await,
        Some(Err(SidecarError::Protocol(_)))
    ));
    let finished = snapshot(&trace);
    assert_eq!(finished.stdout_read.bytes_read, partial.len() as u64);
    assert!(finished.stdout_read.eof);
    assert!(!finished.stdout_read.read_error);
    assert!(finished.events.iter().any(|event| {
        event.phase == super::startup_diagnostics::StartupPhase::FirstStdoutParsed
            && event.parse_outcome == Some(StartupParseOutcome::InvalidJson)
    }));
}

#[tokio::test]
async fn empty_stdout_eof_is_distinguished_from_an_unpolled_reader() {
    let trace = Arc::new(StartupTrace::new());
    let (writer, reader) = duplex(8);
    drop(writer);
    let (line_tx, _line_rx) = mpsc::channel(1);
    read_stdout_lines(reader, line_tx, Some(trace.clone())).await;

    let stdout = snapshot(&trace).stdout_read;
    assert!(stdout.reader_polled);
    assert_eq!(stdout.bytes_read, 0);
    assert!(stdout.eof);
    assert!(!stdout.read_error);
}

struct FailingReader;

impl tokio::io::AsyncRead for FailingReader {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
        _buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Err(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "fixture read error",
        )))
    }
}

#[tokio::test]
async fn stdout_read_error_is_typed_without_capturing_error_text() {
    let trace = Arc::new(StartupTrace::new());
    let (line_tx, mut line_rx) = mpsc::channel(1);
    read_stdout_lines(FailingReader, line_tx, Some(trace.clone())).await;
    assert!(matches!(
        line_rx.recv().await,
        Some(Err(SidecarError::Crashed(_)))
    ));

    let report = snapshot(&trace);
    assert!(report.stdout_read.reader_polled);
    assert_eq!(report.stdout_read.bytes_read, 0);
    assert!(!report.stdout_read.eof);
    assert!(report.stdout_read.read_error);
    let encoded = serde_json::to_string(&report).unwrap();
    assert!(!encoded.contains("fixture read error"));
    assert!(encoded.len() <= 2048);
}

#[tokio::test]
async fn diagnostics_disabled_keeps_json_line_delivery_without_observer() {
    let (mut writer, reader) = duplex(128);
    let (line_tx, mut line_rx) = mpsc::channel(2);
    writer
        .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n")
        .await
        .unwrap();
    drop(writer);
    read_stdout_lines(reader, line_tx, None).await;

    let value = line_rx.recv().await.unwrap().unwrap();
    assert_eq!(value["id"], 1);
    assert!(value["result"].is_object());
}

#[test]
fn stdout_byte_count_saturates_and_trace_seal_stops_observation() {
    let observer = StartupStdoutReadObserver::new();
    observer.record_bytes(u64::MAX);
    observer.record_bytes(1);
    assert_eq!(observer.snapshot().bytes_read, u64::MAX);

    let trace = StartupTrace::new();
    let trace_observer = trace.stdout_read_observer();
    trace_observer.record_bytes(5);
    let before_seal = snapshot(&trace).stdout_read;
    trace.seal();
    trace_observer.record_bytes(7);
    trace_observer.mark_eof();

    let sealed = snapshot(&trace);
    assert_eq!(sealed.stdout_read, before_seal);
    assert_eq!(sealed.stdout_read.bytes_read, 5);
    assert!(!sealed.stdout_read.eof);
    assert!(serde_json::to_vec(&sealed).unwrap().len() <= 2048);
}

#[test]
fn startup_snapshot_budget_covers_all_phases_and_maximum_typed_metadata() {
    let trace = StartupTrace::new();
    let phases = [
        StartupPhase::NodeResolveStarted,
        StartupPhase::NodeResolved,
        StartupPhase::SidecarSpawned,
        StartupPhase::SidecarRunning,
    ];
    for phase in phases {
        trace.record(phase, None, None);
    }
    trace.record(
        StartupPhase::InitializeRequestWritten,
        Some(u64::MAX),
        Some(u64::MAX),
    );
    trace.record_first_stdout(StartupParseOutcome::Parsed);
    trace.record_initialize_response(u64::MAX, StartupResponseOutcome::Result);
    trace.record_node_version(Some("1234567.1234567.12345678"));
    trace.record_selected_executable_path(std::path::Path::new("node"));
    trace.record(StartupPhase::InitializeCompleted, None, None);

    let stderr = vec![b'x'; 300 * 1024];
    trace.record_stderr(&stderr);
    trace.record_try_wait(StartupTryWait::Exited(Some(255)));
    trace.record_cleanup_completed(true);
    let stdout = trace.stdout_read_observer();
    stdout.mark_polled();
    stdout.record_bytes(u64::MAX);
    stdout.mark_eof();
    trace.seal();

    let complete = trace.snapshot(Some(u32::MAX), StartupProcessStatus::Crashed, true);
    let complete_json = serde_json::to_vec(&complete).unwrap();
    assert!(
        complete_json.len() <= 2048,
        "complete startup snapshot serialized to {} bytes (limit 2048)",
        complete_json.len()
    );
    assert_eq!(complete.events.len(), 8);
    assert_eq!(complete.owned_pid, Some(u32::MAX));
    assert_eq!(
        complete.resolution_source,
        Some(StartupResolutionSource::SharedProductionResolver)
    );
    assert_eq!(
        complete
            .selected_executable_path_sha256
            .as_ref()
            .unwrap()
            .len(),
        64
    );
    assert_eq!(
        complete.node_version.as_deref(),
        Some("1234567.1234567.12345678")
    );
    assert_eq!(complete.stderr_bytes, 300 * 1024);
    assert_eq!(complete.stderr_hashed_bytes, 256 * 1024);
    assert!(complete.stderr_truncated);
    assert_eq!(complete.stderr_sha256.as_ref().unwrap().len(), 64);
    assert_eq!(complete.last_try_wait, StartupTryWait::Exited(Some(255)));
    assert!(complete.cleanup_required);
    assert_eq!(complete.cleanup_completed, Some(true));
    assert_eq!(complete.stdout_read.bytes_read, u64::MAX);
    assert!(complete.stdout_read.reader_polled);
    assert!(complete.stdout_read.eof);
    assert!(complete.events.iter().any(|event| {
        event.phase == StartupPhase::InitializeRequestWritten
            && event.request_id == Some(u64::MAX)
            && event.bytes_written == Some(u64::MAX)
            && event.parse_outcome.is_none()
            && event.response_outcome.is_none()
    }));
    assert!(complete.events.iter().any(|event| {
        event.phase == StartupPhase::FirstStdoutParsed
            && event.parse_outcome == Some(StartupParseOutcome::Parsed)
            && event.response_outcome.is_none()
    }));
    assert!(complete.events.iter().any(|event| {
        event.phase == StartupPhase::InitializeResponseMatched
            && event.request_id == Some(u64::MAX)
            && event.response_outcome == Some(StartupResponseOutcome::Result)
            && event.parse_outcome.is_none()
    }));

    // Resolution failure is mutually exclusive with a resolved runtime and
    // spawned process, so cover that real failure trace separately.
    let failed_resolution = StartupTrace::new();
    failed_resolution.record(StartupPhase::NodeResolveStarted, None, None);
    failed_resolution.record(StartupPhase::NodeResolveFailed, None, None);
    failed_resolution.seal();
    let failed = failed_resolution.snapshot(None, StartupProcessStatus::Unavailable, false);
    let failed_json = serde_json::to_vec(&failed).unwrap();
    assert!(
        failed_json.len() <= 2048,
        "failed-resolution snapshot serialized to {} bytes (limit 2048)",
        failed_json.len()
    );

    let covered = complete
        .events
        .iter()
        .chain(failed.events.iter())
        .map(|event| event.phase)
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(covered.len(), 9);
    for phase in [
        StartupPhase::NodeResolveStarted,
        StartupPhase::NodeResolved,
        StartupPhase::NodeResolveFailed,
        StartupPhase::SidecarSpawned,
        StartupPhase::SidecarRunning,
        StartupPhase::InitializeRequestWritten,
        StartupPhase::FirstStdoutParsed,
        StartupPhase::InitializeResponseMatched,
        StartupPhase::InitializeCompleted,
    ] {
        assert!(covered.contains(&phase), "missing phase {phase:?}");
    }
}
