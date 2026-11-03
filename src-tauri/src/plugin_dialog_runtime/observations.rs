//! Bounded smoke diagnostics. Events cannot contain credentials, paths or payloads.
#[cfg(any(test, feature = "legacy-node-smoke"))]
use std::io::ErrorKind;

#[derive(Clone, Copy)]
pub(super) enum Event {
    #[cfg(any(test, feature = "legacy-node-smoke"))]
    RequestStart,
    #[cfg(any(test, feature = "legacy-node-smoke"))]
    ReadEof,
    #[cfg(any(test, feature = "legacy-node-smoke"))]
    ReadExtraBytes,
    #[cfg(any(test, feature = "legacy-node-smoke"))]
    ReadError(ErrorKind),
    #[cfg(any(test, feature = "legacy-node-smoke"))]
    HandlerComplete,
    NativeAwait,
    NativeBegin,
    NativeResultSelected,
    NativeResultCancelled,
    NativeResultError,
    CancelSignal,
    Deadline,
    PendingDrop,
    CancelMain,
    NativeFinish,
    CloseCommand,
    Invalidate,
    CloseWindow,
    Stop,
    StopMain,
    OpeningDrop,
    InvocationDropComplete,
    InvocationDropPending,
    ValidationFailed,
    LifecycleClose,
}

#[cfg(any(test, feature = "legacy-node-smoke"))]
mod enabled {
    use super::{ErrorKind, Event};
    use parking_lot::Mutex;
    use serde::Serialize;
    use std::{collections::VecDeque, sync::OnceLock, time::Instant};

    const CAPACITY: usize = 128;
    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Entry {
        sequence: u64,
        elapsed_micros: u64,
        category: &'static str,
        detail: Option<&'static str>,
    }
    struct Recorder {
        started: Instant,
        sequence: u64,
        dropped: u64,
        entries: VecDeque<Entry>,
    }
    impl Recorder {
        fn new() -> Self {
            Self {
                started: Instant::now(),
                sequence: 0,
                dropped: 0,
                entries: VecDeque::with_capacity(CAPACITY),
            }
        }
        fn record(&mut self, event: Event) {
            let (category, detail) = classify(event);
            self.sequence += 1;
            if self.entries.len() == CAPACITY {
                self.entries.pop_front();
                self.dropped += 1;
            }
            self.entries.push_back(Entry {
                sequence: self.sequence,
                elapsed_micros: self.started.elapsed().as_micros().min(u64::MAX as u128) as u64,
                category,
                detail,
            });
        }
    }
    fn classify(event: Event) -> (&'static str, Option<&'static str>) {
        let category = match event {
            Event::RequestStart => "transport.request_start",
            Event::ReadEof => "transport.read_eof",
            Event::ReadExtraBytes => "transport.read_extra_bytes",
            Event::ReadError(kind) => {
                return (
                    "transport.read_error_kind",
                    Some(match kind {
                        ErrorKind::BrokenPipe => "broken_pipe",
                        ErrorKind::ConnectionReset => "connection_reset",
                        ErrorKind::ConnectionAborted => "connection_aborted",
                        ErrorKind::NotConnected => "not_connected",
                        ErrorKind::TimedOut => "timed_out",
                        ErrorKind::Interrupted => "interrupted",
                        ErrorKind::WouldBlock => "would_block",
                        ErrorKind::UnexpectedEof => "unexpected_eof",
                        ErrorKind::Other => "other",
                        _ => "other_kind",
                    }),
                )
            }
            Event::HandlerComplete => "transport.handler_complete",
            Event::NativeAwait => "native.await",
            Event::NativeBegin => "native.begin",
            Event::NativeResultSelected => "native.result_selected",
            Event::NativeResultCancelled => "native.result_cancelled",
            Event::NativeResultError => "native.result_error",
            Event::CancelSignal => "native.cancel_signal",
            Event::Deadline => "native.deadline",
            Event::PendingDrop => "native.pending_drop",
            Event::CancelMain => "native.cancel_main",
            Event::NativeFinish => "native.finish",
            Event::CloseCommand => "lifecycle.close_command",
            Event::Invalidate => "lifecycle.invalidate",
            Event::CloseWindow => "lifecycle.close_window",
            Event::Stop => "lifecycle.stop",
            Event::StopMain => "lifecycle.stop_main",
            Event::OpeningDrop => "lifecycle.opening_drop",
            Event::InvocationDropComplete => "lifecycle.invocation_drop_complete",
            Event::InvocationDropPending => "lifecycle.invocation_drop_pending",
            Event::ValidationFailed => "lifecycle.validation_failed",
            Event::LifecycleClose => "lifecycle.close",
        };
        (category, None)
    }
    static RECORDER: OnceLock<Mutex<Recorder>> = OnceLock::new();
    pub(super) fn note(event: Event) {
        RECORDER
            .get_or_init(|| Mutex::new(Recorder::new()))
            .lock()
            .record(event);
    }
    pub(super) fn snapshot() -> serde_json::Value {
        let (dropped, entries) = RECORDER.get().map_or_else(
            || (0, VecDeque::new()),
            |recorder| {
                let recorder = recorder.lock();
                (recorder.dropped, recorder.entries.clone())
            },
        );
        serde_json::json!({"schemaVersion":1,"capacity":CAPACITY,"droppedEvents":dropped,
            "clock":"rust_monotonic_since_first_dialog_observation","events":entries})
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn separates_transport_eof_error_and_explicit_lifecycle_categories() {
            assert_eq!(classify(Event::ReadEof), ("transport.read_eof", None));
            assert_eq!(
                classify(Event::ReadExtraBytes),
                ("transport.read_extra_bytes", None)
            );
            assert_eq!(
                classify(Event::ReadError(ErrorKind::ConnectionReset)),
                ("transport.read_error_kind", Some("connection_reset"))
            );
            assert_eq!(
                classify(Event::ReadError(ErrorKind::PermissionDenied)),
                ("transport.read_error_kind", Some("other_kind"))
            );
            assert_eq!(
                classify(Event::CloseCommand),
                ("lifecycle.close_command", None)
            );
            assert_ne!(
                classify(Event::NativeResultCancelled),
                classify(Event::CancelSignal)
            );
        }
        #[test]
        fn ring_remains_bounded_and_preserves_monotonic_order_after_overflow() {
            let mut recorder = Recorder::new();
            for _ in 0..(CAPACITY + 7) {
                recorder.record(Event::RequestStart);
            }
            assert_eq!(recorder.entries.len(), CAPACITY);
            assert_eq!(recorder.dropped, 7);
            assert_eq!(recorder.entries.front().unwrap().sequence, 8);
            assert_eq!(
                recorder.entries.back().unwrap().sequence,
                (CAPACITY + 7) as u64
            );
            let entries: Vec<_> = recorder.entries.iter().collect();
            assert!(entries.windows(2).all(
                |w| w[0].sequence < w[1].sequence && w[0].elapsed_micros <= w[1].elapsed_micros
            ));
            let json = serde_json::to_value(&recorder.entries).unwrap();
            assert_eq!(json[0].as_object().unwrap().len(), 4);
        }
        #[test]
        fn exported_snapshot_has_a_versioned_static_category_schema() {
            super::super::note(Event::RequestStart);
            let value = super::super::snapshot();
            assert_eq!(value["schemaVersion"], 1);
            assert_eq!(value["capacity"], CAPACITY);
            assert_eq!(
                value["clock"],
                "rust_monotonic_since_first_dialog_observation"
            );
            let entries = value["events"].as_array().unwrap();
            assert!(!entries.is_empty() && entries.len() <= CAPACITY);
            for entry in entries {
                assert_eq!(entry.as_object().unwrap().len(), 4);
                assert!(entry["sequence"].is_u64());
                assert!(entry["elapsedMicros"].is_u64());
                assert!(entry["category"].is_string());
                assert!(entry["detail"].is_null() || entry["detail"].is_string());
            }
        }
    }
}

#[inline]
pub(super) fn note(event: Event) {
    #[cfg(any(test, feature = "legacy-node-smoke"))]
    enabled::note(event);
    #[cfg(not(any(test, feature = "legacy-node-smoke")))]
    let _ = event;
}
#[cfg(any(test, feature = "legacy-node-smoke"))]
pub(super) fn snapshot() -> serde_json::Value {
    enabled::snapshot()
}
