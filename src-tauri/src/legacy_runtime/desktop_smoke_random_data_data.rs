//! Minimal read-only evidence for Random Data's scoped settings persistence.
use atools_core::{task_run::TaskRunStatus, Database};
use serde_json::{json, Value};

pub(super) const PLUGIN: &str = "random-data";
const CASE_ID: &str = "local-random-data-head";
const STORAGE_KEY: &str = "generator-settings";
const FEATURE_CODE: &str = "randomUuid";
const FIXTURE_COMMAND: &str = "ATools Random UUID Acceptance";
const MAX_SETTINGS_BYTES: usize = 16 * 1024;
const MAX_COMMANDS: usize = 32;
const MAX_COMMAND_BYTES: usize = 128;

struct RandomUuidSettings {
    enabled: bool,
    commands: Vec<String>,
}

fn bounded_settings(settings: &Value) -> Result<RandomUuidSettings, &'static str> {
    let encoded = serde_json::to_vec(settings).map_err(|_| "Invalid Random Data settings")?;
    if encoded.len() > MAX_SETTINGS_BYTES {
        return Err("Random Data settings exceed the snapshot budget");
    }
    let item = settings
        .as_object()
        .and_then(|root| root.get(FEATURE_CODE))
        .and_then(Value::as_object)
        .ok_or("Random UUID settings are missing or malformed")?;
    if item.len() != 2 || !item.contains_key("enabled") || !item.contains_key("commands") {
        return Err("Random UUID settings have unexpected fields");
    }
    let enabled = item
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or("Random UUID enabled flag is missing or malformed")?;
    let values = item
        .get("commands")
        .and_then(Value::as_array)
        .ok_or("Random UUID command list is missing or malformed")?;
    if values.len() > MAX_COMMANDS {
        return Err("Random UUID command list exceeds its item budget");
    }
    let mut commands = Vec::with_capacity(values.len());
    for value in values {
        let command = value.as_str().ok_or("Random UUID command is not text")?;
        if command.is_empty()
            || command.len() > MAX_COMMAND_BYTES
            || command.chars().any(char::is_control)
        {
            return Err("Random UUID command is outside the accepted shape");
        }
        commands.push(command.to_owned());
    }
    Ok(RandomUuidSettings { enabled, commands })
}

fn registered_profile(profile: &Value) -> Option<Value> {
    let registry: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/local-original-random-data-cases.json"
    ))
    .ok()?;
    let cases = registry["cases"].as_array()?;
    let mut matches = cases.iter().filter(|item| item["caseId"] == CASE_ID);
    let expected = matches.next()?;
    if matches.next().is_some()
        || expected["id"] != PLUGIN
        || expected["dataAccess"] != true
        || expected["verifyDataPersistence"] != true
        || expected["sourceKind"] != "local_full_directory"
        || expected["runtime"] != "web"
        || profile != expected
    {
        None
    } else {
        Some(expected.clone())
    }
}

pub(super) fn registered(profile: &Value) -> bool {
    registered_profile(profile).is_some()
}

pub(super) fn snapshot(db: &Database, profile: &Value) -> Result<Value, String> {
    registered_profile(profile).ok_or("No data snapshot approved for this Random Data fixture")?;
    let settings = db
        .plugin_storage_get(PLUGIN, STORAGE_KEY)
        .map_err(|_| "Unable to read isolated Random Data settings")?;
    let projected = bounded_settings(&settings)?;
    Ok(
        json!({"pluginId":PLUGIN,"readOnly":true,"source":"isolated SQLite plugin storage",
        "settingsPresent":true,"randomUuid":{"enabled":projected.enabled,"commands":projected.commands}}),
    )
}

pub(super) fn audit(db: &Database, profile: &Value) -> Result<Value, String> {
    registered_profile(profile).ok_or("No data audit approved for this Random Data fixture")?;
    let runs = db
        .list_task_runs(1000)
        .map_err(|_| "Unable to inspect isolated task history")?;
    let capability = crate::plugin_data_runtime::registry::tool_name(PLUGIN);
    let selected = runs
        .iter()
        .filter(|run| run.capability_id == capability)
        .collect::<Vec<_>>();
    let methods = selected
        .iter()
        .filter_map(|run| run.input["method"].as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let markers = [STORAGE_KEY, "__random_data_settings__", FIXTURE_COMMAND];
    let private_markers_absent = runs.iter().all(|run| {
        serde_json::to_string(run)
            .is_ok_and(|text| !markers.iter().any(|marker| text.contains(marker)))
    });
    Ok(json!({"count":selected.len(),"methods":methods,
        "allTerminal":selected.iter().all(|run|run.status.is_terminal()),
        "allSucceeded":selected.iter().all(|run|run.status == TaskRunStatus::Succeeded),
        "privateMarkersAbsent":private_markers_absent}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use atools_core::{
        models::Plugin,
        task_run::{TaskRun, TaskRunInitiator},
    };

    fn profile() -> Value {
        let registry: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/local-original-random-data-cases.json"
        ))
        .unwrap();
        registry["cases"][0].clone()
    }

    fn plugin(db: &Database) {
        db.save_plugin(
            &serde_json::from_value::<Plugin>(json!({"id":PLUGIN,"name":PLUGIN,"version":"1.2.0",
            "path":"/inert","enabled":true,"manifest":{"name":PLUGIN,"version":"1.2.0"},
            "created_at":"now","updated_at":"now"}))
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn snapshot_projects_only_bounded_random_uuid_settings_and_requires_explicit_enabled() {
        let db = Database::in_memory().unwrap();
        plugin(&db);
        db.plugin_storage_set(
            PLUGIN,
            STORAGE_KEY,
            &json!({"randomUuid":{"enabled":true,
            "commands":["uuid","guid",FIXTURE_COMMAND]},"otherSensitiveSetting":"not projected"}),
        )
        .unwrap();
        let value = snapshot(&db, &profile()).unwrap();
        assert_eq!(value["settingsPresent"], true);
        assert_eq!(value["randomUuid"]["enabled"], true);
        assert_eq!(
            value["randomUuid"]["commands"],
            json!(["uuid", "guid", FIXTURE_COMMAND])
        );
        assert!(!value.to_string().contains("otherSensitiveSetting"));
        let mut wrong = profile();
        wrong["id"] = json!("other");
        assert!(snapshot(&db, &wrong).is_err());
        for malformed in [
            json!({"randomUuid":{"commands":["uuid"]}}),
            json!({"randomUuid":{"enabled":"true","commands":["uuid"]}}),
            json!({"randomUuid":{"enabled":true,"commands":["uuid"],"other":"private"}}),
            json!({"randomUuid":{"enabled":true,"commands":"uuid"}}),
            json!({"randomUuid":{"enabled":true,"commands":["uuid",7]}}),
        ] {
            db.plugin_storage_set(PLUGIN, STORAGE_KEY, &malformed)
                .unwrap();
            assert!(snapshot(&db, &profile()).is_err());
        }
    }

    #[test]
    fn snapshot_rejects_oversized_command_lists_strings_and_settings() {
        let db = Database::in_memory().unwrap();
        plugin(&db);
        let mut cases = Vec::new();
        cases
            .push(json!({"randomUuid":{"enabled":true,"commands":vec!["uuid"; MAX_COMMANDS + 1]}}));
        cases.push(
            json!({"randomUuid":{"enabled":true,"commands":["x".repeat(MAX_COMMAND_BYTES + 1)]}}),
        );
        cases.push(json!({"randomUuid":{"enabled":true,"commands":["bad\ncommand"]}}));
        cases.push(json!({"randomUuid":{"enabled":true,"commands":["uuid"]},"other":"x".repeat(MAX_SETTINGS_BYTES)}));
        for malformed in cases {
            db.plugin_storage_set(PLUGIN, STORAGE_KEY, &malformed)
                .unwrap();
            assert!(snapshot(&db, &profile()).is_err());
        }
    }

    #[test]
    fn audit_reports_only_terminal_data_methods_and_detects_private_payload_markers() {
        let db = Database::in_memory().unwrap();
        plugin(&db);
        let mut run = TaskRun::new(
            crate::plugin_data_runtime::registry::tool_name(PLUGIN),
            TaskRunInitiator::human(Some("atools-ui".into())),
            json!({"operation":"request","method":"dbStorage.setItem","invocationId":"ephemeral"}),
        );
        run.transition(TaskRunStatus::Running).unwrap();
        run.transition(TaskRunStatus::Succeeded).unwrap();
        db.upsert_task_run(&run).unwrap();
        let clean = audit(&db, &profile()).unwrap();
        assert_eq!(clean["count"], 1);
        assert_eq!(clean["allTerminal"], true);
        assert_eq!(clean["allSucceeded"], true);
        assert_eq!(clean["methods"], json!(["dbStorage.setItem"]));
        assert_eq!(clean["privateMarkersAbsent"], true);
        run.output = json!({"private":FIXTURE_COMMAND});
        db.upsert_task_run(&run).unwrap();
        let leaked = audit(&db, &profile()).unwrap();
        assert_eq!(leaked["privateMarkersAbsent"], false);
        assert!(!leaked.to_string().contains(FIXTURE_COMMAND));
    }
}
