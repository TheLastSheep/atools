//! Read-only projection for one registered original plugin in the isolated fixture database.
use atools_core::Database;
use serde_json::{json, Value};

pub(super) const PLUGIN: &str = "ascii-tree";
pub(super) const KEY: &str = "ascii-tree:level-text";
pub(super) const INPUT: &str = "root\n=src\n==index.js";
pub(super) const REVERSE_INPUT: &str = "root\n=docs\n==README.md";

pub(super) fn registered(profile: &Value) -> bool {
    profile["caseId"] == "local-ascii-tree"
        && profile["id"] == PLUGIN
        && profile["runtime"] == "node"
        && profile["dataAccess"] == true
        && profile["verifyDataPersistence"] == true
}

pub(super) fn snapshot(db: &Database, profile: &Value) -> Result<Value, String> {
    if !registered(profile) {
        return Err("No reviewed original ASCII Tree data evidence for this profile".into());
    }
    let value = db
        .plugin_storage_get(PLUGIN, KEY)
        .map_err(|error| error.to_string())?;
    Ok(
        json!({"pluginId":PLUGIN,"storage":{"key":KEY,"value":value},"readOnly":true,
        "source":"actual isolated SQLite plugin_data document store"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ascii_snapshot_reads_only_the_registered_plugin_and_never_writes() {
        let db = Database::in_memory().unwrap();
        for id in [PLUGIN, "other-plugin"] {
            db.save_plugin(&serde_json::from_value(json!({"id":id,"name":id,"version":"1.0.0","path":"/inert",
                "enabled":true,"manifest":{"name":id,"version":"1.0.0"},"created_at":"now","updated_at":"now"})).unwrap()).unwrap();
            db.plugin_storage_set(id, KEY, &json!(id)).unwrap();
        }
        let profile = json!({"caseId":"local-ascii-tree","id":PLUGIN,"runtime":"node","dataAccess":true,"verifyDataPersistence":true});
        let observed = snapshot(&db, &profile).unwrap();
        assert_eq!(observed["storage"]["value"], PLUGIN);
        assert_eq!(db.plugin_storage_get(PLUGIN, KEY).unwrap(), json!(PLUGIN));
        assert_eq!(
            db.plugin_storage_get("other-plugin", KEY).unwrap(),
            json!("other-plugin")
        );
        assert!(!observed.to_string().contains("other-plugin"));
        for (field, value) in [
            ("caseId", json!("other")),
            ("id", json!("other-plugin")),
            ("runtime", json!("web")),
            ("dataAccess", json!(false)),
            ("verifyDataPersistence", json!(false)),
        ] {
            let mut changed = profile.clone();
            changed[field] = value;
            assert!(snapshot(&db, &changed).is_err());
        }
    }
    #[test]
    fn ascii_audit_detects_the_fixed_input_key_and_reverse_text_without_exporting_them() {
        use atools_core::task_run::{TaskRun, TaskRunInitiator, TaskRunStatus};
        let db = Database::in_memory().unwrap();
        let profile = json!({"caseId":"local-ascii-tree","id":PLUGIN,"runtime":"node","dataAccess":true,"verifyDataPersistence":true});
        let mut run = TaskRun::new(
            crate::plugin_data_runtime::registry::tool_name(PLUGIN),
            TaskRunInitiator::human(Some("atools-ui".into())),
            json!({"method":"dbStorage.setItem"}),
        );
        run.transition(TaskRunStatus::Running).unwrap();
        run.transition(TaskRunStatus::Succeeded).unwrap();
        db.upsert_task_run(&run).unwrap();
        assert_eq!(
            super::super::audit(&db, &profile).unwrap()["privateMarkersAbsent"],
            true
        );
        for marker in [
            KEY,
            INPUT,
            REVERSE_INPUT,
            "http://127.0.0.1:12345/data/private",
        ] {
            run.output = json!({"unexpected":marker});
            db.upsert_task_run(&run).unwrap();
            let observed = super::super::audit(&db, &profile).unwrap();
            assert_eq!(observed["privateMarkersAbsent"], false);
            assert!(!observed.to_string().contains(marker));
        }
    }
}
