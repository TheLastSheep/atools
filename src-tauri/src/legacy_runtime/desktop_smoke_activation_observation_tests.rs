use super::*;

fn observation() -> Observation {
    Observation::new("dev.atools.fixture.dialog.0123456789abcdef0123456789abcdef".into())
}

#[test]
fn exact_temporary_bundle_identity_is_closed_and_lowercase() {
    assert!(expected_bundle(
        "dev.atools.fixture.dialog.0123456789abcdef0123456789abcdef"
    ));
    for value in [
        "dev.atools.desktop",
        "dev.atools.fixture.dialog.",
        "dev.atools.fixture.dialog.0123456789ABCDEF0123456789ABCDEF",
        "dev.atools.fixture.dialog.0123456789abcdef0123456789abcde/",
        "dev.atools.fixture.dialog.0123456789abcdef0123456789abcdef0",
    ] {
        assert!(!expected_bundle(value), "{value}");
    }
}

#[cfg(target_os = "macos")]
#[test]
fn activation_policy_unknown_stays_unknown_without_native_app_queries() {
    use objc2_app_kit::NSApplicationActivationPolicy as Policy;
    assert_eq!(activation_policy(Policy::Regular), "regular");
    assert_eq!(activation_policy(Policy::Accessory), "accessory");
    assert_eq!(activation_policy(Policy::Prohibited), "prohibited");
    assert_eq!(activation_policy(Policy(99)), "unknown");
}

#[test]
fn probe_is_one_shot_even_after_completion() {
    let state = observation();
    state.reserve().unwrap();
    assert!(state.reserve().is_err());
    state.finish("complete");
    assert!(state.reserve().is_err());
    assert_eq!(state.snapshot()["status"], "complete");
}

#[test]
fn cancellation_before_or_during_start_is_terminal() {
    let state = observation();
    state.finish("window-destroyed");
    assert!(state.reserve().is_err());
    assert!(!state.observing());
    assert_eq!(state.snapshot()["status"], "window-destroyed");
    for _ in 0..16 {
        let state = Arc::new(observation());
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let start_state = state.clone();
        let start_barrier = barrier.clone();
        let start = std::thread::spawn(move || {
            start_barrier.wait();
            start_state.reserve()
        });
        let stop_state = state.clone();
        let stop_barrier = barrier.clone();
        let stop = std::thread::spawn(move || {
            stop_barrier.wait();
            stop_state.finish("window-destroyed");
        });
        barrier.wait();
        let _ = start.join().unwrap();
        stop.join().unwrap();
        assert!(!state.observing());
        assert!(state.reserve().is_err());
        assert_eq!(state.snapshot()["status"], "window-destroyed");
    }
}

#[test]
fn notification_flood_cannot_displace_any_of_ten_full_snapshots() {
    let state = observation();
    state.reserve().unwrap();
    for _ in 0..1000 {
        state.record("notification", "app-did-become-active", None, None);
    }
    assert!(state.record(
        "snapshot",
        "before-ensure",
        None,
        Some(json!({"appActive":false}))
    ));
    assert!(state.record(
        "snapshot",
        "after-ensure",
        None,
        Some(json!({"appActive":true}))
    ));
    for ordinal in 1..=SCHEDULED {
        assert!(state.record(
            "snapshot",
            "scheduled",
            Some(ordinal),
            Some(json!({"appActive":true}))
        ));
    }
    let value = state.snapshot();
    assert_eq!(value["records"].as_array().unwrap().len(), 64);
    assert_eq!(value["total"], 1010);
    assert_eq!(value["overflow"], 946);
    assert_eq!(value["notificationRecords"], 54);
    assert_eq!(value["scheduledSamples"], 8);
    assert_eq!(value["records"][54]["flags"]["appActive"], false);
    assert_eq!(value["records"][63]["sampleOrdinal"], 8);
}

#[test]
fn deadline_and_cancellation_stop_all_further_recording() {
    let state = observation();
    state.reserve().unwrap();
    state.log.lock().started = Some(Instant::now() - DEADLINE);
    assert!(!state.record("notification", "app-did-become-active", None, None));
    assert_eq!(state.snapshot()["total"], 0);
    state.finish("cancelled-or-deadline");
    state.finish("complete");
    assert_eq!(state.snapshot()["status"], "cancelled-or-deadline");
    assert!(!state.record("snapshot", "scheduled", Some(1), Some(json!({}))));
}

#[test]
fn finite_schedule_has_eight_observations_with_deadline_margin() {
    assert_eq!(SCHEDULED, 8);
    assert_eq!((STEP * u32::from(SCHEDULED)).as_millis(), 1600);
    assert!(STEP * u32::from(SCHEDULED) < DEADLINE);
}

#[test]
fn totals_saturate_and_serialization_never_exposes_expected_identity() {
    let state = observation();
    state.reserve().unwrap();
    state.log.lock().total = u32::MAX;
    state.record("notification", "app-did-become-active", None, None);
    let value = state.snapshot();
    assert_eq!(value["total"], u32::MAX);
    let encoded = value.to_string();
    assert!(!encoded.contains(&state.expected_bundle));
    assert!(!encoded.contains("bundleIdentifier"));
    assert!(!encoded.contains("pointer"));
}
