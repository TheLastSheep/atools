//! A cached launcher identity cannot be rebound to a different installed plugin.
use crate::commands::FeatureAction;
use atools_core::task_run::{
    Artifact, ArtifactKind, TaskIssue, TaskRun, TaskRunInitiator, TaskRunStatus,
    TaskValidationStatus,
};
use atools_core::Database;
use serde_json::Value;
use std::time::Instant;
use tauri::AppHandle;
use tokio::sync::OwnedRwLockReadGuard;

const OWNER_CHANGED: &str = "FEATURE_OWNER_CHANGED: refresh the catalog and try again";

fn expected_owner(owner: Option<&str>) -> Result<Option<&str>, String> {
    if owner.is_some_and(|owner| {
        owner.is_empty()
            || owner.len() > 512
            || owner != owner.trim()
            || owner.chars().any(char::is_control)
    }) {
        return Err("Invalid expected plugin identity".into());
    }
    Ok(owner)
}

pub(crate) fn verify_owner(actual: &str, expected: Option<&str>) -> Result<(), String> {
    if expected_owner(expected)?.is_some_and(|expected| actual != expected) {
        return Err(OWNER_CHANGED.into());
    }
    Ok(())
}

pub(crate) fn resolve_checked(
    db: &Database,
    code: &str,
    payload: Option<Value>,
    expected: Option<&str>,
) -> Result<FeatureAction, String> {
    expected_owner(expected)?;
    let current = db.get_feature(code).map_err(|error| error.to_string())?;
    verify_owner(&current.plugin_id, expected)?;
    let action = crate::commands::activate_feature_inner(db, code, payload)?;
    verify_owner(&action.plugin_id, expected)?;
    // Other plugins can replace a globally unique code using their own gate.
    // Recheck before handing a descriptor to the side-effect/TaskRun-success branch.
    let current = db.get_feature(code).map_err(|error| error.to_string())?;
    verify_owner(&current.plugin_id, Some(&action.plugin_id))?;
    Ok(action)
}

pub(crate) async fn resolve(
    app: &AppHandle,
    db: &Database,
    code: &str,
    payload: Option<Value>,
    expected: Option<&str>,
) -> Result<(FeatureAction, OwnedRwLockReadGuard<()>), String> {
    resolve_with_gate(db, code, payload, expected, |owner| async move {
        crate::plugin_lifecycle::execution(app, &owner).await
    })
    .await
}

async fn resolve_with_gate<G, F: std::future::Future<Output = G>>(
    db: &Database,
    code: &str,
    payload: Option<Value>,
    expected: Option<&str>,
    acquire: impl FnOnce(String) -> F,
) -> Result<(FeatureAction, G), String> {
    let expected = expected_owner(expected)?;
    let observed = db.get_feature(code).map_err(|error| error.to_string())?;
    let owner = expected.unwrap_or(&observed.plugin_id).to_string();
    let execution = acquire(owner.clone()).await;
    // The owner is verified only after acquiring its execution snapshot gate.
    // Code-only callers keep their observed owner, rather than silently switching
    // to an owner whose gate this invocation never acquired.
    let action = resolve_checked(db, code, payload, Some(&owner))?;
    Ok((action, execution))
}

fn begin(
    db: &Database,
    code: &str,
    payload: &Option<Value>,
    expected: Option<&str>,
) -> Result<TaskRun, String> {
    let mut run = TaskRun::new(
        format!("plugin.feature.{code}"),
        TaskRunInitiator::human(Some("atools-ui".into())),
        serde_json::json!({"code":code,"payloadSummary":crate::feature_activation_audit::payload_summary(payload.as_ref()),"expectedPluginId":expected}),
    );
    run.transition(TaskRunStatus::Running)
        .map_err(|error| error.to_string())?;
    db.upsert_task_run(&run)
        .map_err(|error| error.to_string())?;
    Ok(run)
}

fn finish(
    db: &Database,
    code: &str,
    started: Instant,
    mut run: TaskRun,
    result: Result<FeatureAction, String>,
    ready: impl FnOnce(&FeatureAction),
) -> Result<FeatureAction, String> {
    run.metrics = serde_json::json!({"durationMs":started.elapsed().as_millis() as u64});
    match result {
        Ok(action) => {
            run.output = crate::feature_activation_audit::output(&action);
            run.summary = Some(format!(
                "Opened {} / {}",
                action.plugin_name, action.feature_code
            ));
            run.artifacts = vec![Artifact {
                id: format!("artifact-{}", atools_core::utils::generate_rev()),
                kind: ArtifactKind::Json,
                label: format!("{} activation result", action.plugin_name),
                media_type: Some("application/json".into()),
                uri: Some(format!("atools://task-runs/{}/output", run.id)),
                path: None,
                size_bytes: None,
                metadata: serde_json::json!({"pluginId":action.plugin_id,"featureCode":action.feature_code}),
            }];
            run.validation.status = TaskValidationStatus::Passed;
            run.validation.summary =
                Some("Plugin feature resolved through the shared local capability store".into());
            run.transition(TaskRunStatus::Succeeded)
                .map_err(|error| error.to_string())?;
            db.upsert_task_run(&run)
                .map_err(|error| error.to_string())?;
            ready(&action);
            Ok(action)
        }
        Err(error) => {
            run.summary = Some(format!("Failed to open plugin feature {code}"));
            run.errors
                .push(TaskIssue::error("activation_failed", error.clone()));
            run.validation.status = TaskValidationStatus::Failed;
            run.validation.summary = Some("Plugin feature activation failed".into());
            run.transition(TaskRunStatus::Failed)
                .map_err(|error| error.to_string())?;
            db.upsert_task_run(&run)
                .map_err(|error| error.to_string())?;
            Err(error)
        }
    }
}

pub(crate) async fn activate(
    app: &AppHandle,
    state: &crate::state::AppState,
    code: &str,
    payload: Option<Value>,
    expected: Option<&str>,
) -> Result<FeatureAction, String> {
    activate_inner(app, state, code, payload, expected, ContentMode::None).await
}

pub(crate) async fn activate_content(
    app: &AppHandle,
    state: &crate::state::AppState,
    code: &str,
    content: String,
    owner: &str,
) -> Result<FeatureAction, String> {
    activate_inner(
        app,
        state,
        code,
        Some(Value::String(content)),
        Some(owner),
        ContentMode::Text,
    )
    .await
}

#[derive(Clone, Copy)]
enum ContentMode {
    None,
    Text,
    Files,
    Image,
}
pub(crate) async fn activate_media(
    app: &AppHandle,
    state: &crate::state::AppState,
    code: &str,
    payload: Value,
    owner: &str,
    kind: &str,
) -> Result<FeatureAction, String> {
    let mode = match kind {
        "files" => ContentMode::Files,
        "img" => ContentMode::Image,
        _ => return Err("MEDIA_INPUT_INVALID: unknown content kind".into()),
    };
    activate_inner(app, state, code, Some(payload), Some(owner), mode).await
}

pub(crate) struct DetachedActionSnapshot {
    pub action: FeatureAction,
    pub plugin_version: String,
    pub code_revision: Option<String>,
}

pub(crate) async fn activate_detached(
    app: &AppHandle,
    state: &crate::state::AppState,
    code: &str,
    payload: Option<Value>,
    owner: &str,
    entry_type: Option<&str>,
) -> Result<DetachedActionSnapshot, String> {
    let mode = match entry_type {
        None => ContentMode::None,
        Some("regex" | "over") => ContentMode::Text,
        Some("files") => ContentMode::Files,
        Some("img") => ContentMode::Image,
        Some(_) => return Err("PLUGIN_HANDOFF_INPUT_INVALID: unsupported entry type".into()),
    };
    if matches!(mode, ContentMode::Text) && !payload.as_ref().is_some_and(Value::is_string) {
        return Err("PLUGIN_HANDOFF_INPUT_INVALID: text handoff requires string payload".into());
    }
    activate_inner_with_target(
        app,
        state,
        code,
        payload,
        Some(owner),
        mode,
        ActivationTarget::Detached,
        entry_type,
    )
    .await
    .and_then(|result| {
        Ok(DetachedActionSnapshot {
            action: result.action,
            plugin_version: result
                .plugin_version
                .ok_or_else(|| "Plugin version snapshot was not captured".to_string())?,
            code_revision: result.code_revision,
        })
    })
}

async fn validate_content(
    state: &crate::state::AppState,
    code: &str,
    action: &mut FeatureAction,
    mode: ContentMode,
) -> Result<(), String> {
    match mode {
        ContentMode::None => Ok(()),
        ContentMode::Text => crate::content_search::entry_type(
            &state.db,
            code,
            action.payload.as_str().unwrap_or(""),
            &action.plugin_id,
        )
        .map(|kind| {
            action.entry_type = Some(kind);
        }),
        ContentMode::Files | ContentMode::Image => {
            let db = state.db.clone();
            let code = code.to_string();
            let owner = action.plugin_id.clone();
            let payload = std::mem::take(&mut action.payload);
            let kind = if matches!(mode, ContentMode::Files) {
                "files"
            } else {
                "img"
            };
            let (payload, entry_type) = crate::launcher_media_work::blocking(move || {
                crate::launcher_media::validate_payload(&db, &code, payload, &owner, kind)
            })
            .await?;
            action.payload = payload;
            action.entry_type = Some(entry_type);
            Ok(())
        }
    }
}

async fn activate_inner(
    app: &AppHandle,
    state: &crate::state::AppState,
    code: &str,
    payload: Option<Value>,
    expected: Option<&str>,
    content_mode: ContentMode,
) -> Result<FeatureAction, String> {
    activate_inner_with_target(
        app,
        state,
        code,
        payload,
        expected,
        content_mode,
        ActivationTarget::Main,
        None,
    )
    .await
    .map(|result| result.action)
}

#[derive(Clone, Copy)]
enum ActivationTarget {
    Main,
    Detached,
}

struct ActivationResult {
    action: FeatureAction,
    plugin_version: Option<String>,
    code_revision: Option<String>,
}

async fn activate_inner_with_target(
    app: &AppHandle,
    state: &crate::state::AppState,
    code: &str,
    payload: Option<Value>,
    expected: Option<&str>,
    content_mode: ContentMode,
    target: ActivationTarget,
    expected_entry_type: Option<&str>,
) -> Result<ActivationResult, String> {
    let started = Instant::now();
    let run = begin(&state.db, code, &payload, expected)?;
    let resolved = resolve(app, &state.db, code, payload, expected).await;
    let mut plugin_version = None;
    let mut code_revision = None;
    let (result, _execution) = match resolved {
        Ok((mut action, execution)) => {
            let snapshot = if matches!(target, ActivationTarget::Detached) {
                state
                    .db
                    .get_plugin(&action.plugin_id)
                    .map_err(|error| error.to_string())
                    .and_then(|plugin| {
                        if !plugin.enabled || plugin.path != action.plugin_path {
                            return Err(
                                "FEATURE_OWNER_CHANGED: plugin changed during activation".into()
                            );
                        }
                        let revision =
                            crate::plugin_code_revision::current(&state.db, &action.plugin_id)?;
                        Ok((plugin.version, revision))
                    })
            } else {
                Ok((String::new(), None))
            };
            let validation = match snapshot {
                Ok((version, revision)) => {
                    if matches!(target, ActivationTarget::Detached) {
                        plugin_version = Some(version);
                        code_revision = revision;
                    }
                    validate_content(state, code, &mut action, content_mode)
                        .await
                        .and_then(|()| {
                            if expected_entry_type.is_some_and(|expected| {
                                action.entry_type != Some(expected)
                            }) {
                                return Err("PLUGIN_HANDOFF_INPUT_INVALID: entry type changed during activation".into());
                            }
                            if matches!(target, ActivationTarget::Detached) {
                                crate::plugin_detach_validation::check_handoff_budget(&action)?;
                            }
                            Ok(())
                        })
                }
                Err(error) => Err(error),
            };
            (validation.map(|()| action), Some(execution))
        }
        Err(error) => (Err(error), None),
    };
    finish(&state.db, code, started, run, result, |action| {
        if matches!(target, ActivationTarget::Main) {
            let _ = crate::window::expand_window(app, action.expand_height);
            *state.active_plugin.lock() = Some(action.plugin_id.clone());
        }
    })
    .map(|action| ActivationResult {
        action,
        plugin_version,
        code_revision,
    })
}

#[cfg(test)]
#[path = "feature_activation_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "feature_activation_audit_tests.rs"]
mod audit_tests;

#[cfg(test)]
#[path = "feature_activation_media_tests.rs"]
mod media_tests;
