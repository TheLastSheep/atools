use crate::updater::ensure_updater_window;

#[test]
fn updater_commands_allow_only_main_and_settings_windows() {
    assert!(ensure_updater_window("main").is_ok());
    assert!(ensure_updater_window("settings").is_ok());
    assert_eq!(
        ensure_updater_window("plugin-detach-1")
            .expect_err("detached plugin window must be rejected")
            .code,
        "forbidden_window"
    );
}
