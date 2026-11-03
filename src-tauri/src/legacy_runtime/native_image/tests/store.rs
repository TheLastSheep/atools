use super::encoded_fixture;
use crate::legacy_runtime::native_image::{
    EngineLimits, NativeImageCancellation, NativeImageEngine, NativeImageError, OpenSourceKind,
};
use image::ImageFormat;
use std::sync::Arc;

fn small_limits() -> EngineLimits {
    let mut limits = EngineLimits::default();
    limits.max_source_bytes = 1024 * 1024;
    limits.max_session_bytes = 4 * 1024 * 1024;
    limits.max_global_bytes = 8 * 1024 * 1024;
    limits.max_handles_per_session = 4;
    limits.max_open_per_session = 2;
    limits
}

#[test]
fn reservation_is_charged_before_io_and_limited_per_session() {
    let engine = NativeImageEngine::with_limits(small_limits());
    let session = engine.new_session();
    let first = engine
        .reserve_open(&session, OpenSourceKind::NodePath)
        .unwrap();
    let second = engine
        .reserve_open(
            &session,
            OpenSourceKind::WebViewBuffer {
                byte_length: 512 * 1024,
            },
        )
        .unwrap();
    assert_eq!(first.max_bytes(), 1024 * 1024);
    assert_eq!(second.max_bytes(), 512 * 1024);
    assert_eq!(session.accounting().1, 1536 * 1024);
    assert!(matches!(
        engine.reserve_open(&session, OpenSourceKind::NodePath),
        Err(NativeImageError::OpenBusy)
    ));
    drop(first);
    assert_eq!(session.accounting().1, 512 * 1024);
}

#[test]
fn reservation_uses_the_smaller_session_budget_when_it_is_tighter() {
    let mut limits = small_limits();
    limits.max_session_bytes = 600 * 1024;
    limits.max_global_bytes = 8 * 1024 * 1024;
    let engine = NativeImageEngine::with_limits(limits);
    let session = engine.new_session();

    let reservation = engine
        .reserve_open(&session, OpenSourceKind::NodePath)
        .unwrap();
    assert_eq!(reservation.max_bytes(), 600 * 1024);
    assert_eq!(session.accounting().1, 600 * 1024);
    assert!(matches!(
        engine.reserve_open(&session, OpenSourceKind::NodePath),
        Err(NativeImageError::BudgetExceeded)
    ));
}

#[test]
fn reservations_share_global_budget_and_commit_only_actual_source_bytes() {
    let mut limits = small_limits();
    limits.max_global_bytes = 600 * 1024;
    limits.max_session_bytes = 600 * 1024;
    let engine = NativeImageEngine::with_limits(limits);
    let first_session = engine.new_session();
    let image = encoded_fixture(ImageFormat::Png, 1, 1);
    let expected = image.len();
    let first_reservation = engine
        .reserve_open(
            &first_session,
            OpenSourceKind::WebViewBuffer {
                byte_length: expected,
            },
        )
        .unwrap();
    let descriptor = engine
        .open_bytes(
            &first_session,
            first_reservation,
            image,
            engine.try_worker().unwrap(),
            &NativeImageCancellation::default(),
        )
        .unwrap();
    assert_eq!(first_session.accounting().0, expected);
    assert_eq!(first_session.accounting().1, 0);
    assert!(!descriptor.handle_id.is_empty());

    let second_session = engine.new_session();
    let remaining = engine
        .reserve_open(&second_session, OpenSourceKind::NodePath)
        .unwrap();
    assert_eq!(remaining.max_bytes(), 600 * 1024 - expected);
    assert!(matches!(
        engine.reserve_open(&second_session, OpenSourceKind::NodePath),
        Err(NativeImageError::BudgetExceeded)
    ));
    first_session.close();
    assert_eq!(first_session.accounting().2, 0);
    drop(remaining);
    assert!(engine
        .reserve_open(&second_session, OpenSourceKind::NodePath)
        .is_ok());
}

#[test]
fn close_revokes_handles_but_late_snapshot_keeps_budget_until_last_reference_drops() {
    let engine = NativeImageEngine::with_limits(small_limits());
    let session = engine.new_session();
    let bytes = encoded_fixture(ImageFormat::Png, 1, 1);
    let expected = bytes.len();
    let descriptor = engine
        .open_bytes(
            &session,
            engine
                .reserve_open(
                    &session,
                    OpenSourceKind::WebViewBuffer {
                        byte_length: bytes.len(),
                    },
                )
                .unwrap(),
            bytes,
            engine.try_worker().unwrap(),
            &NativeImageCancellation::default(),
        )
        .unwrap();
    let late_worker_reference = session.snapshot(&descriptor.handle_id).unwrap();
    session.close();
    assert!(session.is_closed());
    assert_eq!(session.accounting().0, expected);
    assert_eq!(session.accounting().2, expected);
    assert!(matches!(
        session.snapshot(&descriptor.handle_id),
        Err(NativeImageError::SessionClosed)
    ));
    drop(late_worker_reference);
    assert_eq!(session.accounting().2, 0);
}

#[test]
fn duplicate_content_shares_one_source_but_keeps_distinct_handles_and_late_budget() {
    let engine = NativeImageEngine::with_limits(small_limits());
    let session = engine.new_session();
    let bytes = encoded_fixture(ImageFormat::Png, 1, 1);
    let byte_count = bytes.len();
    let first = engine
        .open_bytes(
            &session,
            engine
                .reserve_open(
                    &session,
                    OpenSourceKind::WebViewBuffer {
                        byte_length: byte_count,
                    },
                )
                .unwrap(),
            bytes.clone(),
            engine.try_worker().unwrap(),
            &NativeImageCancellation::default(),
        )
        .unwrap();
    let second = engine
        .open_bytes(
            &session,
            engine
                .reserve_open(
                    &session,
                    OpenSourceKind::WebViewBuffer {
                        byte_length: byte_count,
                    },
                )
                .unwrap(),
            bytes,
            engine.try_worker().unwrap(),
            &NativeImageCancellation::default(),
        )
        .unwrap();
    let first_worker = session.snapshot(&first.handle_id).unwrap();
    let second_worker = session.snapshot(&second.handle_id).unwrap();
    assert_ne!(first.handle_id, second.handle_id);
    assert!(Arc::ptr_eq(&first_worker.source, &second_worker.source));
    assert_eq!(session.accounting().0, byte_count);
    assert_eq!(session.accounting().4, 2);
    assert_eq!(session.accounting().5, 1);

    session.close();
    assert_eq!(session.accounting().0, byte_count);
    drop(first_worker);
    assert_eq!(session.accounting().0, byte_count);
    assert_eq!(session.accounting().4, 1);
    drop(second_worker);
    assert_eq!(session.accounting().0, 0);
    assert_eq!(session.accounting().2, 0);
    assert_eq!(session.accounting().4, 0);
}

#[test]
fn distinct_sources_charge_unique_bytes_and_dedup_does_not_cross_sessions() {
    let engine = NativeImageEngine::with_limits(small_limits());
    let first_session = engine.new_session();
    let second_session = engine.new_session();
    let first_bytes = encoded_fixture(ImageFormat::Png, 1, 1);
    let second_bytes = encoded_fixture(ImageFormat::Png, 2, 1);
    let first_len = first_bytes.len();
    let second_len = second_bytes.len();
    let first = engine
        .open_bytes(
            &first_session,
            engine
                .reserve_open(
                    &first_session,
                    OpenSourceKind::WebViewBuffer {
                        byte_length: first_len,
                    },
                )
                .unwrap(),
            first_bytes.clone(),
            engine.try_worker().unwrap(),
            &NativeImageCancellation::default(),
        )
        .unwrap();
    engine
        .open_bytes(
            &first_session,
            engine
                .reserve_open(
                    &first_session,
                    OpenSourceKind::WebViewBuffer {
                        byte_length: second_len,
                    },
                )
                .unwrap(),
            second_bytes,
            engine.try_worker().unwrap(),
            &NativeImageCancellation::default(),
        )
        .unwrap();
    let cross_session = engine
        .open_bytes(
            &second_session,
            engine
                .reserve_open(
                    &second_session,
                    OpenSourceKind::WebViewBuffer {
                        byte_length: first_len,
                    },
                )
                .unwrap(),
            first_bytes,
            engine.try_worker().unwrap(),
            &NativeImageCancellation::default(),
        )
        .unwrap();
    assert_eq!(first_session.accounting().0, first_len + second_len);
    assert_eq!(first_session.accounting().5, 2);
    assert_eq!(
        first_session.accounting().2,
        first_len + second_len + first_len
    );
    assert_eq!(second_session.accounting().0, first_len);
    assert_eq!(second_session.accounting().5, 1);
    let first_snapshot = first_session.snapshot(&first.handle_id).unwrap();
    let cross_snapshot = second_session.snapshot(&cross_session.handle_id).unwrap();
    assert!(!Arc::ptr_eq(&first_snapshot.source, &cross_snapshot.source));
}

#[test]
fn closing_session_keeps_open_reservation_charged_until_late_reader_releases_it() {
    let engine = NativeImageEngine::with_limits(small_limits());
    let session = engine.new_session();
    let reservation = engine
        .reserve_open(&session, OpenSourceKind::NodePath)
        .unwrap();
    session.close();
    assert_eq!(session.accounting().1, 1024 * 1024);
    drop(reservation);
    assert_eq!(session.accounting().1, 0);
    assert_eq!(session.accounting().3, 0);
}

#[test]
fn worker_gate_is_global_nonblocking_and_raii_releases_only_on_drop() {
    let engine = NativeImageEngine::with_limits(small_limits());
    let permit = engine.try_worker().unwrap();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let _permit = permit;
        started_tx.send(()).unwrap();
        release_rx.recv().unwrap();
    });
    started_rx.recv().unwrap();
    assert!(matches!(
        engine.try_worker(),
        Err(NativeImageError::WorkerBusy)
    ));
    release_tx.send(()).unwrap();
    worker.join().unwrap();
    assert!(engine.try_worker().is_ok());
}

#[test]
fn path_and_webview_buffer_reservations_have_separate_caps() {
    let engine = NativeImageEngine::new();
    let session = engine.new_session();
    let buffer = engine
        .reserve_open(&session, OpenSourceKind::WebViewBuffer { byte_length: 12 })
        .unwrap();
    assert_eq!(buffer.max_bytes(), 12);
    drop(buffer);
    let path = engine
        .reserve_open(&session, OpenSourceKind::NodePath)
        .unwrap();
    assert_eq!(path.max_bytes(), 4 * 1024 * 1024);
}

#[test]
fn buffer_reservation_must_match_declared_length_and_releases_capacity_on_rejection() {
    let engine = NativeImageEngine::with_limits(small_limits());
    let session = engine.new_session();
    let bytes = encoded_fixture(ImageFormat::Png, 1, 1);
    let expected = bytes.len() + 1;
    let reservation = engine
        .reserve_open(
            &session,
            OpenSourceKind::WebViewBuffer {
                byte_length: expected,
            },
        )
        .unwrap();
    assert!(matches!(
        engine.open_bytes(
            &session,
            reservation,
            bytes,
            engine.try_worker().unwrap(),
            &NativeImageCancellation::default(),
        ),
        Err(NativeImageError::SourceTooLarge)
    ));
    assert_eq!(session.accounting().1, 0);
    assert_eq!(session.accounting().3, 0);
}

#[test]
fn handle_capacity_is_reserved_before_io() {
    let mut limits = small_limits();
    limits.max_handles_per_session = 1;
    let engine = NativeImageEngine::with_limits(limits);
    let session = engine.new_session();
    let bytes = encoded_fixture(ImageFormat::Png, 1, 1);
    let descriptor = engine
        .open_bytes(
            &session,
            engine
                .reserve_open(
                    &session,
                    OpenSourceKind::WebViewBuffer {
                        byte_length: bytes.len(),
                    },
                )
                .unwrap(),
            bytes,
            engine.try_worker().unwrap(),
            &NativeImageCancellation::default(),
        )
        .unwrap();
    assert!(matches!(
        engine.reserve_open(&session, OpenSourceKind::NodePath),
        Err(NativeImageError::BudgetExceeded)
    ));
    session.close();
    assert!(matches!(
        session.snapshot(&descriptor.handle_id),
        Err(NativeImageError::SessionClosed)
    ));
}

#[test]
fn retained_worker_lease_keeps_gate_busy_after_engine_consumes_original_permit() {
    let engine = NativeImageEngine::with_limits(small_limits());
    let session = engine.new_session();
    let bytes = encoded_fixture(ImageFormat::Png, 1, 1);
    let reservation = engine
        .reserve_open(
            &session,
            OpenSourceKind::WebViewBuffer {
                byte_length: bytes.len(),
            },
        )
        .unwrap();
    let permit = engine.try_worker().unwrap();
    let closure_lease = permit.retain();

    engine
        .open_bytes(
            &session,
            reservation,
            bytes,
            permit,
            &NativeImageCancellation::default(),
        )
        .unwrap();
    assert!(matches!(
        engine.try_worker(),
        Err(NativeImageError::WorkerBusy)
    ));

    drop(closure_lease);
    assert!(engine.try_worker().is_ok());
}
