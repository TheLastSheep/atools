use std::cell::RefCell;

use serde_json::{json, Value};

use super::{
    apply_all, rollback_all, NativeSettingChange, NativeSettingEffectPort, NativeSettingField,
};

#[derive(Default)]
struct RecordingEffects {
    calls: RefCell<Vec<(NativeSettingField, Value)>>,
    fail_on: Option<(NativeSettingField, Value)>,
    reject_on: Option<(NativeSettingField, Value)>,
    recovery_on: Option<(NativeSettingField, Value)>,
    fail_rollback_on: Option<(NativeSettingField, Value)>,
}

impl NativeSettingEffectPort for RecordingEffects {
    fn apply(&mut self, field: NativeSettingField, value: &Value) -> Result<(), String> {
        self.calls.borrow_mut().push((field, value.clone()));
        if self
            .fail_on
            .as_ref()
            .is_some_and(|(failed_field, failed_value)| {
                *failed_field == field && failed_value == value
            })
        {
            Err("injected failure".into())
        } else if self
            .reject_on
            .as_ref()
            .is_some_and(|(rejected_field, rejected_value)| {
                *rejected_field == field && rejected_value == value
            })
        {
            Err("SETTINGS_HOTKEY_REJECTED".into())
        } else if self
            .recovery_on
            .as_ref()
            .is_some_and(|(failed_field, failed_value)| {
                *failed_field == field && failed_value == value
            })
        {
            Err("SETTINGS_NATIVE_RECOVERY_FAILED".into())
        } else {
            Ok(())
        }
    }

    fn rollback(&mut self, field: NativeSettingField, value: &Value) -> Result<(), String> {
        self.calls.borrow_mut().push((field, value.clone()));
        if self
            .fail_rollback_on
            .as_ref()
            .is_some_and(|(failed_field, failed_value)| {
                *failed_field == field && failed_value == value
            })
        {
            Err("injected rollback failure".into())
        } else {
            Ok(())
        }
    }
}

fn changes() -> Vec<NativeSettingChange> {
    vec![
        NativeSettingChange {
            field: NativeSettingField::Hotkey,
            before: json!("Option+Z"),
            after: json!("Option+X"),
        },
        NativeSettingChange {
            field: NativeSettingField::TrayIconVisible,
            before: json!(false),
            after: json!(true),
        },
        NativeSettingChange {
            field: NativeSettingField::LaunchAtLogin,
            before: json!(false),
            after: json!(true),
        },
    ]
}

#[test]
fn native_effects_apply_in_frozen_order() {
    let mut port = RecordingEffects::default();
    apply_all(&mut port, &changes()).unwrap();

    assert_eq!(
        *port.calls.borrow(),
        vec![
            (NativeSettingField::Hotkey, json!("Option+X")),
            (NativeSettingField::TrayIconVisible, json!(true)),
            (NativeSettingField::LaunchAtLogin, json!(true)),
        ]
    );
}

#[test]
fn failed_native_effect_compensates_only_prior_successes_in_reverse_order() {
    let mut port = RecordingEffects {
        calls: RefCell::new(Vec::new()),
        fail_on: Some((NativeSettingField::TrayIconVisible, json!(true))),
        reject_on: None,
        recovery_on: None,
        fail_rollback_on: None,
    };
    let error = apply_all(&mut port, &changes()).unwrap_err();

    assert!(error.contains("showTrayIcon"));
    assert!(error.contains("may have partially changed system state"));
    assert_eq!(
        *port.calls.borrow(),
        vec![
            (NativeSettingField::Hotkey, json!("Option+X")),
            (NativeSettingField::TrayIconVisible, json!(true)),
            (NativeSettingField::Hotkey, json!("Option+Z")),
        ]
    );
}

#[test]
fn safe_hotkey_rejection_keeps_its_fixed_code_after_prior_effects_are_compensated() {
    let mut port = RecordingEffects {
        calls: RefCell::new(Vec::new()),
        fail_on: None,
        reject_on: Some((NativeSettingField::Hotkey, json!("Option+X"))),
        recovery_on: None,
        fail_rollback_on: None,
    };
    let changes = [
        NativeSettingChange {
            field: NativeSettingField::TrayIconVisible,
            before: json!(false),
            after: json!(true),
        },
        NativeSettingChange {
            field: NativeSettingField::Hotkey,
            before: json!("Option+Z"),
            after: json!("Option+X"),
        },
    ];

    assert_eq!(
        apply_all(&mut port, &changes).unwrap_err(),
        "SETTINGS_HOTKEY_REJECTED"
    );
    assert_eq!(
        *port.calls.borrow(),
        vec![
            (NativeSettingField::TrayIconVisible, json!(true)),
            (NativeSettingField::Hotkey, json!("Option+X")),
            (NativeSettingField::TrayIconVisible, json!(false)),
        ]
    );
}

#[test]
fn native_recovery_failure_is_preserved_after_prior_effects_are_compensated() {
    let mut port = RecordingEffects {
        calls: RefCell::new(Vec::new()),
        fail_on: None,
        reject_on: None,
        recovery_on: Some((NativeSettingField::Hotkey, json!("Option+X"))),
        fail_rollback_on: None,
    };
    let changes = [
        NativeSettingChange {
            field: NativeSettingField::TrayIconVisible,
            before: json!(false),
            after: json!(true),
        },
        NativeSettingChange {
            field: NativeSettingField::Hotkey,
            before: json!("Option+Z"),
            after: json!("Option+X"),
        },
    ];

    assert_eq!(
        apply_all(&mut port, &changes).unwrap_err(),
        "SETTINGS_NATIVE_RECOVERY_FAILED"
    );
    assert_eq!(
        *port.calls.borrow(),
        vec![
            (NativeSettingField::TrayIconVisible, json!(true)),
            (NativeSettingField::Hotkey, json!("Option+X")),
            (NativeSettingField::TrayIconVisible, json!(false)),
        ]
    );
}

#[test]
fn compensation_failure_is_reported_as_native_recovery_failure() {
    let mut port = RecordingEffects {
        calls: RefCell::new(Vec::new()),
        fail_on: None,
        reject_on: Some((NativeSettingField::Hotkey, json!("Option+X"))),
        recovery_on: None,
        fail_rollback_on: Some((NativeSettingField::TrayIconVisible, json!(false))),
    };
    let changes = [
        NativeSettingChange {
            field: NativeSettingField::TrayIconVisible,
            before: json!(false),
            after: json!(true),
        },
        NativeSettingChange {
            field: NativeSettingField::Hotkey,
            before: json!("Option+Z"),
            after: json!("Option+X"),
        },
    ];

    assert_eq!(
        apply_all(&mut port, &changes).unwrap_err(),
        "SETTINGS_NATIVE_RECOVERY_FAILED"
    );
}

#[test]
fn commit_failure_compensation_attempts_every_effect_in_reverse_order() {
    let mut port = RecordingEffects::default();
    let completed = changes();
    rollback_all(&mut port, &completed).unwrap();

    assert_eq!(
        *port.calls.borrow(),
        vec![
            (NativeSettingField::LaunchAtLogin, json!(false)),
            (NativeSettingField::TrayIconVisible, json!(false)),
            (NativeSettingField::Hotkey, json!("Option+Z")),
        ]
    );
}
