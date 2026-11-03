use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use atools_core::Database;
use serde_json::{json, Value};

use crate::{
    general_settings_runtime::renderer_native_hotkey_effect::RendererNativeHotkeyEffect,
    hotkey::OwnedMainHotkeyStateSnapshot,
};

use super::{
    apply_launch_at_login_effect, apply_main_hotkey_effect, restore_launch_at_login_effect,
    restore_main_hotkey_effect,
};

struct FakeHotkeyState {
    label: Option<String>,
    safe_rejection: bool,
    partial_error: Option<String>,
    fail_restore: bool,
    steps: Vec<&'static str>,
}

struct FakeHotkey(Arc<Mutex<FakeHotkeyState>>);

impl RendererNativeHotkeyEffect for FakeHotkey {
    fn read(&mut self) -> Result<OwnedMainHotkeyStateSnapshot, String> {
        let mut state = self.0.lock().unwrap();
        state.steps.push("read");
        Ok(match state.label.as_deref() {
            Some(label) => OwnedMainHotkeyStateSnapshot::for_test_registered(label),
            None => OwnedMainHotkeyStateSnapshot::for_test_unregistered(),
        })
    }

    fn apply(&mut self, label: &str) -> Result<(), String> {
        let mut state = self.0.lock().unwrap();
        state.steps.push("apply");
        if std::mem::take(&mut state.safe_rejection) {
            return Err("SETTINGS_HOTKEY_REJECTED".into());
        }
        state.label = Some(label.to_owned());
        if let Some(error) = state.partial_error.take() {
            return Err(error);
        }
        Ok(())
    }

    fn restore(&mut self, snapshot: &OwnedMainHotkeyStateSnapshot) -> Result<(), String> {
        let mut state = self.0.lock().unwrap();
        state.steps.push("restore");
        if state.fail_restore {
            return Err("injected state restore failure".into());
        }
        state.label = snapshot.label().map(ToOwned::to_owned);
        Ok(())
    }
}

fn fake_hotkey(label: Option<&str>) -> (FakeHotkey, Arc<Mutex<FakeHotkeyState>>) {
    let state = Arc::new(Mutex::new(FakeHotkeyState {
        label: label.map(ToOwned::to_owned),
        safe_rejection: false,
        partial_error: None,
        fail_restore: false,
        steps: Vec::new(),
    }));
    (FakeHotkey(Arc::clone(&state)), state)
}

#[test]
fn legacy_hotkey_effect_restores_no_owner_on_sqlite_cas_conflict_then_repairs_it() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(&directory.path().join("legacy-hotkey.sqlite")).unwrap();
    let original = json!({
        "hotkey": "unsupported legacy shortcut",
        "unrelated": {"retained": true}
    })
    .to_string();
    db.set_setting("settings-general", &original).unwrap();
    let expected = db.read_renderer_general_settings().unwrap().unwrap();
    let changes = BTreeMap::from([("hotkey".to_owned(), json!("Command+Shift+F11"))]);
    let plan = db
        .prepare_general_settings_write(Some(&expected), &changes)
        .unwrap();

    let (mut port, state) = fake_hotkey(None);
    let mut rollback = None;
    let mut active_label = String::new();
    apply_main_hotkey_effect(
        &mut port,
        &mut rollback,
        &mut active_label,
        "Command+Shift+F11",
    )
    .unwrap();
    db.set_setting(
        "settings-general",
        r#"{"hotkey":"unsupported legacy shortcut","otherWriter":true}"#,
    )
    .unwrap();
    assert!(db.commit_general_settings_write(plan).is_err());
    restore_main_hotkey_effect(&mut port, &mut rollback, &mut active_label).unwrap();

    assert_eq!(active_label, "");
    assert_eq!(state.lock().unwrap().label, None);
    let conflict_raw = db.read_renderer_general_settings().unwrap().unwrap();
    let conflict: Value = serde_json::from_str(&conflict_raw).unwrap();
    assert_eq!(conflict["hotkey"], "unsupported legacy shortcut");
    assert_eq!(conflict["otherWriter"], true);

    let retry_changes = BTreeMap::from([("hotkey".to_owned(), json!("Command+Shift+F11"))]);
    let retry_plan = db
        .prepare_general_settings_write(Some(&conflict_raw), &retry_changes)
        .unwrap();
    apply_main_hotkey_effect(
        &mut port,
        &mut rollback,
        &mut active_label,
        "Command+Shift+F11",
    )
    .unwrap();
    let committed = db.commit_general_settings_write(retry_plan).unwrap();
    let stored: Value = serde_json::from_str(&committed).unwrap();
    assert_eq!(stored["hotkey"], "Command+Shift+F11");
    assert_eq!(stored["otherWriter"], true);
    assert_eq!(active_label, "Command+Shift+F11");
    assert_eq!(
        state.lock().unwrap().label.as_deref(),
        Some("Command+Shift+F11")
    );
}

#[test]
fn legacy_safe_hotkey_rejection_does_not_repeat_state_restore() {
    let (mut port, state) = fake_hotkey(None);
    state.lock().unwrap().safe_rejection = true;
    let mut rollback = None;
    let mut active_label = String::new();

    assert_eq!(
        apply_main_hotkey_effect(
            &mut port,
            &mut rollback,
            &mut active_label,
            "Command+Shift+F11",
        )
        .unwrap_err(),
        "SETTINGS_HOTKEY_REJECTED"
    );
    assert!(rollback.is_none());
    assert_eq!(state.lock().unwrap().label, None);
    assert_eq!(state.lock().unwrap().steps, ["read", "apply"]);
}

#[test]
fn legacy_partial_hotkey_failure_is_compensated_before_reporting_primary_error() {
    let (mut port, state) = fake_hotkey(None);
    state.lock().unwrap().partial_error = Some("injected unknown registration result".into());
    let mut rollback = None;
    let mut active_label = String::new();

    assert_eq!(
        apply_main_hotkey_effect(
            &mut port,
            &mut rollback,
            &mut active_label,
            "Command+Shift+F11",
        )
        .unwrap_err(),
        "injected unknown registration result"
    );
    assert!(rollback.is_none());
    assert_eq!(state.lock().unwrap().label, None);
    assert_eq!(state.lock().unwrap().steps, ["read", "apply", "restore"]);
}

#[test]
fn legacy_launch_item_rollback_uses_the_captured_os_state_not_the_old_database_boolean() {
    let state = Arc::new(Mutex::new(true));
    let mut rollback = None;
    let read_state = Arc::clone(&state);
    let write_state = Arc::clone(&state);
    let mut calls = Vec::new();

    // The old General JSON value may be false while the actual OS registration is true.
    apply_launch_at_login_effect(
        &mut rollback,
        false,
        move || Ok(*read_state.lock().unwrap()),
        |expected, target| {
            calls.push((expected, target));
            let mut state = write_state.lock().unwrap();
            if Some(*state) != expected {
                return Err("SETTINGS_LAUNCH_AT_LOGIN_CONFLICT".into());
            }
            *state = target.ok_or_else(|| "missing target".to_owned())?;
            Ok(*state)
        },
    )
    .unwrap();

    let restore_state = Arc::clone(&state);
    restore_launch_at_login_effect(&mut rollback, move |expected, target| {
        let mut state = restore_state.lock().unwrap();
        if Some(*state) != expected {
            return Err("SETTINGS_LAUNCH_AT_LOGIN_CONFLICT".into());
        }
        *state = target.ok_or_else(|| "missing target".to_owned())?;
        Ok(*state)
    })
    .unwrap();

    assert_eq!(*state.lock().unwrap(), true);
    assert_eq!(calls, [(Some(true), Some(false))]);
    assert!(rollback.is_none());
}

#[test]
fn launch_item_unknown_state_and_cas_conflict_do_not_claim_a_rollback_snapshot() {
    let mut rollback = None;
    let error = apply_launch_at_login_effect(
        &mut rollback,
        true,
        || Err("SETTINGS_LAUNCH_AT_LOGIN_UNAVAILABLE".into()),
        |_, _| panic!("unknown actual state must stop before mutation"),
    )
    .unwrap_err();
    assert_eq!(error, "SETTINGS_LAUNCH_AT_LOGIN_UNAVAILABLE");
    assert!(rollback.is_none());

    let error = apply_launch_at_login_effect(
        &mut rollback,
        true,
        || Ok(false),
        |expected, target| {
            assert_eq!(expected, Some(false));
            assert_eq!(target, Some(true));
            Err("SETTINGS_LAUNCH_AT_LOGIN_CONFLICT".into())
        },
    )
    .unwrap_err();
    assert_eq!(error, "SETTINGS_LAUNCH_AT_LOGIN_CONFLICT");
    assert!(rollback.is_none());
}
