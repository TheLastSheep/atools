use super::*;
#[tokio::test(flavor = "current_thread")]
async fn known_double_modifier_preflight_denials_do_not_restore_or_commit() {
    for code in [
        "SETTINGS_HOTKEY_LISTEN_PERMISSION_REQUIRED",
        "SETTINGS_HOTKEY_DOUBLE_TAP_UNSUPPORTED",
    ] {
        let fixture = fixture();
        let steps = Arc::new(Mutex::new(Vec::new()));
        let mut hotkey = hotkey_effect("Command+Shift+F10", steps.clone());
        {
            let mut state = hotkey.state.lock().unwrap();
            state.reject_code = Some(code.into());
            state.fail_restore = true;
        }
        let error = execute_renderer_patch_with_hotkey_port(
            fixture.db.clone(),
            Some(fixture.expected.clone()),
            hotkey_patch("Command+Command"),
            &mut panic_opacity(),
            &mut panic_tray(),
            &mut hotkey,
            |_| panic!("denied write cannot notify"),
        )
        .await
        .unwrap_err();
        assert_eq!(error, code);
        assert_eq!(*steps.lock().unwrap(), ["hotkey-read", "hotkey-apply"]);
        assert_eq!(settings(&fixture.db)["hotkey"], "Command+Shift+F10");
    }
}
#[tokio::test(flavor = "current_thread")]
async fn inactive_same_label_is_reapplied_instead_of_false_noop() {
    let fixture = fixture();
    let steps = Arc::new(Mutex::new(Vec::new()));
    let mut hotkey = hotkey_effect("Command+Shift+F10", steps.clone());
    hotkey.state.lock().unwrap().healthy = false;
    execute_renderer_patch_with_hotkey_port(
        fixture.db.clone(),
        Some(fixture.expected.clone()),
        hotkey_patch("Command+Shift+F10"),
        &mut panic_opacity(),
        &mut panic_tray(),
        &mut hotkey,
        |_| true,
    )
    .await
    .unwrap();
    assert!(hotkey.state.lock().unwrap().healthy);
    assert_eq!(*steps.lock().unwrap(), ["hotkey-read", "hotkey-apply"]);
}
