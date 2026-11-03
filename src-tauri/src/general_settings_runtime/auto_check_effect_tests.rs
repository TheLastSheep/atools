use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
fn changes(enabled: bool) -> BTreeMap<String, Value> {
    BTreeMap::from([("autoCheckUpdate".into(), json!(enabled))])
}
#[tokio::test]
async fn durable_auto_commit_precedes_runtime_and_notification_failure_is_truthful() {
    let db = Arc::new(Database::in_memory().unwrap());
    db.set_setting(
        "settings-general",
        r#"{"unknown":{"keep":1},"autoCheckUpdate":false}"#,
    )
    .unwrap();
    let raw = db.read_renderer_general_settings().unwrap();
    let effect_db = db.clone();
    let result = execute(
        db.clone(),
        raw,
        changes(true),
        true,
        move |enabled| {
            assert!(enabled);
            let stored = effect_db.read_renderer_general_settings().unwrap().unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&stored).unwrap()["autoCheckUpdate"],
                true
            );
            crate::updater::auto_check::Receipt {
                runtime_applied: false,
                runtime_error: Some(crate::updater::auto_check::RuntimeError {
                    code: "SETTINGS_UPDATER_PROVIDER_DISABLED",
                    message: "当前隔离实例未启用自动更新",
                }),
            }
        },
        |raw| {
            assert_eq!(
                serde_json::from_str::<Value>(raw).unwrap()["unknown"]["keep"],
                1
            );
            false
        },
    )
    .await
    .unwrap();
    assert!(!result.notification_delivered);
    assert!(!result.auto_check.unwrap().runtime_applied);
    assert_eq!(
        db.read_renderer_general_settings().unwrap(),
        Some(result.raw)
    );
}
#[tokio::test]
async fn cas_failure_cannot_apply_runtime_or_notify() {
    let db = Arc::new(Database::in_memory().unwrap());
    db.set_setting("settings-general", r#"{"autoCheckUpdate":false}"#)
        .unwrap();
    let calls = AtomicUsize::new(0);
    assert!(execute(
        db.clone(),
        None,
        changes(true),
        true,
        |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            panic!("must not apply")
        },
        |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            true
        }
    )
    .await
    .is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        db.read_renderer_general_settings().unwrap().as_deref(),
        Some(r#"{"autoCheckUpdate":false}"#)
    );
}
