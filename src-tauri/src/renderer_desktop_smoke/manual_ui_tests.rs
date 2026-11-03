use super::*;

fn args(root: &Path, output: &Path, run_id: &str) -> Vec<String> {
    [
        "--fixture-root",
        root.to_str().unwrap(),
        "--renderer-dist",
        "/private/tmp/renderer-dist",
        "--output",
        output.to_str().unwrap(),
        "--auto-clear",
        "never",
        "--journey",
        "manual-ui",
        "--run-id",
        run_id,
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

#[test]
fn manual_profile_is_distinct_fixed_fresh_and_bounded() {
    let run_id = uuid::Uuid::new_v4().simple().to_string();
    let root = Path::new("/private/tmp").join(format!("atools-renderer-manual-{run_id}"));
    let output = root.join("report.json");
    let profile = Profile::from_args(&args(&root, &output, &run_id)).unwrap();
    assert!(profile.manual_ui);
    assert!(!profile.settings_input_journey);
    assert_eq!(
        profile.identifier,
        format!("dev.atools.renderer-manual.{run_id}")
    );
    assert_eq!(LIMIT, Duration::from_secs(600));
    profile.prepare().unwrap();
    validate_owner(&profile).unwrap();
    assert!(
        profile.prepare().is_err(),
        "manual runs cannot resume an existing DB"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn manual_profile_rejects_wrong_root_output_and_owner_identity() {
    let run_id = uuid::Uuid::new_v4().simple().to_string();
    let root = Path::new("/private/tmp").join(format!("atools-renderer-manual-{run_id}"));
    assert!(
        Profile::from_args(&args(&root, Path::new("/private/tmp/report.json"), &run_id)).is_err()
    );
    let output = root.join("report.json");
    let mut profile = Profile::from_args(&args(&root, &output, &run_id)).unwrap();
    assert!(validate_owner(&profile).is_err());
    profile.prepare().unwrap();
    profile.identifier = "dev.atools.desktop".into();
    assert!(validate_owner(&profile).is_err());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn manual_allowlist_preserves_native_child_flow_and_blocks_side_effects() {
    for command in [
        "open_renderer_settings",
        "close_renderer_settings",
        "notify_renderer_settings_input",
        "hide_main_window",
        "list_launcher_apps",
    ] {
        assert!(command_allowed(command, &json!({})), "{command}");
    }
    for command in [
        "prepare_legacy_node",
        "call_agent_tool",
        "perform_native_http_request",
        "get_renderer_last_copied_content",
        "copy_text",
        "sync_app_shortcuts",
        "set_setting",
        "plugin:fs|read_file",
        "renderer_probe_ready",
    ] {
        assert!(!command_allowed(command, &json!({})), "{command}");
    }
    for operation in [
        "ready",
        "updateSubInput",
        "outAcknowledged",
        "close",
        "setTheme",
        "setWindowOpacity",
        "readCommands",
        "startHotkeyRecording",
        "stopHotkeyRecording",
    ] {
        assert!(
            command_allowed("call_renderer_settings", &json!({"operation":operation})),
            "{operation}"
        );
    }
    for operation in [
        "setLaunchAtLogin",
        "readLaunchAtLogin",
        "resolveLegacyLaunchAtLogin",
        "pickLocalShortcut",
    ] {
        assert!(
            !command_allowed("call_renderer_settings", &json!({"operation":operation})),
            "{operation}"
        );
    }
}

#[test]
fn manual_patch_validates_nested_search_escape_fields_and_rejects_os_fields() {
    assert!(safe_patch(
        &json!({"builtinAppShortcutsEnabled":{"search":false,"esc":true}})
    ));
    assert!(safe_patch(
        &json!({"theme":"light", "opacity":0.8, "autoBackToSearch":"never"})
    ));
    assert!(safe_patch(&json!({"hotkey":"Option+Space"})));
    for changes in [
        json!({}),
        json!({"hotkey":false}),
        json!({"hotkey":"Option+Space", "showTrayIcon":true}),
        json!({"showTrayIcon":true}),
        json!({"localAppSearch":true}),
        json!({"theme":"invalid"}),
        json!({"opacity":5}),
        json!({"builtinAppShortcutsEnabled":{"search":"false"}}),
        json!({"builtinAppShortcutsEnabled":{"unknown":true}}),
    ] {
        assert!(!safe_patch(&changes), "{changes}");
    }
}

#[test]
fn manual_state_catalog_is_empty_and_confined_to_owned_fixture() {
    let run_id = uuid::Uuid::new_v4().simple().to_string();
    let root = Path::new("/private/tmp").join(format!("atools-renderer-manual-{run_id}"));
    let profile = Profile::from_args(&args(&root, &root.join("report.json"), &run_id)).unwrap();
    profile.prepare().unwrap();
    let config = atools_core::AppConfig::with_base_dir(root.join("app-data"));
    config.ensure_dirs().unwrap();
    let db = Arc::new(atools_core::Database::open(&config.db_path()).unwrap());
    let clipboard = Arc::new(DisabledClipboard::default());
    let pasteboard = Arc::new(
        crate::pasteboard_runtime::PasteboardRuntime::new(clipboard, db.clone(), &config).unwrap(),
    );
    let state = crate::state::AppState::new_prepopulated_inventory(config, db, None, pasteboard);
    let state = prepare_state(state, &profile).unwrap();
    assert!(state.launcher_app_catalog.snapshot().unwrap().is_empty());
    assert_eq!(
        state.launcher_app_catalog.watch_roots().unwrap(),
        vec![root.join("launcher-apps")]
    );
    drop(state);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn exit_observation_does_not_claim_process_or_teardown_completion() {
    let run_id = uuid::Uuid::new_v4().simple().to_string();
    let root = Path::new("/private/tmp").join(format!("atools-renderer-manual-{run_id}"));
    let profile = Profile::from_args(&args(&root, &root.join("report.json"), &run_id)).unwrap();
    let value = exit_report_payload(
        &profile,
        1234,
        false,
        false,
        json!({"settingsAtExit":{"sessionCount":1}}),
    );
    assert_eq!(
        value["lifecyclePhase"],
        "exit-observed-before-host-teardown"
    );
    assert_eq!(value["exitObservation"], "runtime-exit");
    assert_eq!(value["processTerminalStatus"], "external-runner");
    assert_eq!(value["guiAcceptance"], "unverified");
    assert_eq!(value["runReturnCode"], Value::Null);
    assert!(value.get("exitReason").is_none());
    assert!(value.get("passed").is_none());
    assert_eq!(value["deadlineRequested"], false);
    assert_eq!(value["resources"]["settingsAtExit"]["sessionCount"], 1);
    assert_eq!(
        exit_report_payload(&profile, 600001, true, false, json!({}))["deadlineRequested"],
        true
    );
}

#[test]
fn repeated_exit_observations_keep_the_first_private_report() {
    let run_id = uuid::Uuid::new_v4().simple().to_string();
    let root = Path::new("/private/tmp").join(format!("atools-renderer-manual-{run_id}"));
    let profile = Profile::from_args(&args(&root, &root.join("report.json"), &run_id)).unwrap();
    profile.prepare().unwrap();
    let writer = ExitReportWriter::default();
    let first = json!({"observation":"first"});
    writer.write_once(&profile, &first).unwrap();
    let bytes = std::fs::read(&profile.output).unwrap();
    writer
        .write_once(&profile, &json!({"observation":"later"}))
        .unwrap();
    assert_eq!(std::fs::read(&profile.output).unwrap(), bytes);
    assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), first);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn failed_exit_report_write_is_returned_and_can_retry_without_false_completion() {
    let run_id = uuid::Uuid::new_v4().simple().to_string();
    let root = Path::new("/private/tmp").join(format!("atools-renderer-manual-{run_id}"));
    let profile = Profile::from_args(&args(&root, &root.join("report.json"), &run_id)).unwrap();
    profile.prepare().unwrap();
    std::fs::create_dir(&profile.output).unwrap();
    let writer = ExitReportWriter::default();
    assert!(writer
        .write_once(&profile, &json!({"observed":true}))
        .is_err());
    assert!(!writer.written.load(Ordering::Acquire));
    std::fs::remove_dir(&profile.output).unwrap();
    writer
        .write_once(&profile, &json!({"observed":true}))
        .unwrap();
    assert!(writer.written.load(Ordering::Acquire));
    std::fs::remove_dir_all(root).unwrap();
}
