use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

use atools_core::Database;
use serde_json::{json, Value};

use crate::hotkey::OwnedMainHotkeyStateSnapshot;

use super::{execute_renderer_patch_with_hotkey_port, ReadApplyOpacity, ReadApplyTray};
use crate::general_settings_runtime::renderer_native_hotkey_effect::RendererNativeHotkeyEffect;

const SETTINGS_KEY: &str = "settings-general";

struct Fixture {
    _directory: tempfile::TempDir,
    db: Arc<Database>,
    expected: String,
}

struct HotkeyState {
    label: String,
    registered: bool,
    read_error: Option<String>,
    reject_without_update: bool,
    reject_code: Option<String>,
    healthy: bool,
    fail_apply_after_update: bool,
    fail_restore: bool,
    conflict_write: Option<(Arc<Database>, String)>,
}

#[derive(Clone)]
struct FakeHotkey {
    state: Arc<Mutex<HotkeyState>>,
    steps: Arc<Mutex<Vec<&'static str>>>,
}

impl RendererNativeHotkeyEffect for FakeHotkey {
    fn read(&mut self) -> Result<OwnedMainHotkeyStateSnapshot, String> {
        self.steps.lock().unwrap().push("hotkey-read");
        let mut state = self.state.lock().unwrap();
        if let Some(error) = state.read_error.take() {
            return Err(error);
        }
        if state.registered && !state.healthy {
            return Ok(OwnedMainHotkeyStateSnapshot::for_test_inactive(
                &state.label,
            ));
        }
        if state.registered {
            Ok(OwnedMainHotkeyStateSnapshot::for_test_registered(
                &state.label,
            ))
        } else {
            Ok(OwnedMainHotkeyStateSnapshot::for_test_unregistered())
        }
    }

    fn apply(&mut self, label: &str) -> Result<(), String> {
        self.steps.lock().unwrap().push("hotkey-apply");
        let (fail, conflict_write) = {
            let mut state = self.state.lock().unwrap();
            if let Some(code) = state.reject_code.take() {
                return Err(code);
            }
            if std::mem::take(&mut state.reject_without_update) {
                return Err("SETTINGS_HOTKEY_REJECTED".into());
            }
            state.label = label.to_owned();
            state.registered = true;
            state.healthy = true;
            (
                std::mem::take(&mut state.fail_apply_after_update),
                state.conflict_write.take(),
            )
        };
        if let Some((db, raw)) = conflict_write {
            db.set_setting(SETTINGS_KEY, &raw)
                .map_err(|error| error.to_string())?;
        }
        if fail {
            Err("injected partial primary shortcut setter failure".into())
        } else {
            Ok(())
        }
    }

    fn restore(&mut self, snapshot: &OwnedMainHotkeyStateSnapshot) -> Result<(), String> {
        self.steps.lock().unwrap().push("hotkey-restore");
        let mut state = self.state.lock().unwrap();
        if state.fail_restore {
            return Err("injected primary shortcut recovery failure".into());
        }
        state.label = snapshot.label().unwrap_or_default().to_owned();
        state.registered = snapshot.label().is_some();
        state.healthy = snapshot.healthy();
        Ok(())
    }
}

fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&directory.path().join("native-hotkey.sqlite")).unwrap());
    let initial = json!({
        "opacity": 1.0,
        "showTrayIcon": true,
        "hotkey": "Command+Shift+F10",
        "unrelated": {"retained": true}
    })
    .to_string();
    db.set_setting(SETTINGS_KEY, &initial).unwrap();
    Fixture {
        expected: db.read_renderer_general_settings().unwrap().unwrap(),
        _directory: directory,
        db,
    }
}

fn hotkey_effect(label: &str, steps: Arc<Mutex<Vec<&'static str>>>) -> FakeHotkey {
    FakeHotkey {
        state: Arc::new(Mutex::new(HotkeyState {
            label: label.to_owned(),
            registered: true,
            read_error: None,
            reject_without_update: false,
            reject_code: None,
            healthy: true,
            fail_apply_after_update: false,
            fail_restore: false,
            conflict_write: None,
        })),
        steps,
    }
}

fn unregistered_hotkey_effect(steps: Arc<Mutex<Vec<&'static str>>>) -> FakeHotkey {
    let effect = hotkey_effect("", steps);
    effect.state.lock().unwrap().registered = false;
    effect
}

fn panic_opacity() -> ReadApplyOpacity {
    Box::new(|_| {
        let operation: Pin<Box<dyn Future<Output = Result<f64, String>> + Send>> =
            Box::pin(async { panic!("hotkey-only patch must not read or apply opacity") });
        operation
    })
}

fn panic_tray() -> ReadApplyTray {
    Box::new(|_| panic!("hotkey-only patch must not read or apply tray visibility"))
}

fn settings(db: &Database) -> Value {
    serde_json::from_str(&db.read_renderer_general_settings().unwrap().unwrap()).unwrap()
}

fn hotkey_patch(label: &str) -> BTreeMap<String, Value> {
    BTreeMap::from([("hotkey".to_owned(), json!(label))])
}

#[tokio::test(flavor = "current_thread")]
async fn hotkey_only_patch_reads_applies_commits_and_notifies_once() {
    let fixture = fixture();
    let steps = Arc::new(Mutex::new(Vec::new()));
    let mut hotkey = hotkey_effect("Command+Shift+F10", Arc::clone(&steps));
    let state = Arc::clone(&hotkey.state);
    let notifications = Arc::new(AtomicUsize::new(0));
    let notify_count = Arc::clone(&notifications);

    let receipt = execute_renderer_patch_with_hotkey_port(
        Arc::clone(&fixture.db),
        Some(fixture.expected.clone()),
        hotkey_patch("Command+Shift+F11"),
        &mut panic_opacity(),
        &mut panic_tray(),
        &mut hotkey,
        move |_| {
            notify_count.fetch_add(1, Ordering::SeqCst);
            true
        },
    )
    .await
    .unwrap();

    assert_eq!(settings(&fixture.db)["hotkey"], "Command+Shift+F11");
    assert_eq!(settings(&fixture.db)["unrelated"]["retained"], true);
    assert_eq!(state.lock().unwrap().label, "Command+Shift+F11");
    assert_eq!(*steps.lock().unwrap(), ["hotkey-read", "hotkey-apply"]);
    assert!(receipt.notification_delivered);
    assert_eq!(notifications.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn same_hotkey_value_still_reads_owned_state_without_duplicate_apply() {
    let fixture = fixture();
    let steps = Arc::new(Mutex::new(Vec::new()));
    let mut hotkey = hotkey_effect("Command+Shift+F10", Arc::clone(&steps));

    execute_renderer_patch_with_hotkey_port(
        Arc::clone(&fixture.db),
        Some(fixture.expected.clone()),
        hotkey_patch("Command+Shift+F10"),
        &mut panic_opacity(),
        &mut panic_tray(),
        &mut hotkey,
        |_| true,
    )
    .await
    .unwrap();

    assert_eq!(*steps.lock().unwrap(), ["hotkey-read"]);
    assert_eq!(settings(&fixture.db)["hotkey"], "Command+Shift+F10");
}

#[tokio::test(flavor = "current_thread")]
async fn owner_read_failure_is_not_misclassified_as_a_hotkey_rejection() {
    let fixture = fixture();
    let steps = Arc::new(Mutex::new(Vec::new()));
    let mut hotkey = hotkey_effect("Command+Shift+F10", Arc::clone(&steps));
    hotkey.state.lock().unwrap().read_error = Some("owned primary shortcut is unavailable".into());

    let error = execute_renderer_patch_with_hotkey_port(
        Arc::clone(&fixture.db),
        Some(fixture.expected.clone()),
        hotkey_patch("Command+Shift+F11"),
        &mut panic_opacity(),
        &mut panic_tray(),
        &mut hotkey,
        |_| panic!("unavailable owned state must not notify"),
    )
    .await
    .unwrap_err();

    assert_eq!(error, "owned primary shortcut is unavailable");
    assert_eq!(*steps.lock().unwrap(), ["hotkey-read"]);
    assert_eq!(settings(&fixture.db)["hotkey"], "Command+Shift+F10");
}

#[tokio::test(flavor = "current_thread")]
async fn compensated_native_rejection_preserves_the_exact_hotkey_error_code() {
    let fixture = fixture();
    let steps = Arc::new(Mutex::new(Vec::new()));
    let mut hotkey = hotkey_effect("Command+Shift+F10", Arc::clone(&steps));
    hotkey.state.lock().unwrap().reject_without_update = true;

    let error = execute_renderer_patch_with_hotkey_port(
        Arc::clone(&fixture.db),
        Some(fixture.expected.clone()),
        hotkey_patch("Command+Shift+F11"),
        &mut panic_opacity(),
        &mut panic_tray(),
        &mut hotkey,
        |_| panic!("rejected native registration must not notify"),
    )
    .await
    .unwrap_err();

    assert_eq!(error, "SETTINGS_HOTKEY_REJECTED");
    assert_eq!(hotkey.state.lock().unwrap().label, "Command+Shift+F10");
    assert_eq!(settings(&fixture.db)["hotkey"], "Command+Shift+F10");
    assert_eq!(*steps.lock().unwrap(), ["hotkey-read", "hotkey-apply"]);
}

fn mixed_opacity_io(
    state: Arc<Mutex<f64>>,
    steps: Arc<Mutex<Vec<&'static str>>>,
) -> ReadApplyOpacity {
    Box::new(move |target| {
        let state = Arc::clone(&state);
        let steps = Arc::clone(&steps);
        Box::pin(async move {
            match target {
                None => {
                    steps.lock().unwrap().push("opacity-read");
                    Ok(*state.lock().unwrap())
                }
                Some(value) => {
                    steps.lock().unwrap().push(if value == 1.0 {
                        "opacity-restore"
                    } else {
                        "opacity-apply"
                    });
                    *state.lock().unwrap() = value;
                    Ok(value)
                }
            }
        })
    })
}

fn mixed_tray_io(state: Arc<Mutex<bool>>, steps: Arc<Mutex<Vec<&'static str>>>) -> ReadApplyTray {
    Box::new(move |target| match target {
        None => {
            steps.lock().unwrap().push("tray-read");
            Ok(*state.lock().unwrap())
        }
        Some(value) => {
            steps
                .lock()
                .unwrap()
                .push(if value { "tray-restore" } else { "tray-apply" });
            *state.lock().unwrap() = value;
            Ok(value)
        }
    })
}

#[tokio::test(flavor = "current_thread")]
async fn mixed_failure_restores_started_effects_in_reverse_after_all_prereads() {
    let fixture = fixture();
    let steps = Arc::new(Mutex::new(Vec::new()));
    let opacity = Arc::new(Mutex::new(1.0));
    let tray = Arc::new(Mutex::new(true));
    let mut hotkey = hotkey_effect("Command+Shift+F10", Arc::clone(&steps));
    hotkey.state.lock().unwrap().fail_apply_after_update = true;
    let mut opacity_io = mixed_opacity_io(Arc::clone(&opacity), Arc::clone(&steps));
    let mut tray_io = mixed_tray_io(Arc::clone(&tray), Arc::clone(&steps));
    let notifications = Arc::new(AtomicUsize::new(0));
    let notify_count = Arc::clone(&notifications);

    let error = execute_renderer_patch_with_hotkey_port(
        Arc::clone(&fixture.db),
        Some(fixture.expected.clone()),
        BTreeMap::from([
            ("opacity".to_owned(), json!(0.65)),
            ("showTrayIcon".to_owned(), json!(false)),
            ("hotkey".to_owned(), json!("Command+Shift+F11")),
        ]),
        &mut opacity_io,
        &mut tray_io,
        &mut hotkey,
        move |_| {
            notify_count.fetch_add(1, Ordering::SeqCst);
            true
        },
    )
    .await
    .unwrap_err();

    assert!(error.contains("Primary shortcut application failed"));
    assert_eq!(
        *steps.lock().unwrap(),
        [
            "opacity-read",
            "tray-read",
            "hotkey-read",
            "opacity-apply",
            "tray-apply",
            "hotkey-apply",
            "hotkey-restore",
            "tray-restore",
            "opacity-restore",
        ]
    );
    assert_eq!(*opacity.lock().unwrap(), 1.0);
    assert!(*tray.lock().unwrap());
    assert_eq!(hotkey.state.lock().unwrap().label, "Command+Shift+F10");
    assert_eq!(settings(&fixture.db)["hotkey"], "Command+Shift+F10");
    assert_eq!(settings(&fixture.db)["showTrayIcon"], true);
    assert_eq!(settings(&fixture.db)["opacity"], 1.0);
    assert_eq!(notifications.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn mixed_safe_hotkey_rejection_skips_hotkey_restore_but_restores_prior_effects() {
    let fixture = fixture();
    let steps = Arc::new(Mutex::new(Vec::new()));
    let opacity = Arc::new(Mutex::new(1.0));
    let tray = Arc::new(Mutex::new(true));
    let mut hotkey = hotkey_effect("Command+Shift+F10", Arc::clone(&steps));
    hotkey.state.lock().unwrap().reject_without_update = true;
    let mut opacity_io = mixed_opacity_io(Arc::clone(&opacity), Arc::clone(&steps));
    let mut tray_io = mixed_tray_io(Arc::clone(&tray), Arc::clone(&steps));
    let notifications = Arc::new(AtomicUsize::new(0));
    let notify_count = Arc::clone(&notifications);

    let error = execute_renderer_patch_with_hotkey_port(
        Arc::clone(&fixture.db),
        Some(fixture.expected.clone()),
        BTreeMap::from([
            ("opacity".to_owned(), json!(0.65)),
            ("showTrayIcon".to_owned(), json!(false)),
            ("hotkey".to_owned(), json!("Command+Shift+F11")),
        ]),
        &mut opacity_io,
        &mut tray_io,
        &mut hotkey,
        move |_| {
            notify_count.fetch_add(1, Ordering::SeqCst);
            true
        },
    )
    .await
    .unwrap_err();

    assert_eq!(error, "SETTINGS_HOTKEY_REJECTED");
    assert_eq!(
        *steps.lock().unwrap(),
        [
            "opacity-read",
            "tray-read",
            "hotkey-read",
            "opacity-apply",
            "tray-apply",
            "hotkey-apply",
            "tray-restore",
            "opacity-restore",
        ]
    );
    assert_eq!(*opacity.lock().unwrap(), 1.0);
    assert!(*tray.lock().unwrap());
    assert_eq!(hotkey.state.lock().unwrap().label, "Command+Shift+F10");
    assert_eq!(settings(&fixture.db)["hotkey"], "Command+Shift+F10");
    assert_eq!(settings(&fixture.db)["showTrayIcon"], true);
    assert_eq!(settings(&fixture.db)["opacity"], 1.0);
    assert_eq!(notifications.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn hotkey_commit_conflict_restores_previous_owned_value_and_preserves_conflict() {
    let fixture = fixture();
    let steps = Arc::new(Mutex::new(Vec::new()));
    let mut hotkey = hotkey_effect("Command+Shift+F10", Arc::clone(&steps));
    let competitor = Arc::clone(&fixture.db);
    hotkey.state.lock().unwrap().conflict_write = Some((
        competitor,
        r#"{"hotkey":"Command+Shift+F12","otherWriter":true}"#.into(),
    ));

    let error = execute_renderer_patch_with_hotkey_port(
        Arc::clone(&fixture.db),
        Some(fixture.expected.clone()),
        hotkey_patch("Command+Shift+F11"),
        &mut panic_opacity(),
        &mut panic_tray(),
        &mut hotkey,
        |_| panic!("conflicted writes must not notify"),
    )
    .await
    .unwrap_err();

    assert!(error.contains("General settings changed"));
    assert_eq!(hotkey.state.lock().unwrap().label, "Command+Shift+F10");
    assert_eq!(settings(&fixture.db)["otherWriter"], true);
    assert_eq!(settings(&fixture.db)["hotkey"], "Command+Shift+F12");
    assert_eq!(
        *steps.lock().unwrap(),
        ["hotkey-read", "hotkey-apply", "hotkey-restore"]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn hotkey_recovery_failure_returns_the_shared_native_recovery_code() {
    let fixture = fixture();
    let steps = Arc::new(Mutex::new(Vec::new()));
    let mut hotkey = hotkey_effect("Command+Shift+F10", steps);
    {
        let mut state = hotkey.state.lock().unwrap();
        state.fail_apply_after_update = true;
        state.fail_restore = true;
    }

    let error = execute_renderer_patch_with_hotkey_port(
        Arc::clone(&fixture.db),
        Some(fixture.expected.clone()),
        hotkey_patch("Command+Shift+F11"),
        &mut panic_opacity(),
        &mut panic_tray(),
        &mut hotkey,
        |_| panic!("failed native effects must not notify"),
    )
    .await
    .unwrap_err();

    assert_eq!(error, "SETTINGS_NATIVE_RECOVERY_FAILED");
    assert_eq!(settings(&fixture.db)["hotkey"], "Command+Shift+F10");
}

#[path = "renderer_native_effect_unregistered_hotkey_tests.rs"]
mod unregistered_state_tests;

#[path = "renderer_native_effect_double_modifier_tests.rs"]
mod double_modifier_tests;
