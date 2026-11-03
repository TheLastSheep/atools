use super::{
    main_hotkey_schema as hotkey_schema, main_hotkey_startup_schema as schema,
    main_hotkey_startup_storage as storage, native, probe, state::Harness,
};
use parking_lot::Mutex;
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tauri::{AppHandle, Manager, Webview, Wry};

type StartupResult = Result<crate::hotkey::MainHotkeyStartup, ()>;

#[derive(Default)]
struct StartupObservation(Mutex<Option<StartupResult>>);

pub(super) fn initialize(app: &AppHandle<Wry>) {
    let Some(harness) = app.try_state::<Harness>() else {
        return;
    };
    let profile = harness.profile();
    if !profile.main_hotkey_recovery_first && !profile.main_hotkey_recovery_second {
        return;
    }
    let startup = crate::hotkey::initialize_main_hotkey_from_settings(app).map_err(|_| ());
    app.manage(StartupObservation(Mutex::new(Some(startup))));
}

pub(super) fn start(app: AppHandle<Wry>) {
    tauri::async_runtime::spawn(async move {
        let passed = run(&app).await;
        let code = if passed { 0 } else { 1 };
        if let Some(status) = app.try_state::<Arc<super::super::FixtureExitStatus>>() {
            status
                .code
                .store(code, std::sync::atomic::Ordering::Release);
        }
        app.exit(code);
    });
}

async fn run(app: &AppHandle<Wry>) -> bool {
    let Some(state) = app.try_state::<Harness>() else {
        return false;
    };
    let harness = (*state).clone();
    let profile = harness.profile_arc();
    let first = profile.main_hotkey_recovery_first;
    let mut observations = if first {
        schema::empty_first()
    } else {
        schema::empty_second()
    };
    let mut errors = Vec::new();
    set_identity(&profile, &mut observations);
    let activity_before = runtime_activity(app);

    let result = if first {
        first_flow(app, &harness, &mut observations).await
    } else {
        second_flow(app, &harness, &mut observations).await
    };
    if let Err(error) = result {
        push_error(&mut errors, error);
    }

    let closed = close_owned_child(app, &harness).await;
    set_bool(&mut observations, "childClosed", Some(closed));
    if !closed {
        push_error(&mut errors, schema::CLOSE_FAILED);
    }

    if !first {
        set_bool(&mut observations, "releaseAttempted", Some(true));
        let released = crate::hotkey::release_owned_main_hotkey(app).is_ok()
            && crate::hotkey::read_owned_main_hotkey_state(app)
                .is_ok_and(|state| state.label().is_none())
            && !is_registered(app, hotkey_schema::HOTKEY_B);
        set_bool(&mut observations, "releaseConfirmed", Some(released));
        if !released {
            push_error(&mut errors, schema::RELEASE_FAILED);
        }
    }

    let activity_after = runtime_activity(app);
    set_bool(
        &mut observations,
        "pluginUiOpened",
        observed_any(activity_before.0, activity_after.0),
    );
    set_bool(
        &mut observations,
        "preloadStarted",
        observed_any(activity_before.1, activity_after.1),
    );
    if observations["pluginUiOpened"].as_bool() != Some(false)
        || observations["preloadStarted"].as_bool() != Some(false)
    {
        push_error(&mut errors, schema::RUNTIME_STARTED);
    }
    set_identity(&profile, &mut observations);
    write_report(app, &harness, first, observations, errors).await
}

async fn first_flow(
    app: &AppHandle<Wry>,
    harness: &Harness,
    observations: &mut Value,
) -> Result<(), &'static str> {
    set_bool(
        observations,
        "startupNeedsRecovery",
        startup_is(app, crate::hotkey::MainHotkeyStartup::NeedsRecovery),
    );
    let before = owned_state(app);
    set_bool(
        observations,
        "startupAttempted",
        before.as_ref().map(|state| state.startup_attempted()),
    );
    let unregistered = before.as_ref().map(|state| {
        state.startup_attempted()
            && state.label().is_none()
            && !is_registered(app, hotkey_schema::HOTKEY_A)
            && !is_registered(app, schema::HOTKEY_B)
    });
    set_bool(observations, "ownedHotkeyUnregistered", unregistered);
    if observations["startupNeedsRecovery"].as_bool() != Some(true)
        || observations["startupAttempted"].as_bool() != Some(true)
        || unregistered != Some(true)
    {
        return Err(schema::STARTUP_INVALID);
    }

    native::wait_for_closed(app)
        .await
        .map_err(|_| schema::GENERAL_OPEN_FAILED)?;
    harness
        .wait_main_ready()
        .await
        .map_err(|_| schema::GENERAL_OPEN_FAILED)?;
    prepare_catalog(app, harness).await?;
    let child = open_general(app, harness).await?;
    let initial = probe::child_hotkey_startup_inspect(app, harness, &child)
        .await
        .map_err(|_| schema::UI_INVALID)?;
    set_bool(observations, "generalOpened", Some(general_route(&initial)));
    set_bool(
        observations,
        "hotkeyControlEmpty",
        initial["hotkeyControlEmpty"].as_bool(),
    );
    if !startup_ui_valid(&initial) {
        return Err(schema::UI_INVALID);
    }

    let edited = probe::child_hotkey_startup_edit_placeholder(
        app,
        harness,
        &child,
        storage::INITIAL_PLACEHOLDER,
        storage::RECOVERY_PLACEHOLDER,
    )
    .await
    .map_err(|_| schema::PLACEHOLDER_FAILED)?;
    let edit_dispatched = edited["placeholderClickDispatched"].as_bool() == Some(true)
        && edited["inputDispatched"].as_bool() == Some(true)
        && edited["changeDispatched"].as_bool() == Some(true)
        && edited["projectedHotkeyEmpty"].as_bool() == Some(true)
        && edited["currentShortcutEmpty"].as_bool() == Some(true)
        && edited["documentHidden"].as_bool() == Some(true)
        && edited["documentHasFocus"].as_bool() == Some(false);
    set_bool(
        observations,
        "placeholderEditDispatched",
        Some(edit_dispatched),
    );
    let raw_after_edit = storage::read_general(harness.profile()).await?;
    let placeholder_stored = edited["placeholderStored"].as_bool() == Some(true)
        && raw_after_edit["placeholder"].as_str() == Some(storage::RECOVERY_PLACEHOLDER);
    set_bool(observations, "placeholderStored", Some(placeholder_stored));
    let invalid_preserved = edited["projectedHotkeyEmpty"].as_bool() == Some(true)
        && raw_after_edit["hotkey"].as_str() == Some(schema::INVALID_SENTINEL);
    set_bool(
        observations,
        "invalidHotkeyPreserved",
        Some(invalid_preserved),
    );
    if !edit_dispatched || !placeholder_stored {
        return Err(schema::PLACEHOLDER_FAILED);
    }
    if !invalid_preserved {
        return Err(schema::INVALID_PRESERVED_FAILED);
    }

    let repaired = probe::child_main_hotkey_record(
        app,
        harness,
        &child,
        "F11",
        schema::HOTKEY_B,
        schema::HOTKEY_B,
    )
    .await
    .map_err(|_| schema::RECORD_FAILED)?;
    let dispatched = record_was_dispatched(&repaired);
    set_bool(observations, "repairChordDispatched", Some(dispatched));
    let raw_repaired = storage::read_general(harness.profile()).await?;
    let stored = dispatched
        && repaired["storedValue"].as_str() == Some(schema::HOTKEY_B)
        && raw_repaired["hotkey"].as_str() == Some(schema::HOTKEY_B);
    set_bool(observations, "repairStored", Some(stored));
    let owned = owned_state(app);
    let state_b = owned
        .as_ref()
        .is_some_and(|state| state.startup_attempted() && state.label() == Some(schema::HOTKEY_B));
    set_bool(observations, "repairOwnedState", Some(state_b));
    let manager_b = owned_matches(app, schema::HOTKEY_B);
    set_bool(observations, "repairManagerRegistered", Some(manager_b));
    if !dispatched || !stored {
        return Err(schema::RECORD_FAILED);
    }
    if !state_b || !manager_b {
        return Err(schema::STATE_INVALID);
    }

    close_child(app, harness, &child)
        .await
        .map_err(|_| schema::CLOSE_FAILED)?;
    set_bool(observations, "childClosed", Some(true));
    let owned_before_exit = owned_matches(app, schema::HOTKEY_B);
    set_bool(
        observations,
        "hotkeyOwnedBeforeExit",
        Some(owned_before_exit),
    );
    if !owned_before_exit {
        return Err(schema::STATE_INVALID);
    }
    Ok(())
}

async fn second_flow(
    app: &AppHandle<Wry>,
    harness: &Harness,
    observations: &mut Value,
) -> Result<(), &'static str> {
    let claimed = super::super::fixture_owner::main_hotkey_resume_claimed(harness.profile());
    set_bool(observations, "resumeClaimed", Some(claimed));
    if !claimed {
        return Err(schema::OWNER_INVALID);
    }
    let startup = startup_is(app, crate::hotkey::MainHotkeyStartup::Registered);
    set_bool(observations, "startupRegistered", startup);
    let state = owned_state(app);
    let state_b = state
        .as_ref()
        .is_some_and(|state| state.startup_attempted() && state.label() == Some(schema::HOTKEY_B));
    set_bool(observations, "startupOwnedStateB", Some(state_b));
    let manager_b = owned_matches(app, schema::HOTKEY_B);
    set_bool(observations, "startupManagerRegistered", Some(manager_b));
    if startup != Some(true) || !state_b || !manager_b {
        return Err(schema::STARTUP_INVALID);
    }

    native::wait_for_closed(app)
        .await
        .map_err(|_| schema::GENERAL_OPEN_FAILED)?;
    harness
        .wait_main_ready()
        .await
        .map_err(|_| schema::GENERAL_OPEN_FAILED)?;
    prepare_catalog(app, harness).await?;
    let child = open_general(app, harness).await?;
    let actual = probe::child_main_hotkey_inspect(app, harness, &child)
        .await
        .map_err(|_| schema::UI_INVALID)?;
    let ui_b = inspect_matches(&actual, schema::HOTKEY_B);
    let db_b = storage::read_general(harness.profile())
        .await
        .is_ok_and(|settings| settings["hotkey"].as_str() == Some(schema::HOTKEY_B));
    set_bool(observations, "generalOpened", Some(general_route(&actual)));
    set_bool(observations, "generalReadBackB", Some(ui_b && db_b));
    if !ui_b || !db_b {
        return Err(schema::UI_INVALID);
    }
    close_child(app, harness, &child)
        .await
        .map_err(|_| schema::CLOSE_FAILED)?;
    set_bool(observations, "childClosed", Some(true));
    Ok(())
}

async fn open_general(
    app: &AppHandle<Wry>,
    harness: &Harness,
) -> Result<Webview<Wry>, &'static str> {
    let before = probe::main_open_state(app, harness).await.ok();
    let opened = probe::main_open_settings(app, harness)
        .await
        .map_err(|_| schema::GENERAL_OPEN_FAILED)?;
    if opened["openCallAvailable"].as_bool() != Some(true)
        || opened["openCallDispatched"].as_bool() != Some(true)
    {
        return Err(schema::GENERAL_OPEN_FAILED);
    }
    let (child, _) = super::diagnostics::active_child_after_open(app, harness, before)
        .await
        .map_err(|_| schema::GENERAL_OPEN_FAILED)?;
    let route = probe::child_theme_navigate(app, harness, &child)
        .await
        .map_err(|_| schema::GENERAL_OPEN_FAILED)?;
    if route["routeGeneral"].as_bool() != Some(true)
        || route["themeControlFound"].as_bool() != Some(true)
    {
        return Err(schema::GENERAL_OPEN_FAILED);
    }
    Ok(child)
}

async fn prepare_catalog(app: &AppHandle<Wry>, harness: &Harness) -> Result<(), &'static str> {
    native::select_real_catalog_target(app, harness)
        .await
        .map_err(|_| schema::STATE_INVALID)?;
    let target = harness.target().ok_or(schema::STATE_INVALID)?;
    super::plugin_inventory_journey::release_pending_inventory(app, harness, &target)
        .await
        .map_err(|_| schema::STATE_INVALID)
}

async fn close_child(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
) -> Result<(), &'static str> {
    super::cleanup::close_child_via_plugin(app, harness, child).await?;
    native::wait_for_closed(app).await
}

async fn close_owned_child(app: &AppHandle<Wry>, harness: &Harness) -> bool {
    if let Ok((child, _)) = native::active_child(app, Duration::from_millis(500)).await {
        if close_child(app, harness, &child).await.is_err() {
            return false;
        }
    }
    native::wait_for_closed(app).await.is_ok()
}

async fn write_report(
    app: &AppHandle<Wry>,
    harness: &Harness,
    first: bool,
    mut observations: Value,
    mut errors: Vec<&'static str>,
) -> bool {
    let profile = harness.profile();
    set_identity(profile, &mut observations);
    let make_report = |observations: Value, errors: &[&'static str]| {
        if first {
            schema::first_report(profile, observations, errors)
        } else {
            schema::second_report(
                profile,
                profile.resume_hotkey_owner_pid.unwrap_or_default(),
                observations,
                errors,
            )
        }
    };
    let mut report = make_report(observations.clone(), &errors);
    let valid = if first {
        schema::valid_first(profile, &report)
    } else {
        schema::valid_second(
            profile,
            &report,
            profile.resume_hotkey_owner_pid.unwrap_or_default(),
        )
    };
    if !valid {
        push_error(&mut errors, schema::REPORT_WRITE_FAILED);
        report = make_report(observations, &errors);
    }
    let name = if first {
        schema::FIRST_REPORT
    } else {
        schema::SECOND_REPORT
    };
    if super::local_app_search_report::write_owned_artifact(profile, name, &report).is_err() {
        return false;
    }
    let passed = errors.is_empty()
        && if first {
            schema::observations_passed(&report["observations"], true)
        } else {
            schema::observations_passed(&report["observations"], false)
        };
    if !passed {
        if let Some(status) = app.try_state::<Arc<super::super::FixtureExitStatus>>() {
            status.code.store(1, std::sync::atomic::Ordering::Release);
        }
    }
    passed
}

fn startup_is(app: &AppHandle<Wry>, expected: crate::hotkey::MainHotkeyStartup) -> Option<bool> {
    app.try_state::<StartupObservation>()
        .and_then(|state| *state.0.lock())
        .and_then(Result::ok)
        .map(|actual| actual == expected)
}

fn owned_state(app: &AppHandle<Wry>) -> Option<crate::hotkey::OwnedMainHotkeyStateSnapshot> {
    crate::hotkey::read_owned_main_hotkey_state(app).ok()
}

fn owned_matches(app: &AppHandle<Wry>, expected: &str) -> bool {
    crate::hotkey::read_owned_main_hotkey(app).is_ok_and(|snapshot| snapshot.label() == expected)
        && is_registered(app, expected)
}

fn is_registered(app: &AppHandle<Wry>, label: &str) -> bool {
    crate::hotkey::is_shortcut_registered(app, label)
}

fn startup_ui_valid(value: &Value) -> bool {
    general_route(value)
        && value["hotkeyControlUnique"].as_bool() == Some(true)
        && value["hotkeyControlEmpty"].as_bool() == Some(true)
        && value["projectedHotkeyEmpty"].as_bool() == Some(true)
        && value["currentShortcutEmpty"].as_bool() == Some(true)
        && value["documentHidden"].as_bool() == Some(true)
        && value["documentHasFocus"].as_bool() == Some(false)
}

fn general_route(value: &Value) -> bool {
    value["routeGeneral"].as_bool() == Some(true)
}

fn inspect_matches(value: &Value, expected: &str) -> bool {
    general_route(value)
        && value["controlUnique"].as_bool() == Some(true)
        && value["displayValue"].as_str() == Some(expected)
        && value["storedValue"].as_str() == Some(expected)
        && value["documentHidden"].as_bool() == Some(true)
        && value["documentHasFocus"].as_bool() == Some(false)
}

fn record_was_dispatched(value: &Value) -> bool {
    general_route(value)
        && value["controlUnique"].as_bool() == Some(true)
        && value["documentHidden"].as_bool() == Some(true)
        && value["documentHasFocus"].as_bool() == Some(false)
        && value["clickDispatched"].as_bool() == Some(true)
        && value["keyDownDispatched"].as_bool() == Some(true)
        && value["keyUpDispatched"].as_bool() == Some(true)
}

fn runtime_activity(app: &AppHandle<Wry>) -> (Option<bool>, Option<bool>) {
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return (None, None);
    };
    let plugin_ui = Some(state.active_plugin.lock().is_some());
    let preload = crate::legacy_runtime::inventory_snapshot(app)
        .ok()
        .filter(|(_, truncated)| !truncated)
        .map(|(sessions, _)| !sessions.is_empty());
    (plugin_ui, preload)
}

fn observed_any(before: Option<bool>, after: Option<bool>) -> Option<bool> {
    if before == Some(true) || after == Some(true) {
        Some(true)
    } else if before == Some(false) && after == Some(false) {
        Some(false)
    } else {
        None
    }
}

fn set_identity(profile: &super::super::profile::Profile, observations: &mut Value) {
    let (device, inode) = storage::database_identity(profile);
    observations["databaseDevice"] = device.map(Value::String).unwrap_or(Value::Null);
    observations["databaseInode"] = inode.map(Value::String).unwrap_or(Value::Null);
}

fn set_bool(observations: &mut Value, key: &str, value: Option<bool>) {
    observations[key] = value.map(Value::Bool).unwrap_or(Value::Null);
}

fn push_error(errors: &mut Vec<&'static str>, code: &'static str) {
    if !errors.contains(&code) {
        errors.push(code);
    }
}
