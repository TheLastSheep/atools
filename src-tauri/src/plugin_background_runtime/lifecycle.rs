//! Exact-owner teardown, cancellation, TTL expiry, and TaskRun reconciliation.
use super::{
    dto::{Operation, Request},
    manager,
    registry::{self, Access},
    store::{Admission, Intent},
};
use atools_core::{
    db::Database,
    task_run::{TaskRun, TaskRunStatus},
};
use std::{collections::BTreeMap, sync::Arc};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy, Default)]
struct CleanupScope<'a> {
    window: Option<&'a str>,
    plugin: Option<&'a str>,
    session: Option<&'a str>,
}

fn owner(session_id: &str) -> String {
    format!("window:main:{session_id}")
}

fn cancel_task_run(app: &AppHandle, run_id: Option<String>) {
    if let Some(run_id) = run_id {
        let _ = crate::agent_tools::cancel_task_run_by_id(app, &run_id);
    }
}

fn emit_invalidated(app: &AppHandle, plugin_id: Option<&str>) {
    if app.get_webview_window("main").is_some() {
        let _ = app.emit_to(
            "main",
            "plugin-background-invalidated",
            serde_json::json!({"pluginId":plugin_id}),
        );
    }
}

async fn close_exact_owner(
    app: &AppHandle,
    db: &Database,
    session_id: &str,
    plugin_id: &str,
) -> Result<(), String> {
    crate::legacy_runtime::close_plugin_owner(app, db, &owner(session_id), plugin_id).await
}

pub(super) fn close_intent(app: &AppHandle, db: &Database, intent: &Arc<Intent>, cancel: bool) {
    let run_id = intent.run_id();
    let request = intent.request.clone();
    let (admissions, intents) = if let Ok(runtime) = manager(app) {
        runtime.remember_closing(&intent.window, &request);
        let (admission, intents) = runtime.close_session(&intent.window, &request.session_id);
        (admission.into_iter().collect(), intents)
    } else {
        intent.close();
        (Vec::new(), Vec::new())
    };
    if cancel {
        cancel_task_run(app, run_id.clone());
    }
    let app = app.clone();
    let db = db.clone();
    tauri::async_runtime::spawn(async move {
        let result = close_sessions(
            &app,
            &db,
            admissions,
            intents,
            false,
            CleanupScope {
                window: Some("main"),
                plugin: Some(&request.plugin_id),
                session: Some(&request.session_id),
            },
        )
        .await;
        if let Err(error) = result {
            tracing::error!(plugin_id = %request.plugin_id, session_id = %request.session_id, run_id = ?run_id, %error,
                "Background plugin owner did not close cleanly");
        }
    });
}

pub(super) fn cancel_request(app: &AppHandle, db: &Database, request_id: &str) {
    let Ok(runtime) = manager(app) else {
        return;
    };
    let Ok(intent) = runtime.intent(request_id) else {
        return;
    };
    close_intent(app, db, &intent, true);
}

pub(super) fn cancel_run(app: &AppHandle, db: &Database, run_id: &str) {
    let Ok(runtime) = manager(app) else {
        return;
    };
    let intent = runtime
        .0
        .lock()
        .intents
        .values()
        .find(|intent| intent.run_id().as_deref() == Some(run_id))
        .cloned();
    if let Some(intent) = intent {
        close_intent(app, db, &intent, false);
    }
}

pub(super) async fn expire_after(app: AppHandle, db: Database, intent: Arc<Intent>) {
    if intent.wait_until_expired().await {
        close_intent(&app, &db, &intent, true);
    }
}

async fn close_sessions(
    app: &AppHandle,
    db: &Database,
    admissions: Vec<Admission>,
    intents: Vec<Arc<Intent>>,
    cancel_pending: bool,
    scope: CleanupScope<'_>,
) -> Result<(), String> {
    let mut owners = BTreeMap::<String, String>::new();
    for admission in admissions {
        owners.insert(
            admission.request.session_id.clone(),
            admission.request.plugin_id.clone(),
        );
    }
    for intent in &intents {
        owners.insert(
            intent.request.session_id.clone(),
            intent.request.plugin_id.clone(),
        );
        if cancel_pending {
            cancel_task_run(app, intent.run_id());
        }
    }
    if let Ok(runtime) = manager(app) {
        for (_, request) in runtime.closing_entries(scope.window, scope.plugin, scope.session) {
            owners.insert(request.session_id.clone(), request.plugin_id.clone());
        }
    }

    let mut first_error = None;
    for (session_id, plugin_id) in owners {
        emit_invalidated(app, Some(&plugin_id));
        match close_exact_owner(app, db, &session_id, &plugin_id).await {
            Ok(()) => {
                if let Ok(runtime) = manager(app) {
                    runtime.forget_closing("main", &session_id);
                }
            }
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    first_error.map_or(Ok(()), Err)
}

pub(super) async fn close_session(
    app: &AppHandle,
    db: &Database,
    window: &str,
    session_id: &str,
    cancel_pending: bool,
) -> Result<(), String> {
    let (admission, intents) = manager(app)?.close_session(window, session_id);
    close_sessions(
        app,
        db,
        admission.into_iter().collect(),
        intents,
        cancel_pending,
        CleanupScope {
            window: Some(window),
            session: Some(session_id),
            ..CleanupScope::default()
        },
    )
    .await
}

pub(super) async fn close_window(app: &AppHandle, window: &str) {
    let (admissions, intents) = match manager(app) {
        Ok(runtime) => runtime.close_window(window),
        Err(_) => return,
    };
    let db = app.state::<crate::state::AppState>().db.clone();
    if let Err(error) = close_sessions(
        app,
        &db,
        admissions,
        intents,
        true,
        CleanupScope {
            window: Some(window),
            ..CleanupScope::default()
        },
    )
    .await
    {
        tracing::error!(window, %error, "Background plugin window teardown was incomplete");
    }
}

pub(super) async fn invalidate(
    app: &AppHandle,
    db: &Database,
    plugin: Option<&str>,
) -> Result<(), String> {
    let (admissions, intents) = manager(app)?.close_plugin(plugin);
    close_sessions(
        app,
        db,
        admissions,
        intents,
        true,
        CleanupScope {
            plugin,
            ..CleanupScope::default()
        },
    )
    .await
}

pub(super) async fn stop(app: &AppHandle) -> Result<(), String> {
    let (admissions, intents) = manager(app)?.stop();
    let db = app.state::<crate::state::AppState>().db.clone();
    close_sessions(app, &db, admissions, intents, true, CleanupScope::default()).await
}

pub(super) async fn finalize_task_run(app: &AppHandle, db: &Database, run_id: &str) {
    let Ok(Some(run)) = db.get_task_run(run_id) else {
        return;
    };
    if run.initiator.client_id.as_deref() != Some("atools-ui") {
        return;
    }
    let Ok(request) = Request::parse(&run.input) else {
        return;
    };
    let access = match request.operation {
        Operation::Start => Access::Start,
        Operation::Stop => Access::Stop,
    };
    if run.capability_id != registry::tool_name(&request.plugin_id, access)
        || run.status == TaskRunStatus::AwaitingPermission
    {
        return;
    }

    if run.status == TaskRunStatus::Succeeded && successful_admission(app, &run, &request) {
        return;
    }
    if let Err(error) = close_session(
        app,
        db,
        "main",
        &request.session_id,
        !run.status.is_terminal(),
    )
    .await
    {
        tracing::error!(
            run_id,
            plugin_id = %request.plugin_id,
            session_id = %request.session_id,
            %error,
            "Failed to clean up background owner after TaskRun ended"
        );
    }
}

pub(super) fn successful_admission(app: &AppHandle, run: &TaskRun, request: &Request) -> bool {
    let Ok(runtime) = manager(app) else {
        return false;
    };
    let admission = runtime.admission("main", &request.session_id);
    if request.operation == Operation::Stop {
        return admission.is_err() && output_matches(run, request, "closed");
    }
    let Ok(admission) = admission else {
        return false;
    };
    admission.run_id == run.id
        && admission.request == *request
        && output_matches(run, request, "ready")
}

fn output_matches(run: &TaskRun, request: &Request, outcome: &str) -> bool {
    run.output
        .get("runtime")
        .and_then(serde_json::Value::as_str)
        == Some("plugin-background")
        && run
            .output
            .get("operation")
            .and_then(serde_json::Value::as_str)
            == Some(request.operation.as_str())
        && run
            .output
            .get("outcome")
            .and_then(serde_json::Value::as_str)
            == Some(outcome)
        && run
            .output
            .get("sessionId")
            .and_then(serde_json::Value::as_str)
            == Some(request.session_id.as_str())
        && run
            .output
            .get("pluginId")
            .and_then(serde_json::Value::as_str)
            == Some(request.plugin_id.as_str())
        && run
            .output
            .get("codeRevision")
            .and_then(serde_json::Value::as_str)
            == Some(request.code_revision.as_str())
}
