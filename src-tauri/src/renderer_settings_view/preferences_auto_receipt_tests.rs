//! Exercises the actual postcommit function used by SettingsPreferences::patch.
use super::*;
use crate::updater::auto_check::{Receipt, RuntimeError};
fn opening() -> OpeningSnapshot {
    let raw = r#"{"autoCheckUpdate":false,"unknown":{"keep":1}}"#.to_owned();
    OpeningSnapshot {
        value: project_general_settings(Some(&raw), "Alt+Space").unwrap(),
        raw: Some(raw),
        revision: "a".repeat(32),
    }
}
fn commit(
    db: &Database,
    opening: &OpeningSnapshot,
    runtime_applied: bool,
) -> GeneralSettingsPatchReceipt {
    db.set_setting("settings-general", opening.raw.as_deref().unwrap())
        .unwrap();
    let raw = db
        .mutate_renderer_general_settings(
            opening.raw.as_deref(),
            &BTreeMap::from([("autoCheckUpdate".into(), json!(true))]),
        )
        .unwrap();
    GeneralSettingsPatchReceipt {
        version: 1,
        raw,
        notification_delivered: false,
        auto_check: Some(Receipt {
            runtime_applied,
            runtime_error: (!runtime_applied).then_some(RuntimeError {
                code: "SETTINGS_UPDATER_PROVIDER_DISABLED",
                message: "当前隔离实例未启用自动更新",
            }),
        }),
    }
}
#[test]
fn committed_auto_receipt_never_calls_throwing_hotkey_reader_and_reports_saved_runtime_truth() {
    for applied in [true, false] {
        let db = Database::in_memory().unwrap();
        let mut opening = opening();
        let receipt = commit(&db, &opening, applied);
        let raw = receipt.raw.clone();
        let result = complete(&mut opening, "b".repeat(32), receipt, true, || {
            panic!("unrelated hotkey read must not occur after auto CAS")
        })
        .unwrap();
        assert_eq!(result["runtimeApplied"], applied);
        assert_eq!(result["value"]["autoCheckUpdate"], true);
        assert_eq!(result["value"]["hotkey"], "Alt+Space");
        assert_eq!(result["notificationDelivered"], false);
        assert_eq!(result["runtimeError"].is_null(), applied);
        assert_eq!(result.as_object().unwrap().len(), 5);
        assert_eq!(opening.raw.as_deref(), Some(raw.as_str()));
        assert_eq!(opening.revision, "b".repeat(32));
        assert_eq!(db.read_renderer_general_settings().unwrap(), Some(raw));
    }
}
#[test]
fn non_auto_retains_existing_fallible_hotkey_behavior_and_does_not_update_local_snapshot() {
    let db = Database::in_memory().unwrap();
    let mut opening = opening();
    let receipt = commit(&db, &opening, true);
    let before = opening.raw.clone();
    let result = complete(&mut opening, "b".repeat(32), receipt, false, || {
        Err("owned-hotkey-read-failed".into())
    });
    assert_eq!(result.unwrap_err(), "owned-hotkey-read-failed");
    assert_eq!(opening.raw, before);
    assert_eq!(opening.revision, "a".repeat(32));
}
