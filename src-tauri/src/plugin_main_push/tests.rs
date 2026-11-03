use super::{candidates, dto::*, registry, store::Runtime};
use atools_core::{Database, Plugin};
use serde_json::json;

pub(super) fn plugin(id: &str) -> Plugin {
    serde_json::from_value(json!({"id":id,"name":id,"version":"1","path":"/inert","enabled":true,
        "created_at":"now","updated_at":"now","manifest":{"name":id,"main":"index.html","features":[
        {"code":"dynamic","label":"发现标题仅用于展示","explain":"说明","mainPush":true,"cmds":["keyword",{"type":"regex","match":"/^\\d+$/"},{"type":"over","minLength":4,"maxLength":8,"exclude":"/^skip/"}]},
        {"code":"ordinary","cmds":["keyword"]}]}})).unwrap()
}
pub(super) fn setup() -> (Database, Plugin, tempfile::TempDir) {
    let db = Database::in_memory().unwrap();
    let mut plugin = plugin(&format!("fixture-{}", uuid::Uuid::new_v4()));
    let root = tempfile::tempdir().unwrap();
    plugin.path = root.path().to_string_lossy().into();
    std::fs::write(
        root.path().join("plugin.json"),
        serde_json::to_vec(&plugin.manifest).unwrap(),
    )
    .unwrap();
    db.save_plugin_with_features(&plugin, &plugin.manifest.features)
        .unwrap();
    (db, plugin, root)
}
pub(super) fn request(operation: Operation) -> Request {
    Request {
        request_id: uuid::Uuid::new_v4().to_string(),
        runner_id: uuid::Uuid::new_v4().to_string(),
        identity: Identity {
            plugin_id: "fixture".into(),
            feature_code: "dynamic".into(),
            command_type: CommandType::Over,
            code_revision: "a".repeat(64),
        },
        operation,
        input_bytes: if operation == Operation::Prepare {
            0
        } else {
            7
        },
        query_generation: 1,
    }
}
pub(super) fn receipt(request: &Request, ticket: &str, outcome: Outcome) -> Receipt {
    Receipt {
        ticket: ticket.into(),
        request_id: request.request_id.clone(),
        outcome,
        row_count: 0,
        duration_ms: 1,
    }
}

mod admission_tests;
mod candidate_tests;
mod deadline_tests;
mod runtime_tests;
