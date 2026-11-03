//! Content-free runtime counts and durable-result checks for the isolated smoke.
use atools_core::Database;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

pub(super) const PRIVATE_QUERY: &str = "atools-private-mainpush-query-7e561a";

pub(super) async fn snapshot(app: &AppHandle) -> Value {
    let legacy = app.state::<std::sync::Arc<crate::legacy_runtime::Sessions>>();
    let state = app.state::<crate::state::AppState>();
    let (sessions, openings, intents, invocations) = (
        legacy.sessions.read().len(),
        legacy.openings.lock().len(),
        legacy.intents.lock().len(),
        legacy.invocations.lock().len(),
    );
    let pending = state.pending_agent_requests.lock().len();
    let transport = legacy.server.lock().await.is_some();
    let paths = crate::plugin_system_paths::runtime_state(app);
    let data = crate::plugin_data_runtime::runtime_state(app).await;
    let dialogs = crate::plugin_dialog_runtime::runtime_state(app).await;
    let mut result = json!({
        "mainPush": crate::plugin_main_push::runtime_state(app),
        "legacySessions": sessions,
        "legacyOpenings": openings,
        "legacyIntents": intents,
        "legacyInvocations": invocations,
        "pendingRequests": pending,
        "resourceLeases": crate::plugin_asset_protocol::lease_count(app),
        "resources": crate::plugin_asset_protocol::runtime_state(app),
        "legacyTransport": transport,
        "paths": paths,
        "data": data,
        "dialogs": dialogs,
    });
    if let Ok(host) = crate::host_runtime::manager(app) {
        let (sessions, intents, invocations) = {
            let store = host.store.lock();
            (
                store.sessions.len(),
                store.intents.len(),
                store.invocations.len(),
            )
        };
        result["host"] = json!({"sessions":sessions,"intents":intents,
            "invocations":invocations,"transport":host.server.lock().await.is_some()});
    }
    result["drained"] = json!(drained(&result));
    result
}

pub(super) fn drained(state: &Value) -> bool {
    let zero = |owner: &Value, keys: &[&str]| keys.iter().all(|k| owner[k].as_u64() == Some(0));
    state["mainPush"]["available"] == true
        && zero(
            &state["mainPush"],
            &["intents", "admissions", "running", "waiting"],
        )
        && zero(
            state,
            &[
                "legacySessions",
                "legacyOpenings",
                "legacyIntents",
                "legacyInvocations",
                "pendingRequests",
                "resourceLeases",
            ],
        )
        && state["legacyTransport"] == false
        && state["resources"]["available"] == true
        && zero(
            &state["resources"],
            &["leases", "preparations", "activeReads", "pendingRequests"],
        )
        && zero(&state["host"], &["sessions", "intents", "invocations"])
        && state["host"]["transport"] == false
        && zero(
            &state["paths"],
            &[
                "activePathSnapshots",
                "activePathIntents",
                "activePathPreparations",
                "pathSnapshotBytes",
            ],
        )
        && state["paths"]["pathRuntimeAvailable"] == true
        && zero(
            &state["data"],
            &[
                "dataSessions",
                "dataIntents",
                "dataInvocations",
                "dataPreparations",
                "webStorageEvents",
                "webStorageEventBytes",
            ],
        )
        && state["data"]["dataTransport"] == false
        && zero(
            &state["dialogs"],
            &[
                "dialogSessions",
                "dialogIntents",
                "dialogInvocations",
                "dialogPreparations",
                "nativeDialogs",
            ],
        )
        && state["dialogs"]["dialogTransport"] == false
}

pub(super) async fn shutdown(app: &AppHandle, db: &Database) -> Value {
    eprintln!("[main-push-smoke] shutdown-main-push");
    crate::plugin_main_push::invalidate(app, db, None);
    crate::plugin_main_push::close_window(app, "main");
    crate::plugin_asset_protocol::close_window(app, "main");
    eprintln!("[main-push-smoke] shutdown-dialogs");
    crate::plugin_dialog_runtime::stop(app).await;
    eprintln!("[main-push-smoke] shutdown-paths");
    crate::plugin_system_paths::stop(app);
    eprintln!("[main-push-smoke] shutdown-data");
    crate::plugin_data_runtime::stop(app).await;
    eprintln!("[main-push-smoke] shutdown-node");
    app.state::<std::sync::Arc<crate::legacy_runtime::Sessions>>()
        .stop_all()
        .await;
    if let Ok(host) = crate::host_runtime::manager(app) {
        eprintln!("[main-push-smoke] shutdown-host");
        host.close(None, None, true).await;
    }
    eprintln!("[main-push-smoke] shutdown-snapshot");
    let mut state = snapshot(app).await;
    for _ in 0..40 {
        if drained(&state) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        state = snapshot(app).await;
    }
    state
}

pub(super) fn durable(db: &Database) -> Result<Value, String> {
    let runs = db.list_task_runs(1000).map_err(|e| e.to_string())?;
    let audits = db.list_audit_entries(1000).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_string(&runs).map_err(|e| e.to_string())?;
    let audit_bytes = serde_json::to_string(&audits).map_err(|e| e.to_string())?;
    let private = |bytes: &str| {
        [
            PRIVATE_QUERY,
            "main-push-private-option-4513c9",
            "fixture-needle",
            "https://atools-fixture.invalid/",
        ]
        .iter()
        .all(|sentinel| !bytes.contains(sentinel))
    };
    // Disabling a provider prunes its current tool row, not its historical runs.
    let main_push_names = ["calculation-paper", "bookmarks", "main-push-fixture"]
        .into_iter()
        .map(crate::plugin_main_push::registry::tool_name)
        .collect::<std::collections::HashSet<_>>();
    let main_push = runs
        .iter()
        .filter(|run| main_push_names.contains(run.capability_id.as_str()))
        .map(|run| json!({"status":run.status.as_str(),"input":run.input,"output":run.output}))
        .collect::<Vec<_>>();
    Ok(
        json!({"count":runs.len(),"allTerminal":runs.iter().all(|run|run.status.is_terminal()),
        "privateQueryAndBookmarkFieldsAbsent":private(&bytes),"mainPushRuns":main_push,
        "auditCount":audits.len(),"auditPrivateFieldsAbsent":private(&audit_bytes),
        "boundedInventoryComplete":runs.len()<1000 && audits.len()<1000}),
    )
}
