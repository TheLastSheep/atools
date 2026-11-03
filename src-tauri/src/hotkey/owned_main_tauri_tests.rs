use super::{classify_registration_error, HOTKEY_OUTCOME_UNKNOWN};
use crate::hotkey::owned_main::RegisterFailure;

#[test]
fn global_hotkey_registration_error_is_a_safe_rejection() {
    let error = tauri_plugin_global_shortcut::Error::GlobalHotkey("occupied".into());

    assert!(matches!(
        classify_registration_error(error),
        RegisterFailure::Rejected
    ));
}

#[test]
fn main_thread_receive_error_is_an_unknown_outcome() {
    let (sender, receiver) = std::sync::mpsc::channel::<()>();
    drop(sender);
    let error = tauri_plugin_global_shortcut::Error::RecvError(
        receiver.recv().expect_err("sender was dropped"),
    );

    assert!(matches!(
        classify_registration_error(error),
        RegisterFailure::Unavailable(message) if message == HOTKEY_OUTCOME_UNKNOWN
    ));
}

#[test]
fn tauri_dispatch_error_is_an_unknown_outcome() {
    let error = tauri_plugin_global_shortcut::Error::Tauri(tauri::Error::FailedToReceiveMessage);

    assert!(matches!(
        classify_registration_error(error),
        RegisterFailure::Unavailable(message) if message == HOTKEY_OUTCOME_UNKNOWN
    ));
}

#[test]
fn only_unchanged_main_recording_busy_is_a_safe_mutation_rejection() {
    assert_eq!(
        super::classify_recording_mutation_error("SETTINGS_HOTKEY_RECORDING_BUSY".into()),
        "SETTINGS_HOTKEY_REJECTED"
    );
    for unknown in [
        "SETTINGS_HOTKEY_RECORDING_UNAVAILABLE",
        "SETTINGS_HOTKEY_OUTCOME_UNKNOWN",
        "unregister failed",
    ] {
        assert_eq!(
            super::classify_recording_mutation_error(unknown.into()),
            unknown
        );
    }
}
