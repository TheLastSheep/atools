use super::super::{
    EngineLimits, NativeImageCancellation, NativeImageEngine, NativeImageError, OpenSourceKind,
};
use super::encoded_fixture;
use image::ImageFormat;

fn small_limits() -> EngineLimits {
    let mut limits = EngineLimits::default();
    limits.max_source_bytes = 1024 * 1024;
    limits.max_session_bytes = 4 * 1024 * 1024;
    limits.max_global_bytes = 8 * 1024 * 1024;
    limits
}

#[test]
fn smoke_snapshot_tracks_open_reservation_and_cancelled_reservation_release() {
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
    let reserved = reservation.max_bytes();
    let snapshot = engine.smoke_snapshot();
    assert_eq!(snapshot.global_source_bytes, 0);
    assert_eq!(snapshot.global_reserved_bytes, reserved);
    assert_eq!(snapshot.handles, 0);
    assert_eq!(snapshot.unique_sources, 0);
    assert_eq!(snapshot.open_reservations, 1);
    assert_eq!(snapshot.session_count, 1);
    drop(reservation);
    let cancelled = engine.smoke_snapshot();
    assert_eq!(cancelled.global_reserved_bytes, 0);
    assert_eq!(cancelled.open_reservations, 0);
    assert_eq!(cancelled.session_count, 1);
}

#[test]
fn smoke_snapshot_keeps_late_source_and_handle_charges_until_last_lease_drops() {
    let engine = NativeImageEngine::with_limits(small_limits());
    let session = engine.new_session();
    let bytes = encoded_fixture(ImageFormat::Png, 1, 1);
    let byte_length = bytes.len();
    let descriptor = engine
        .open_bytes(
            &session,
            engine
                .reserve_open(&session, OpenSourceKind::WebViewBuffer { byte_length })
                .unwrap(),
            bytes,
            engine.try_worker().unwrap(),
            &NativeImageCancellation::default(),
        )
        .unwrap();
    let late_lease = session.snapshot(&descriptor.handle_id).unwrap();
    let opened = engine.smoke_snapshot();
    assert_eq!(opened.global_source_bytes, byte_length);
    assert_eq!(opened.global_reserved_bytes, 0);
    assert_eq!(opened.handles, 1);
    assert_eq!(opened.unique_sources, 1);
    assert_eq!(opened.open_reservations, 0);
    assert_eq!(opened.session_count, 1);

    session.close();
    let closed_but_leased = engine.smoke_snapshot();
    assert_eq!(closed_but_leased.global_source_bytes, byte_length);
    assert_eq!(closed_but_leased.handles, 1);
    assert_eq!(closed_but_leased.unique_sources, 1);
    assert_eq!(closed_but_leased.session_count, 1);
    assert!(matches!(
        session.snapshot(&descriptor.handle_id),
        Err(NativeImageError::SessionClosed)
    ));

    drop(late_lease);
    let drained = engine.smoke_snapshot();
    assert_eq!(drained.global_source_bytes, 0);
    assert_eq!(drained.global_reserved_bytes, 0);
    assert_eq!(drained.handles, 0);
    assert_eq!(drained.unique_sources, 0);
    assert_eq!(drained.open_reservations, 0);
    assert_eq!(drained.session_count, 0);
}

#[test]
fn smoke_snapshot_worker_busy_waits_for_last_retained_permit() {
    let engine = NativeImageEngine::with_limits(small_limits());
    assert!(!engine.smoke_snapshot().worker_busy);
    let permit = engine.try_worker().unwrap();
    let retained = permit.retain();
    assert!(engine.smoke_snapshot().worker_busy);
    drop(permit);
    assert!(engine.smoke_snapshot().worker_busy);
    assert!(matches!(
        engine.try_worker(),
        Err(NativeImageError::WorkerBusy)
    ));
    drop(retained);
    assert!(!engine.smoke_snapshot().worker_busy);
    assert!(engine.try_worker().is_ok());
}
