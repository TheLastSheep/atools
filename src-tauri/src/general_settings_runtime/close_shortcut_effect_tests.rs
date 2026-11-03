use super::*;
use std::{cell::Cell, sync::Arc};
struct Fake {
    state: Snapshot,
    steps: Vec<&'static str>,
    reject: bool,
    unknown: bool,
    fail_restore: bool,
}
impl Fake {
    fn new() -> Self {
        Self {
            state: Snapshot {
                enabled: true,
                generation: 1,
            },
            steps: vec![],
            reject: false,
            unknown: false,
            fail_restore: false,
        }
    }
}
impl Port for Fake {
    fn read(&mut self) -> Result<Snapshot, String> {
        self.steps.push("read");
        if self.unknown {
            Err("SETTINGS_CLOSE_SHORTCUT_UNSUPPORTED".into())
        } else {
            Ok(self.state)
        }
    }
    fn apply(&mut self, target: bool) -> Result<Snapshot, String> {
        self.steps.push("apply");
        if self.reject {
            return Err("SETTINGS_CLOSE_SHORTCUT_REJECTED".into());
        }
        self.state = Snapshot {
            enabled: target,
            generation: self.state.generation + 1,
        };
        Ok(self.state)
    }
    fn restore(&mut self, before: Snapshot, applied: Snapshot) -> Result<(), String> {
        self.steps.push("restore");
        if self.fail_restore || self.state != applied {
            return Err("unconfirmed restore".into());
        }
        self.state = Snapshot {
            enabled: before.enabled,
            generation: applied.generation + 1,
        };
        Ok(())
    }
}
#[tokio::test]
async fn changed_close_policy_applies_before_db_commit_and_cas_failure_restores() {
    let db = Arc::new(atools_core::Database::in_memory().unwrap());
    db.set_setting(
        "settings-general",
        r#"{"builtinAppShortcutsEnabled":{"closePlugin":true}}"#,
    )
    .unwrap();
    let mut port = Fake::new();
    let called = Cell::new(false);
    let result = execute(&mut port, true, Some(false), async {
        called.set(true);
        Err::<(), _>("CAS conflict".to_owned())
    })
    .await;
    assert_eq!(result, Err("CAS conflict".into()));
    assert!(called.get());
    assert!(port.state.enabled);
    assert_eq!(port.steps, ["read", "apply", "restore"]);
    assert!(crate::renderer_close_shortcut::enabled_from_raw(
        db.get_setting("settings-general").unwrap().as_deref()
    ));
}
#[tokio::test]
async fn unsupported_changed_policy_never_polls_commit_future() {
    let mut port = Fake::new();
    port.unknown = true;
    let result = execute(&mut port, true, Some(false), async {
        panic!("unsupported must not commit");
        #[allow(unreachable_code)]
        Ok::<_, String>(())
    })
    .await;
    assert_eq!(result, Err("SETTINGS_CLOSE_SHORTCUT_UNSUPPORTED".into()));
    assert_eq!(port.steps, ["read"]);
}
#[tokio::test]
async fn unchanged_carried_close_flag_does_not_break_other_settings_on_unsupported_platform() {
    let mut port = Fake::new();
    port.unknown = true;
    assert_eq!(
        execute(&mut port, true, Some(true), async {
            Ok::<_, String>("other General committed")
        })
        .await,
        Ok("other General committed")
    );
    assert!(port.steps.is_empty());
}
#[tokio::test]
async fn unknown_compensation_is_recovery_failure_not_safe_rejection() {
    let mut port = Fake::new();
    port.fail_restore = true;
    assert_eq!(
        execute(&mut port, true, Some(false), async {
            Err::<(), _>("CAS conflict".into())
        })
        .await,
        Err("SETTINGS_NATIVE_RECOVERY_FAILED".into())
    );
}
#[tokio::test]
async fn known_menu_rejection_does_not_run_or_compensate_general_write() {
    let mut port = Fake::new();
    port.reject = true;
    assert_eq!(
        execute(&mut port, true, Some(false), async {
            panic!("must not commit");
            #[allow(unreachable_code)]
            Ok::<_, String>(())
        })
        .await,
        Err("SETTINGS_CLOSE_SHORTCUT_REJECTED".into())
    );
    assert_eq!(port.steps, ["read", "apply"]);
}
