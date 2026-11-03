//! Shared native launch, audit and successful-history coordination.
use crate::{
    app_launch_fence::AppLaunchGrant,
    launcher_app_catalog_source::LauncherAppCatalogSource,
    renderer_app_state::{
        self, classify_open_result, coordinate_launch, emit_launch_success, now_ms,
    },
};
use atools_core::db::{
    Database, RendererAppIdentity, RendererAppStateMutation, RendererAppStateSnapshot,
    RendererDirectSubtype,
};
use std::sync::Arc;
use tauri::AppHandle;

pub(crate) async fn launch_main_app(
    app: AppHandle,
    db: Arc<Database>,
    target: RendererAppIdentity,
) -> Result<RendererAppStateSnapshot, String> {
    launch(app, db, target, None).await
}

/// The detached owned task preserves the lease even if the caller stops waiting.
pub(crate) async fn launch_bound_app(
    app: AppHandle,
    db: Arc<Database>,
    catalog: Arc<LauncherAppCatalogSource>,
    target: RendererAppIdentity,
    grant: AppLaunchGrant,
) -> Result<RendererAppStateSnapshot, String> {
    if target.sub_type != RendererDirectSubtype::App || target.path != grant.path() {
        return Err("Invalid bound application target".into());
    }
    renderer_app_state::validate_identity(&target)?;
    let task = tauri::async_runtime::spawn(async move {
        let _lease = grant.lease();
        if !renderer_app_state::catalog_contains_identity(catalog, &target).await? {
            return Err("Application is not in the native launcher catalog".into());
        }
        launch(app, db, target, Some(grant)).await
    });
    task.await
        .map_err(|e| format!("App launch task failed: {e}"))?
}

async fn launch(
    app: AppHandle,
    db: Arc<Database>,
    target: RendererAppIdentity,
    grant: Option<AppLaunchGrant>,
) -> Result<RendererAppStateSnapshot, String> {
    let effect_started = grant.as_ref().map(AppLaunchGrant::effect_started);
    let audit_db = Arc::clone(&db);
    let task_app = app.clone();
    let success_app = app.clone();
    let launch_target = target.clone();
    coordinate_launch(
        || async move {
            let result = match grant {
                Some(grant) => {
                    crate::agent_tools::call_guarded_app_launch(&task_app, &audit_db, grant).await
                }
                None => {
                    crate::agent_tools::call_tool_with_audit(
                        &task_app,
                        &audit_db,
                        "atools-ui",
                        "open_or_reveal_path",
                        serde_json::json!({"path": launch_target.path, "reveal": false}),
                        true,
                    )
                    .await
                }
            };
            classify_open_result(
                result.is_error,
                result
                    .structured_content
                    .get("status")
                    .and_then(serde_json::Value::as_str),
                result
                    .structured_content
                    .get("error")
                    .and_then(serde_json::Value::as_str),
            )
        },
        || async move {
            let mutation = RendererAppStateMutation::RecordLaunch {
                app: target,
                now_ms: now_ms(),
            };
            tauri::async_runtime::spawn_blocking(move || db.apply_renderer_app_state(mutation))
                .await
                .map_err(|_| ())?
                .map_err(|_| ())
        },
        move |snapshot| emit_launch_success(&success_app, snapshot),
    )
    .await
    .map_err(|error| {
        if effect_started
            .as_ref()
            .is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Acquire))
        {
            "应用启动操作已触发，但执行或记录未完成；请勿自动重试".to_owned()
        } else {
            error.message().into()
        }
    })
}
