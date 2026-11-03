//! Only the original About page's three operations; no general updater/URL/path authority.
use super::{
    accounting::{RuntimeAccounting, RuntimeActivityGuard},
    session::SessionView,
    validation::*,
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Arc};
use tauri::{AppHandle, Manager};
pub(super) fn handles(operation: &str) -> bool {
    matches!(
        operation,
        "getAppVersion" | "checkAppUpdate" | "setAutoCheckUpdate"
    )
}
pub(super) async fn handle(
    app: AppHandle,
    session: SessionView,
    operation: String,
    payload: Value,
    permit: tokio::sync::OwnedSemaphorePermit,
    call: RuntimeActivityGuard,
    accounting: Arc<RuntimeAccounting>,
) -> Result<Value, BridgeError> {
    if operation == "getAppVersion" {
        require_empty_payload(&payload)?;
        ensure_still_active(&app, &session)?;
        let version = app.package_info().version.to_string();
        if version.is_empty() || version.len() > 128 {
            return Err(failed());
        }
        return Ok(json!({"appVersion":version}));
    }
    if operation == "checkAppUpdate" {
        require_empty_payload(&payload)?;
    } else {
        let o = exact_object(&payload, &["revision", "enabled"])?;
        string_field(o, "revision")?;
        if !o.get("enabled").is_some_and(Value::is_boolean) {
            return Err(invalid_payload());
        }
    }
    let manual_state = if operation == "checkAppUpdate" {
        Some(
            app.try_state::<crate::updater::UpdateCoordinator>()
                .ok_or_else(failed)?
                .inner()
                .clone(),
        )
    } else {
        None
    };
    // Before detach: a single typed App-wide owner, separate from the Child's 32 call permits.
    let manual = manual_state
        .as_ref()
        .map(|state| state.reserve_manual_request())
        .transpose()
        .map_err(map_update_error)?;
    let grant = super::runtime(&app)
        .map_err(|_| inactive_session())?
        .updater_grant(&session)
        .map_err(|_| inactive_session())?;
    let write = if operation == "setAutoCheckUpdate" {
        Some(accounting.track_write())
    } else {
        None
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    let work = async move {
        let _permit = permit;
        let _call = call;
        let _write = write;
        let result = async {
            if operation == "setAutoCheckUpdate" {
                let _gate = session.write_gate.lock().await;
                ensure_still_active(&app, &session)?;
                let changes =
                    BTreeMap::from([("autoCheckUpdate".to_owned(), payload["enabled"].clone())]);
                let result = session
                    .preferences
                    .patch(
                        app.clone(),
                        payload["revision"].as_str().unwrap().to_owned(),
                        changes,
                    )
                    .await
                    .map_err(map_preferences_error)?;
                ensure_still_active(&app, &session)?;
                return Ok(result);
            }
            crate::renderer_updater::initialize(&app).map_err(|_| failed())?;
            let state = manual_state.as_ref().ok_or_else(failed)?;
            // Fully committed, same-generation popup reuse bypasses the install-held Core gate.
            if let Some(snapshot) =
                crate::renderer_updater::reuse_from_settings(&app, grant.clone())
                    .await
                    .map_err(map_update_error)?
            {
                ensure_still_active(&app, &session)?;
                return check_reply(snapshot);
            }
            let snapshot =
                crate::updater::entry::check_about(&app, state, || grant.pending().is_ok())
                    .await
                    .map_err(map_update_error)?;
            ensure_still_active(&app, &session)?;
            if let Some(candidate) = &snapshot.candidate {
                crate::renderer_updater::show_from_settings(
                    &app,
                    grant,
                    candidate.candidate_id.clone(),
                )
                .await
                .map_err(map_update_error)?;
            }
            ensure_still_active(&app, &session)?;
            check_reply(snapshot)
        }
        .await;
        let _ = tx.send(result);
    };
    if let Some(owner) = manual {
        tauri::async_runtime::spawn(owner.hold(work));
    } else {
        tauri::async_runtime::spawn(work);
    }
    rx.await.map_err(|_| failed())?
}
fn map_update_error(error: crate::updater::UpdateCommandError) -> BridgeError {
    match error.code.as_str() {
        "busy" => BridgeError::new("SETTINGS_UPDATER_BUSY", "更新操作正在进行，请稍后重试"),
        "stale_candidate" => BridgeError::new("SETTINGS_UPDATER_STALE", "更新候选已变化，请重试"),
        "forbidden_window" => inactive_session(),
        _ => failed(),
    }
}
fn failed() -> BridgeError {
    BridgeError::new(
        "SETTINGS_UPDATER_CHECK_FAILED",
        "应用更新检查暂不可用，请重试",
    )
}
fn check_reply(snapshot: crate::updater::snapshot::Snapshot) -> Result<Value, BridgeError> {
    use crate::updater::snapshot::Phase;
    if let Some(update) = snapshot.candidate {
        if !matches!(
            snapshot.phase,
            Phase::Available
                | Phase::Downloading
                | Phase::Downloaded
                | Phase::Installing
                | Phase::InstallUnknown
                | Phase::RestartPending
                | Phase::Restarting
                | Phase::Error
        ) {
            return Err(failed());
        }
        Ok(
            json!({"success":true,"hasUpdate":true,"status":snapshot.phase,"updateInfo":{"version":update.version,"changelog":update.body.unwrap_or_default()}}),
        )
    } else if snapshot.phase == Phase::NotAvailable {
        Ok(json!({"success":true,"hasUpdate":false,"status":"not-available"}))
    } else {
        Err(failed())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::updater::{
        snapshot::{Phase, Progress, Snapshot},
        UpdateMetadata,
    };
    fn snapshot(phase: Phase, candidate: bool) -> Snapshot {
        Snapshot {
            version: 1,
            sequence: 1,
            phase,
            checked: true,
            operation_id: None,
            progress: Progress::default(),
            error: None,
            candidate: candidate.then(UpdateMetadata::test_candidate),
        }
    }
    #[test]
    fn exact_reply_preserves_all_eight_available_or_recovery_states() {
        for phase in [
            Phase::Available,
            Phase::Downloading,
            Phase::Downloaded,
            Phase::Installing,
            Phase::InstallUnknown,
            Phase::RestartPending,
            Phase::Restarting,
            Phase::Error,
        ] {
            let reply = check_reply(snapshot(phase, true)).unwrap();
            assert_eq!(reply.as_object().unwrap().len(), 4);
            assert_eq!(reply["hasUpdate"], true);
            assert_eq!(reply["status"], serde_json::to_value(phase).unwrap());
            assert_eq!(
                reply["updateInfo"],
                json!({"version":"1.0.1","changelog":"notes"})
            );
        }
    }
    #[test]
    fn no_candidate_is_success_only_for_not_available() {
        assert_eq!(
            check_reply(snapshot(Phase::NotAvailable, false)).unwrap(),
            json!({"success":true,"hasUpdate":false,"status":"not-available"})
        );
        for phase in [Phase::Idle, Phase::Checking, Phase::Error, Phase::Available] {
            assert!(check_reply(snapshot(phase, false)).is_err());
        }
        for phase in [Phase::Idle, Phase::Checking, Phase::NotAvailable] {
            assert!(check_reply(snapshot(phase, true)).is_err());
        }
        assert!(!handles("installUpdate"));
        assert!(!handles("setUpdateUrl"));
    }
}
