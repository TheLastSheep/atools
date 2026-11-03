//! Main-thread display admission. The Child grant commits before transfer to a global window.
use super::*;
use tauri::Manager;
#[derive(Clone, Default)]
pub(super) struct Principal {
    #[cfg(feature = "ztools-multiwebview")]
    grant: Option<crate::renderer_settings_view::UpdaterGrant>,
}
impl Principal {
    #[cfg(feature = "ztools-multiwebview")]
    pub fn settings(grant: crate::renderer_settings_view::UpdaterGrant) -> Self {
        Self { grant: Some(grant) }
    }
    pub fn pending(&self) -> Result<(), Error> {
        #[cfg(feature = "ztools-multiwebview")]
        if let Some(grant) = &self.grant {
            grant.pending().map_err(|_| error("forbidden_window"))?;
        }
        Ok(())
    }
    fn admit(&self) -> Result<(), Error> {
        #[cfg(feature = "ztools-multiwebview")]
        if let Some(grant) = &self.grant {
            grant.admit().map_err(|_| error("forbidden_window"))?;
        }
        Ok(())
    }
}
pub(super) async fn show(
    app: &AppHandle,
    session: runtime::Session,
    principal: Principal,
    expected: String,
) -> Result<(), Error> {
    let app_owned = app.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = (|| {
            if !session.alive.load(Ordering::Acquire) || session.closing.load(Ordering::Acquire) {
                return Err(error("forbidden_window"));
            }
            selection::admit(
                runtime(&app_owned)?.as_ref(),
                &coordinator(&app_owned)?,
                &session,
                &expected,
            )?;
            let window = app_owned
                .get_webview_window(&session.label)
                .ok_or_else(|| error("forbidden_window"))?;
            // Shares the Settings revocation mutex only for this commit; no lock spans Native APIs.
            principal.admit()?;
            if !session.hidden {
                window.show().map_err(|_| error("internal"))?;
                window.set_focus().map_err(|_| error("internal"))?;
            }
            session.presented.store(true, Ordering::Release);
            Ok(())
        })();
        let _ = tx.send(result);
    })
    .map_err(|_| error("internal"))?;
    rx.await.map_err(|_| error("internal"))?
}
pub(super) async fn reuse(
    app: &AppHandle,
    principal: Principal,
) -> Result<Option<crate::updater::snapshot::Snapshot>, Error> {
    let runtime = runtime(app)?;
    if runtime.stopped.load(Ordering::Acquire) {
        return Err(error("operation_interrupted"));
    }
    let existing = runtime.reusable_session()?;
    let Some(session) = existing else {
        return Ok(None);
    };
    if !session.alive.load(Ordering::Acquire) || session.closing.load(Ordering::Acquire) {
        return Err(error("busy"));
    }
    let snapshot = coordinator(app)?.view()?;
    let current = super::expected_candidate(&snapshot, session.candidate.as_deref())?;
    if session.candidate.as_deref() != Some(current.candidate_id.as_str()) {
        return Err(error("stale_candidate"));
    }
    show(app, session, principal, current.candidate_id).await?;
    Ok(Some(snapshot))
}
