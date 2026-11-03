//! Read-only evidence from the isolated fixture database; never executes plugin code.
use atools_core::{db::PluginDataQuery, models::Document, Database};
use serde_json::{json, Value};
#[path = "desktop_smoke_original_ascii_data.rs"]
mod ascii;
#[path = "desktop_smoke_deepread_data.rs"]
mod deepread;
#[path = "desktop_smoke_original_plain_data.rs"]
mod plain;
#[path = "desktop_smoke_random_data_data.rs"]
mod random_data;

fn case_plugin(profile: &Value) -> Result<&str, String> {
    let id = profile["id"]
        .as_str()
        .ok_or("Published profile missing id")?;
    let original_todo = id == "todo-neo" && profile["caseId"] == id;
    let converted_todo = id == "todo-neo"
        && profile["caseId"] == "converted-todo-neo-source"
        && profile["sourceKind"] == "converted_handoff_directory"
        && profile["dataAccess"] == true;
    let converted_deepread = id == "deepread"
        && profile["caseId"] == "converted-deepread-source"
        && profile["sourceKind"] == "converted_handoff_directory"
        && profile["dataAccess"] == true
        && profile["verifyDataPersistence"] == true;
    let color_helper = id == "color-helper" && profile["caseId"] == id;
    let random_data_case = random_data::registered(profile);
    if !ascii::registered(profile)
        && !plain::registered(profile)
        && !color_helper
        && !original_todo
        && !converted_todo
        && !converted_deepread
        && !random_data_case
    {
        return Err("No data evidence approved for this published fixture case".into());
    }
    Ok(id)
}

fn value(document: &Document) -> &Value {
    document
        .data
        .get("value")
        .filter(|value| value.is_object())
        .unwrap_or(&document.data)
}

pub(super) fn snapshot(db: &Database, profile: &Value) -> Result<Value, String> {
    let plugin = case_plugin(profile)?;
    if plugin == random_data::PLUGIN {
        return random_data::snapshot(db, profile);
    }
    if plugin == "deepread" {
        return deepread::snapshot(db, profile);
    }
    if plugin == plain::PLUGIN {
        return plain::snapshot(db, profile);
    }
    if plugin == ascii::PLUGIN {
        return ascii::snapshot(db, profile);
    }
    if plugin == "color-helper" {
        let document = db
            .plugin_data_get_bounded(plugin, "color/ff0000")
            .map_err(|e| e.to_string())?;
        let storage = db
            .plugin_storage_get(plugin, "collectsort")
            .map_err(|e| e.to_string())?;
        return Ok(
            json!({"pluginId":plugin,"documentId":"color/ff0000","document":document,
            "storage":{"key":"collectsort","value":storage},
            "source":"isolated SQLite plugin_data document store","readOnly":true}),
        );
    }
    let read = |prefix: &str| {
        db.plugin_data_all_bounded(plugin, &PluginDataQuery::Prefix(prefix.into()), Some(50))
            .map_err(|e| e.to_string())
    };
    let tasks = read("todo-tasks/")?.into_iter().map(|document| {
        let data = value(&document);
        json!({"id":document.id,"rev":document.rev,"text":data["text"],"groupId":data["groupId"],
            "completed":data["completed"],"createdAt":data["created_at"],"completedAt":data["completed_at"],
            "firstCompletedAt":data["first_completed_at"],"sort":data["sort"],"dueAt":data["dueAt"]})
    }).collect::<Vec<_>>();
    let groups = read("todo-group/")?.into_iter().map(|document| {
        let data = value(&document);
        json!({"id":document.id,"rev":document.rev,"title":data["title"],"sort":data["sort"],"createdAt":data["created_at"]})
    }).collect::<Vec<_>>();
    let storage = |key: &str| {
        db.plugin_storage_get(plugin, key)
            .map_err(|e| e.to_string())
    };
    Ok(
        json!({"pluginId":plugin,"tasks":tasks,"groups":groups,"settings":storage("todo-settings")?,
        "activeGroupId":storage("todo-active-group")?,"activeTaskId":storage("todo-active-task")?,
        "taskSortCounter":storage("mcp-next-task-sort")?,"groupSortCounter":storage("mcp-next-group-sort")?,
        "source":"isolated SQLite plugin_data document store","readOnly":true}),
    )
}

pub(super) fn audit(db: &Database, profile: &Value) -> Result<Value, String> {
    let plugin = case_plugin(profile)?;
    if plugin == random_data::PLUGIN {
        return random_data::audit(db, profile);
    }
    if plugin == "deepread" {
        return deepread::audit(db, profile);
    }
    if plugin == plain::PLUGIN {
        return plain::audit(db, profile);
    }
    let runs = db
        .list_task_runs(1000)
        .map_err(|_| "Unable to inspect isolated task history")?;
    let capability = crate::plugin_data_runtime::registry::tool_name(plugin);
    let selected = runs
        .iter()
        .filter(|run| run.capability_id == capability)
        .collect::<Vec<_>>();
    let methods = selected
        .iter()
        .filter_map(|run| run.input["method"].as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let markers: &[&str] = if plugin == ascii::PLUGIN {
        &[ascii::KEY, ascii::INPUT, ascii::REVERSE_INPUT]
    } else if plugin == "color-helper" {
        &[
            "ATools reviewed red",
            "#FF0000",
            "color/ff0000",
            "collectsort",
        ]
    } else {
        &[
            "ATools Todo synthetic alpha",
            "ATools Todo synthetic beta",
            "ATools synthetic group",
            "ATools renamed group",
            "todo-tasks/",
            "todo-group/",
            "todo-settings",
            "todo-active-group",
            "todo-active-task",
            "mcp-next-task-sort",
            "mcp-next-group-sort",
        ]
    };
    let mut private_markers_absent = true;
    for run in &runs {
        let text =
            serde_json::to_string(run).map_err(|_| "Unable to inspect isolated task record")?;
        if markers.iter().any(|marker| {
            text.contains(marker)
                || serde_json::to_string(marker)
                    .is_ok_and(|encoded| text.contains(&encoded[1..encoded.len() - 1]))
        }) || (text.contains("http://127.0.0.1")
            && (text.contains("/data/") || text.contains("/dialog/")))
        {
            private_markers_absent = false;
        }
    }
    Ok(
        json!({"count":selected.len(),"methods":methods,"allTerminal":selected.iter().all(|run|run.status.is_terminal()),
        "privateMarkersAbsent":private_markers_absent}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn plugin(db: &Database, id: &str) {
        db.save_plugin(&serde_json::from_value(json!({"id":id,"name":id,"version":"0.0.1","path":"/inert",
            "enabled":true,"manifest":{"name":id,"version":"0.0.1"},"created_at":"now","updated_at":"now"})).unwrap()).unwrap();
    }
    #[test]
    fn todo_snapshot_unwraps_original_value_documents_and_reads_only_its_real_store() {
        let db = Database::in_memory().unwrap();
        for id in ["todo-neo", "other-plugin"] {
            plugin(&db, id);
            db.plugin_data_put(id,&Document {id:"todo-tasks/1".into(),rev:None,
                data:json!({"value":{"text":id,"groupId":"todo-group/pending","completed":false,"created_at":123,"sort":1}})}).unwrap();
            db.plugin_storage_set(
                id,
                "todo-settings",
                &json!({"hideCompleted":true,"privateOwner":id}),
            )
            .unwrap();
        }
        db.plugin_data_put(
            "todo-neo",
            &Document {
                id: "todo-group/pending".into(),
                rev: None,
                data: json!({"title":"待处理","sort":1}),
            },
        )
        .unwrap();
        db.plugin_storage_set(
            "todo-neo",
            "todo-active-group",
            &json!("todo-group/pending"),
        )
        .unwrap();
        let observed = snapshot(&db, &json!({"caseId":"todo-neo","id":"todo-neo"})).unwrap();
        assert_eq!(observed["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(observed["tasks"][0]["text"], "todo-neo");
        assert_eq!(observed["tasks"][0]["createdAt"], 123);
        assert!(observed["tasks"][0]["rev"]
            .as_str()
            .is_some_and(|value| !value.is_empty()));
        assert_eq!(observed["groups"][0]["title"], "待处理");
        assert_eq!(observed["settings"]["hideCompleted"], true);
        assert_eq!(observed["activeGroupId"], "todo-group/pending");
        assert!(!observed.to_string().contains("other-plugin"));
        assert_eq!(
            db.plugin_data_all_bounded("todo-neo", &PluginDataQuery::All, None)
                .unwrap()
                .len(),
            4
        );
        assert!(snapshot(&db, &json!({"caseId":"todo-neo","id":"other-plugin"})).is_err());
    }

    #[test]
    fn converted_todo_data_scope_requires_exact_case_plugin_and_directory_kind() {
        let converted = json!({"caseId":"converted-todo-neo-source","id":"todo-neo",
            "sourceKind":"converted_handoff_directory","dataAccess":true});
        assert_eq!(case_plugin(&converted).unwrap(), "todo-neo");
        for invalid in [
            json!({"caseId":"converted-todo-neo-source","id":"other-plugin",
                "sourceKind":"converted_handoff_directory","dataAccess":true}),
            json!({"caseId":"converted-todo-neo-source","id":"todo-neo",
                "sourceKind":"local_full_directory","dataAccess":true}),
            json!({"caseId":"converted-todo-neo-source","id":"todo-neo",
                "sourceKind":"converted_handoff_directory","dataAccess":false}),
            json!({"caseId":"other-case","id":"todo-neo",
                "sourceKind":"converted_handoff_directory","dataAccess":true}),
        ] {
            assert!(case_plugin(&invalid).is_err());
        }
    }
    #[test]
    fn todo_audit_detects_content_keys_and_bearers_without_exporting_them() {
        use atools_core::task_run::{TaskRun, TaskRunInitiator, TaskRunStatus};
        let db = Database::in_memory().unwrap();
        let profile = json!({"caseId":"todo-neo","id":"todo-neo"});
        let mut run = TaskRun::new(
            crate::plugin_data_runtime::registry::tool_name("todo-neo"),
            TaskRunInitiator::human(Some("atools-ui".into())),
            json!({"operation":"request","method":"db.get","invocationId":"ephemeral"}),
        );
        run.transition(TaskRunStatus::Running).unwrap();
        run.transition(TaskRunStatus::Succeeded).unwrap();
        db.upsert_task_run(&run).unwrap();
        assert_eq!(
            audit(&db, &profile).unwrap(),
            json!({"count":1,"methods":["db.get"],"allTerminal":true,"privateMarkersAbsent":true})
        );
        for secret in [
            "ATools Todo synthetic alpha edited",
            "todo-tasks/123",
            "todo-settings",
            "http://127.0.0.1:12345/data/0123456789abcdef",
        ] {
            run.output = json!({"private":secret});
            db.upsert_task_run(&run).unwrap();
            let observed = audit(&db, &profile).unwrap();
            assert_eq!(observed["privateMarkersAbsent"], false);
            assert!(!observed.to_string().contains(secret));
        }
    }
}
