use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::{
    execute_renderer_patch_with_hotkey_port, fixture, hotkey_patch, panic_opacity, panic_tray,
    unregistered_hotkey_effect, SETTINGS_KEY,
};

#[tokio::test(flavor = "current_thread")]
async fn unregistered_main_hotkey_can_be_repaired_and_committed_without_rewriting_other_raw_fields()
{
    let mut fixture = fixture();
    let raw = json!({
        "hotkey": "unsupported legacy shortcut",
        "unrelated": {"retained": true}
    })
    .to_string();
    fixture.db.set_setting(SETTINGS_KEY, &raw).unwrap();
    fixture.expected = fixture
        .db
        .read_renderer_general_settings()
        .unwrap()
        .unwrap();

    let steps = Arc::new(Mutex::new(Vec::new()));
    let mut hotkey = unregistered_hotkey_effect(Arc::clone(&steps));
    let state = Arc::clone(&hotkey.state);
    let receipt = execute_renderer_patch_with_hotkey_port(
        Arc::clone(&fixture.db),
        Some(fixture.expected.clone()),
        hotkey_patch("Command+Shift+F11"),
        &mut panic_opacity(),
        &mut panic_tray(),
        &mut hotkey,
        |_| true,
    )
    .await
    .unwrap();

    let stored: Value = serde_json::from_str(&receipt.raw).unwrap();
    assert_eq!(stored["hotkey"], "Command+Shift+F11");
    assert_eq!(stored["unrelated"]["retained"], true);
    assert_eq!(state.lock().unwrap().label, "Command+Shift+F11");
    assert!(state.lock().unwrap().registered);
    assert_eq!(*steps.lock().unwrap(), ["hotkey-read", "hotkey-apply"]);
}

#[tokio::test(flavor = "current_thread")]
async fn hotkey_commit_conflict_restores_the_confirmed_unregistered_state() {
    let mut fixture = fixture();
    let raw = json!({"hotkey": "unsupported legacy shortcut", "unrelated": "before"}).to_string();
    fixture.db.set_setting(SETTINGS_KEY, &raw).unwrap();
    fixture.expected = fixture
        .db
        .read_renderer_general_settings()
        .unwrap()
        .unwrap();

    let steps = Arc::new(Mutex::new(Vec::new()));
    let mut hotkey = unregistered_hotkey_effect(Arc::clone(&steps));
    let competitor = Arc::clone(&fixture.db);
    hotkey.state.lock().unwrap().conflict_write = Some((
        competitor,
        r#"{"hotkey":"external writer","otherWriter":true}"#.into(),
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
    assert!(!hotkey.state.lock().unwrap().registered);
    assert_eq!(hotkey.state.lock().unwrap().label, "");
    let stored: Value = serde_json::from_str(
        &fixture
            .db
            .read_renderer_general_settings()
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(stored["hotkey"], "external writer");
    assert_eq!(stored["otherWriter"], true);
    assert_eq!(
        *steps.lock().unwrap(),
        ["hotkey-read", "hotkey-apply", "hotkey-restore"]
    );
}
