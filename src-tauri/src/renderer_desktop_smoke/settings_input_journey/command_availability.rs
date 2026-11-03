use super::{
    command_availability_schema::{self as schema, Checks},
    probe,
    state::Harness,
};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Wry};

#[path = "command_availability_storage.rs"]
mod storage;
use storage::{baseline_enabled, read_settings, wait_for_disabled_state, DisabledSetting};

pub(super) async fn run(app: &AppHandle<Wry>, harness: &Harness, child: &tauri::Webview<Wry>) {
    let mut checks = Checks::default();
    let mut errors = Vec::new();
    let Some(target) = harness.target() else {
        push_error(&mut errors, harness, schema::BASELINE_INVALID);
        write_report(harness, &checks, &errors);
        return;
    };
    let command_id = format!("direct:app:{}", target.1.replace('\\', "/"));
    let before = read_settings(harness).await.ok();
    let baseline_db_enabled = before
        .as_ref()
        .is_some_and(|snapshot| baseline_enabled(&snapshot.disabled));

    let child_baseline =
        match probe::child_availability_baseline(app, harness, child, &target).await {
            Ok(value) => Some(value),
            Err(_) => {
                push_error(&mut errors, harness, schema::PROBE_FAILED);
                None
            }
        };
    let main_baseline = match probe::main_command_availability(app, harness, &target, true).await {
        Ok(value) => Some(value),
        Err(_) => {
            push_error(&mut errors, harness, schema::PROBE_FAILED);
            None
        }
    };
    checks.baseline_enabled = baseline_db_enabled
        && child_baseline.as_ref().is_some_and(child_baseline_valid)
        && main_baseline.as_ref().is_some_and(main_baseline_valid);
    if !checks.baseline_enabled {
        push_error(&mut errors, harness, schema::BASELINE_INVALID);
    }

    let mut mutation_may_have_happened = false;
    if checks.baseline_enabled {
        match probe::child_availability_disable(app, harness, child, &target).await {
            Ok(evidence) => {
                checks.disable_menu_dispatched = menu_dispatched_valid(&evidence);
                mutation_may_have_happened = bool_field(&evidence, "clickDispatched");
                if !checks.disable_menu_dispatched {
                    push_error(&mut errors, harness, schema::DISABLE_FAILED);
                }
            }
            Err(_) => push_error(&mut errors, harness, schema::PROBE_FAILED),
        }
        if !checks.disable_menu_dispatched {
            push_error(&mut errors, harness, schema::DISABLE_FAILED);
        }

        let (disabled_written, disabled_snapshot) =
            wait_for_disabled_state(harness, &command_id, true).await;
        checks.disabled_stored = disabled_written;
        mutation_may_have_happened |= disabled_snapshot.as_ref().is_some_and(|snapshot| {
            snapshot.disabled == DisabledSetting::Valid(vec![command_id.clone()])
        });
        if !checks.disabled_stored {
            push_error(&mut errors, harness, schema::DISABLE_NOT_STORED);
        }

        match probe::child_availability_disabled_read_back(app, harness, child, &command_id).await {
            Ok(evidence) => checks.child_disabled_read_back = read_back_valid(&evidence, true),
            Err(_) => push_error(&mut errors, harness, schema::PROBE_FAILED),
        }
        if !checks.child_disabled_read_back {
            push_error(&mut errors, harness, schema::PROBE_FAILED);
        }

        match probe::main_command_availability(app, harness, &target, false).await {
            Ok(evidence) => checks.main_excluded = main_search_valid(&evidence, false),
            Err(_) => push_error(&mut errors, harness, schema::PROBE_FAILED),
        }
        if !checks.main_excluded {
            push_error(&mut errors, harness, schema::MAIN_NOT_EXCLUDED);
        }

        match probe::child_availability_enable(app, harness, child, &target).await {
            Ok(evidence) => {
                checks.enable_menu_dispatched = menu_dispatched_valid(&evidence);
                if !checks.enable_menu_dispatched {
                    push_error(&mut errors, harness, schema::ENABLE_FAILED);
                }
            }
            Err(_) => push_error(&mut errors, harness, schema::PROBE_FAILED),
        }
        if !checks.enable_menu_dispatched {
            push_error(&mut errors, harness, schema::ENABLE_FAILED);
        }

        checks.enabled_stored = wait_for_disabled_state(harness, &command_id, false).await.0;
        if !checks.enabled_stored {
            push_error(&mut errors, harness, schema::ENABLE_NOT_STORED);
        }

        match probe::child_availability_enabled_read_back(app, harness, child, &command_id).await {
            Ok(evidence) => checks.child_enabled_read_back = read_back_valid(&evidence, false),
            Err(_) => push_error(&mut errors, harness, schema::PROBE_FAILED),
        }
        if !checks.child_enabled_read_back {
            push_error(&mut errors, harness, schema::PROBE_FAILED);
        }

        match probe::main_command_availability(app, harness, &target, true).await {
            Ok(evidence) => checks.main_restored = main_search_valid(&evidence, true),
            Err(_) => push_error(&mut errors, harness, schema::PROBE_FAILED),
        }
        if !checks.main_restored {
            push_error(&mut errors, harness, schema::MAIN_NOT_RESTORED);
        }
        if mutation_may_have_happened
            && !(checks.enable_menu_dispatched
                && checks.enabled_stored
                && checks.child_enabled_read_back
                && checks.main_restored)
        {
            push_error(&mut errors, harness, schema::RESTORE_FAILED);
        }
    }

    let after = read_settings(harness).await.ok();
    checks.unrelated_settings_unchanged = before
        .as_ref()
        .zip(after.as_ref())
        .is_some_and(|(before, after)| before.unrelated == after.unrelated);
    if !checks.unrelated_settings_unchanged {
        push_error(&mut errors, harness, schema::UNRELATED_SETTINGS_CHANGED);
    }
    write_report(harness, &checks, &errors);
}

fn child_baseline_valid(value: &Value) -> bool {
    bool_field(value, "routeAllCommands")
        && value["targetCount"].as_u64() == Some(1)
        && value["openMenuCount"].as_u64() == Some(0)
        && hidden_unfocused(value)
}

fn main_baseline_valid(value: &Value) -> bool {
    main_store_ready(value)
        && value["targetCount"].as_u64().is_some_and(|count| count > 0)
        && bool_field(value, "inputFound")
        && bool_field(value, "inputEmpty")
        && hidden_unfocused(value)
}

fn main_search_valid(value: &Value, should_be_present: bool) -> bool {
    main_store_ready(value)
        && bool_field(value, "inputFound")
        && bool_field(value, "inputEmpty")
        && hidden_unfocused(value)
        && value["targetCount"].as_u64().is_some_and(|count| {
            if should_be_present {
                count > 0
            } else {
                count == 0
            }
        })
}

fn main_store_ready(value: &Value) -> bool {
    bool_field(value, "storeUnique")
        && bool_field(value, "storeReady")
        && bool_field(value, "searchCallable")
}

fn menu_dispatched_valid(value: &Value) -> bool {
    bool_field(value, "routeAllCommands")
        && value["targetCount"].as_u64() == Some(1)
        && bool_field(value, "menuOpened")
        && bool_field(value, "menuItemFound")
        && bool_field(value, "clickDispatched")
        && bool_field(value, "menuStateReflected")
        && value["alreadyDesired"].as_bool() == Some(false)
        && hidden_unfocused(value)
}

fn read_back_valid(value: &Value, disabled: bool) -> bool {
    let expected_count = if disabled { 1 } else { 0 };
    bool_field(value, "routeAllCommands")
        && bool_field(value, "arrayValue")
        && bool_field(value, "readBack")
        && value["entryCount"].as_u64() == Some(expected_count)
        && hidden_unfocused(value)
}

fn hidden_unfocused(value: &Value) -> bool {
    bool_field(value, "documentHidden") && !bool_field(value, "documentHasFocus")
}

fn bool_field(value: &Value, key: &str) -> bool {
    value[key].as_bool() == Some(true)
}

fn push_error(errors: &mut Vec<&'static str>, harness: &Harness, code: &'static str) {
    if !errors.contains(&code) {
        errors.push(code);
        harness.add_error(code);
    }
}

fn write_report(harness: &Harness, checks: &Checks, errors: &[&'static str]) {
    let report = schema::report(harness.profile(), checks, errors);
    if !schema::valid_report(&report) || write_report_file(harness.profile(), &report).is_err() {
        harness.add_error(schema::REPORT_WRITE_FAILED);
    }
}

fn write_report_file(
    profile: &super::super::profile::Profile,
    report: &Value,
) -> Result<(), &'static str> {
    let path = report_path(profile)?;
    let bytes = serde_json::to_vec(report).map_err(|_| schema::REPORT_WRITE_FAILED)?;
    write_private_file(&path, &bytes)
}

fn report_path(profile: &super::super::profile::Profile) -> Result<PathBuf, &'static str> {
    let valid_run_id = profile.run_id.len() == 32
        && profile
            .run_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if profile.output.file_name().and_then(|name| name.to_str()) != Some("native-report.json")
        || !valid_run_id
        || profile.identifier != format!("dev.atools.renderer-settings-input.{}", profile.run_id)
    {
        return Err(schema::REPORT_WRITE_FAILED);
    }
    Ok(report_parent(profile)?.join("native-disabled-commands-report.json"))
}

fn report_parent(profile: &super::super::profile::Profile) -> Result<PathBuf, &'static str> {
    let parent = profile.output.parent().ok_or(schema::REPORT_WRITE_FAILED)?;
    let expected_name = format!("run-{}", profile.run_id);
    if !parent.is_absolute()
        || parent.file_name().and_then(|name| name.to_str()) != Some(expected_name.as_str())
    {
        return Err(schema::REPORT_WRITE_FAILED);
    }
    let info = fs::symlink_metadata(parent).map_err(|_| schema::REPORT_WRITE_FAILED)?;
    if info.file_type().is_symlink() || !info.is_dir() {
        return Err(schema::REPORT_WRITE_FAILED);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if info.permissions().mode() & 0o777 != 0o700 {
            return Err(schema::REPORT_WRITE_FAILED);
        }
    }
    let canonical = fs::canonicalize(parent).map_err(|_| schema::REPORT_WRITE_FAILED)?;
    if canonical != parent {
        return Err(schema::REPORT_WRITE_FAILED);
    }
    Ok(parent.to_path_buf())
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|_| schema::REPORT_WRITE_FAILED)?;
    if !file
        .metadata()
        .map_err(|_| schema::REPORT_WRITE_FAILED)?
        .is_file()
    {
        return Err(schema::REPORT_WRITE_FAILED);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| schema::REPORT_WRITE_FAILED)?;
    }
    file.write_all(bytes)
        .map_err(|_| schema::REPORT_WRITE_FAILED)?;
    file.sync_all().map_err(|_| schema::REPORT_WRITE_FAILED)
}

#[cfg(test)]
mod tests {
    use super::{
        child_baseline_valid, main_baseline_valid, main_search_valid, menu_dispatched_valid,
        read_back_valid,
    };
    use serde_json::json;

    fn hidden() -> serde_json::Value {
        json!({"documentHidden": true, "documentHasFocus": false})
    }

    fn main(target_count: u64) -> serde_json::Value {
        let mut value = hidden();
        value["storeUnique"] = json!(true);
        value["storeReady"] = json!(true);
        value["searchCallable"] = json!(true);
        value["targetCount"] = json!(target_count);
        value["inputFound"] = json!(true);
        value["inputEmpty"] = json!(true);
        value
    }

    #[test]
    fn phase_criteria_require_original_hidden_views_and_real_menu_dispatch() {
        let child = json!({
            "routeAllCommands": true,
            "targetCount": 1,
            "openMenuCount": 0,
            "documentHidden": true,
            "documentHasFocus": false,
        });
        assert!(child_baseline_valid(&child));
        let mut disabled_child = child.clone();
        disabled_child["targetCount"] = json!(0);
        assert!(!child_baseline_valid(&disabled_child));

        let menu = json!({
            "routeAllCommands": true,
            "targetCount": 1,
            "menuOpened": true,
            "menuItemFound": true,
            "clickDispatched": true,
            "menuStateReflected": true,
            "alreadyDesired": false,
            "documentHidden": true,
            "documentHasFocus": false,
        });
        assert!(menu_dispatched_valid(&menu));
        let mut no_click = menu.clone();
        no_click["clickDispatched"] = json!(false);
        assert!(!menu_dispatched_valid(&no_click));
    }

    #[test]
    fn main_search_and_child_readback_criteria_check_both_states() {
        let enabled = main(2);
        let disabled = main(0);
        assert!(main_baseline_valid(&enabled));
        assert!(main_search_valid(&enabled, true));
        assert!(!main_search_valid(&disabled, true));
        assert!(main_search_valid(&disabled, false));
        assert!(!main_search_valid(&enabled, false));
        let mut unobserved = enabled.clone();
        unobserved["targetCount"] = json!(null);
        assert!(!main_search_valid(&unobserved, false));

        let child_disabled = json!({
            "routeAllCommands": true,
            "arrayValue": true,
            "readBack": true,
            "entryCount": 1,
            "documentHidden": true,
            "documentHasFocus": false,
        });
        assert!(read_back_valid(&child_disabled, true));
        let mut wrong_count = child_disabled.clone();
        wrong_count["entryCount"] = json!(0);
        assert!(!read_back_valid(&wrong_count, true));
    }
}
