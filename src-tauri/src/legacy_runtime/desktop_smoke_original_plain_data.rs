//! Narrow read-only UTF-16 Web Storage projection for the original plain-text fixture.
use atools_core::Database;
use serde_json::{json, Value};

pub(super) const PLUGIN: &str = "plain-text";
const NOTES_KEY: &str = "plain-text-notes";
const ACTIVE_KEY: &str = "plain-text-active";
const ALPHA: &str = "ATools plain alpha document line 1234567890\nAlpha fixed body\nSecond line.";
const BETA: &str = "# ATools markdown beta document\n\n- first\n- second";

pub(super) fn registered(profile: &Value) -> bool {
    profile["caseId"] == "local-plain-text"
        && profile["id"] == PLUGIN
        && profile["version"] == "1.0.2"
        && profile["runtime"] == "node"
        && profile["dataAccess"] == true
        && profile["verifyDataPersistence"] == true
        && profile["pathAccess"] == "standard"
        && profile["sourceKind"] == "local_full_directory"
        && profile["directorySha256"]
            == "cac445cf31c918e213dcc0d1dde206e5bcc3514957c46088307e88e48601fda2"
}
fn read(db: &Database, key: &str) -> Result<Option<String>, String> {
    let units = db
        .plugin_web_storage_get(PLUGIN, &key.encode_utf16().collect::<Vec<_>>())
        .map_err(|_| "Unable to read fixed original plain-text Web Storage key")?;
    units
        .map(|units| {
            String::from_utf16(&units).map_err(|_| "Invalid UTF-16 in plain-text fixture".into())
        })
        .transpose()
}
fn bounded<'a>(value: &'a Value, field: &str, limit: usize) -> Result<&'a str, String> {
    value[field]
        .as_str()
        .filter(|text| text.len() <= limit)
        .ok_or_else(|| format!("Invalid bounded plain-text {field}"))
}

pub(super) fn snapshot(db: &Database, profile: &Value) -> Result<Value, String> {
    if !registered(profile) {
        return Err("No reviewed original plain-text data evidence for this profile".into());
    }
    let raw = read(db, NOTES_KEY)?.unwrap_or_else(|| "[]".into());
    if raw.len() > 16 * 1024 {
        return Err("Original plain-text fixture exceeds projection budget".into());
    }
    let notes: Value =
        serde_json::from_str(&raw).map_err(|_| "Invalid original plain-text notes JSON")?;
    let notes = notes
        .as_array()
        .filter(|notes| notes.len() <= 2)
        .ok_or("Invalid original plain-text note count")?;
    let projected = notes
        .iter()
        .map(|note| {
            let mode = bounded(note, "mode", 16)?;
            if !matches!(mode, "text" | "markdown") {
                return Err("Invalid original plain-text mode".into());
            }
            Ok(
                json!({"id":bounded(note,"id",128)?,"title":bounded(note,"title",80)?,
            "content":bounded(note,"content",4096)?,"mode":mode}),
            )
        })
        .collect::<Result<Vec<Value>, String>>()?;
    let active = read(db, ACTIVE_KEY)?;
    if active.as_ref().is_some_and(|active| active.len() > 128) {
        return Err("Invalid original plain-text active ID".into());
    }
    Ok(
        json!({"pluginId":PLUGIN,"notes":projected,"activeId":active,"readOnly":true,
        "storageKind":"webStorage","source":"actual isolated SQLite plugin_web_storage UTF-16 values"}),
    )
}

pub(super) fn audit(db: &Database, profile: &Value) -> Result<Value, String> {
    if !registered(profile) {
        return Err("No reviewed original plain-text audit for this profile".into());
    }
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
    let markers = [
        NOTES_KEY,
        ACTIVE_KEY,
        ALPHA,
        BETA,
        "ATools plain alpha d",
        "# ATools markdown be",
    ];
    let private_markers_absent = runs.iter().all(|run| {
        let Ok(text) = serde_json::to_string(run) else {
            return false;
        };
        !markers.iter().any(|marker| {
            text.contains(marker)
                || serde_json::to_string(marker)
                    .is_ok_and(|encoded| text.contains(&encoded[1..encoded.len() - 1]))
        }) && !(text.contains("http://127.0.0.1")
            && ["/data/", "/dialog/", "/path/"]
                .iter()
                .any(|part| text.contains(part)))
    });
    Ok(
        json!({"count":selected.len(),"methods":methods,"allTerminal":selected.iter().all(|run|run.status.is_terminal()),
        "privateMarkersAbsent":private_markers_absent}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile() -> Value {
        serde_json::from_str::<Value>(include_str!(
            "../../../tests/fixtures/local-plain-text-cases.json"
        ))
        .unwrap()["cases"][0]
            .clone()
    }
    fn put(db: &Database, id: &str, key: &str, value: &str) {
        db.plugin_web_storage_set(
            id,
            &key.encode_utf16().collect::<Vec<_>>(),
            &value.encode_utf16().collect::<Vec<_>>(),
        )
        .unwrap();
    }
    fn database() -> Database {
        let db = Database::in_memory().unwrap();
        for id in [PLUGIN, "other-plugin"] {
            db.save_plugin(&serde_json::from_value(json!({"id":id,"name":id,"version":"1.0.2","path":"/inert",
                "enabled":true,"manifest":{"name":id,"version":"1.0.2"},"created_at":"now","updated_at":"now"})).unwrap()).unwrap();
        }
        db
    }
    #[test]
    fn plain_projection_reads_only_two_fixed_web_storage_keys_and_returns_minimal_note_fields() {
        let db = database();
        let notes = json!([{"id":"alpha","title":"ATools plain alpha d","content":ALPHA,"mode":"text","updatedAt":123,"privateExtra":"excluded"},
            {"id":"beta","title":"# ATools markdown be","content":BETA,"mode":"markdown","updatedAt":456}]).to_string();
        put(&db, PLUGIN, NOTES_KEY, &notes);
        put(&db, PLUGIN, ACTIVE_KEY, "beta");
        put(&db, PLUGIN, "unrelated-private-key", "excluded");
        put(&db, "other-plugin", NOTES_KEY, "excluded");
        let value = snapshot(&db, &profile()).unwrap();
        assert_eq!(value["notes"].as_array().unwrap().len(), 2);
        assert_eq!(value["activeId"], "beta");
        assert_eq!(value["notes"][0]["content"], ALPHA);
        assert_eq!(value["notes"][1]["mode"], "markdown");
        assert!(value["notes"][0].get("updatedAt").is_none());
        assert!(!value.to_string().contains("excluded"));
        assert_eq!(read(&db, NOTES_KEY).unwrap().unwrap(), notes);
        let mut wrong = profile();
        wrong["pathAccess"] = json!("none");
        assert!(snapshot(&db, &wrong).is_err());
    }
    #[test]
    fn plain_projection_rejects_malformed_or_unbounded_state_without_writing() {
        let db = database();
        for value in [
            "not json",
            "{}",
            "[{}, {}, {}]",
            "[{\"id\":\"a\",\"title\":\"t\",\"content\":\"c\",\"mode\":\"other\"}]",
        ] {
            put(&db, PLUGIN, NOTES_KEY, value);
            assert!(snapshot(&db, &profile()).is_err());
            assert_eq!(read(&db, NOTES_KEY).unwrap().unwrap(), value);
        }
    }
    #[test]
    fn plain_audit_requires_real_web_storage_methods_and_detects_content_keys_or_bearer_leaks() {
        use atools_core::task_run::{TaskRun, TaskRunInitiator, TaskRunStatus};
        let db = Database::in_memory().unwrap();
        let mut run = TaskRun::new(
            crate::plugin_data_runtime::registry::tool_name(PLUGIN),
            TaskRunInitiator::human(Some("atools-ui".into())),
            json!({"method":"webStorage.setItem"}),
        );
        run.transition(TaskRunStatus::Running).unwrap();
        run.transition(TaskRunStatus::Succeeded).unwrap();
        db.upsert_task_run(&run).unwrap();
        assert_eq!(
            audit(&db, &profile()).unwrap()["methods"],
            json!(["webStorage.setItem"])
        );
        assert_eq!(
            audit(&db, &profile()).unwrap()["privateMarkersAbsent"],
            true
        );
        for marker in [
            NOTES_KEY,
            ACTIVE_KEY,
            ALPHA,
            BETA,
            "http://127.0.0.1:1234/data/bearer",
        ] {
            run.output = json!({"unexpected":marker});
            db.upsert_task_run(&run).unwrap();
            let observed = audit(&db, &profile()).unwrap();
            assert_eq!(observed["privateMarkersAbsent"], false);
            assert!(!observed.to_string().contains(marker));
        }
    }
}
