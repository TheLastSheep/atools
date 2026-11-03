//! One owned popup; a dropped show/close IPC awaiter cannot abandon its lifecycle.
use super::*;
use std::sync::{atomic::Ordering, Arc};
use tauri::{ipc::CapabilityBuilder, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

#[derive(Clone, Copy)]
enum Admission {
    Legacy,
    SettingsAbout,
}

pub(super) async fn show(app: &AppHandle) -> Result<String, Error> {
    show_with(app, display::Principal::default()).await
}
pub(super) async fn show_with(
    app: &AppHandle,
    principal: display::Principal,
) -> Result<String, Error> {
    show_selected(app, principal, None, Admission::Legacy).await
}
async fn show_selected(
    app: &AppHandle,
    principal: display::Principal,
    expected: Option<String>,
    admission: Admission,
) -> Result<String, Error> {
    let owned = app.clone();
    tauri::async_runtime::spawn(
        async move { show_owned(&owned, principal, expected, admission).await },
    )
    .await
    .map_err(|_| error("internal"))?
}
pub(super) async fn show_about(
    app: &AppHandle,
    principal: display::Principal,
    expected: String,
) -> Result<String, Error> {
    show_selected(app, principal, Some(expected), Admission::SettingsAbout).await
}
async fn show_owned(
    app: &AppHandle,
    principal: display::Principal,
    expected: Option<String>,
    admission: Admission,
) -> Result<String, Error> {
    let candidate = super::expected_candidate(&coordinator(app)?.view()?, expected.as_deref())?;
    let runtime = runtime(app)?;
    if runtime.stopped.load(Ordering::Acquire) {
        return Err(error("operation_interrupted"));
    }
    if runtime.opening.load(Ordering::Acquire) {
        return Err(error("busy"));
    }
    let existing = selection::existing(&runtime, &coordinator(app)?, &candidate.candidate_id)?;
    if let Some(session) = existing {
        if !session.alive.load(Ordering::Acquire) || session.closing.load(Ordering::Acquire) {
            return Err(error("busy"));
        }
        display::show(
            app,
            session.clone(),
            principal,
            candidate.candidate_id.clone(),
        )
        .await?;
        return Ok(session.id);
    }
    let opening = runtime.reserve_opening()?;
    if !runtime.acl_installed.swap(true, Ordering::AcqRel) {
        if app
            .add_capability(
                CapabilityBuilder::new("renderer-updater-events")
                    .webview("renderer-updater-*")
                    .permission("core:event:allow-listen")
                    .permission("core:event:allow-unlisten"),
            )
            .is_err()
        {
            runtime.acl_installed.store(false, Ordering::Release);
            return Err(error("internal"));
        }
    }
    let hidden = app.config().identifier != "dev.atools.desktop"
        || app
            .try_state::<crate::state::AppState>()
            .is_none_or(|state| state.release_smoke.lock().is_some());
    let root = if cfg!(debug_assertions) && !hidden {
        std::path::PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../dist-ztools-updater"
        ))
    } else {
        app.path()
            .resource_dir()
            .map_err(|_| error("internal"))?
            .join("ztools-updater")
    };
    let bundle = Arc::new(bundle::Bundle::load(&root).map_err(|_| error("invalid_manifest"))?);
    if coordinator(app)?
        .view()?
        .candidate
        .as_ref()
        .map(|m| &m.candidate_id)
        != Some(&candidate.candidate_id)
    {
        return Err(error("stale_candidate"));
    }
    let id = uuid::Uuid::new_v4().simple().to_string();

    let state = coordinator(app)?;
    let pin = match admission {
        Admission::Legacy => {
            state
                .reserve_presentation(&id, &candidate.candidate_id)
                .await?
        }
        Admission::SettingsAbout => {
            state
                .reserve_about_presentation(&id, &candidate.candidate_id)
                .await?
        }
    };
    let mut session =
        runtime::Session::new(id.clone(), bundle, hidden, candidate.candidate_id.clone());
    session.presentation = Some(pin);
    opening.install(session.clone())?;
    let app_for_build = app.clone();
    let slot = runtime.clone();
    let owned = session.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let build_principal = principal.clone();
    let enqueue = app.run_on_main_thread(move || {
        let window = build_principal
            .pending()
            .and_then(|_| build_native(&app_for_build, &owned, slot));
        if let Err(unobserved) = tx.send(window) {
            if let Ok(window) = unobserved {
                let _ = window.destroy();
            }
        }
    });
    if enqueue.is_err() {
        runtime.destroyed(&id);
        return Err(error("internal"));
    }
    let window = match rx.await.map_err(|_| error("internal"))? {
        Ok(w) => w,
        Err(e) => {
            runtime.destroyed(&id);
            return Err(e);
        }
    };
    let result = async {
        let appearance = async {
            let raw = native_appearance::read_general(app).await?;
            native_appearance::refresh(app, &session, raw.as_deref(), true).await
        }
        .await;
        if let Err(error) = appearance {
            *session.appearance_error.lock() = Some(error);
            session.appearance_changed.notify_waiters();
        }
        if !session.alive.load(Ordering::Acquire) {
            return Err(error("forbidden_window"));
        }
        display::show(
            app,
            session.clone(),
            principal,
            candidate.candidate_id.clone(),
        )
        .await?;
        Ok(id.clone())
    }
    .await;
    if result.is_err() {
        runtime.invalidate(&id);
        let _ = window.destroy();
    }
    result
}
pub(super) async fn close(app: &AppHandle, id: &str) -> Result<(), Error> {
    let runtime = runtime(app)?;
    let state = coordinator(app)?;
    let close_admission = state.reserve_window_close()?;
    let (session, task) = runtime.reserve_close_task(id)?;
    drop(close_admission);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _task = task;
        let window = app
            .get_webview_window(&session.label)
            .ok_or_else(|| error("forbidden_window"))?;
        if window.close().is_err() {
            return Err(error("internal"));
        }
        tokio::time::timeout(std::time::Duration::from_secs(3), session.wait_closed())
            .await
            .map_err(|_| error("internal"))
    })
    .await
    .map_err(|_| error("internal"))?
}

// Called exclusively by show_owned's main-thread callback. No application mutex spans a native call.
fn build_native(
    app: &AppHandle,
    owned: &runtime::Session,
    slot: Arc<runtime::Runtime>,
) -> Result<tauri::WebviewWindow, Error> {
    if !owned.alive.load(Ordering::Acquire) {
        return Err(error("operation_interrupted"));
    }
    let navigation = slot.clone();
    let nav_owned = owned.clone();
    let nav_app = app.clone();
    let events = slot;
    let event_id = owned.id.clone();
    let event_app = app.clone();
    let url = format!("atools-updater://localhost/{}/updater.html", owned.id)
        .parse()
        .map_err(|_| error("internal"))?;
    let id_json = serde_json::to_string(&owned.id).map_err(|_| error("internal"))?;
    let window=WebviewWindowBuilder::new(app,&owned.label,WebviewUrl::External(url))
  .title("ATools 更新").inner_size(500.,450.).decorations(false).transparent(true).resizable(false)
  .maximizable(false).minimizable(false).always_on_top(true).shadow(true).center().visible(false).focused(false).incognito(true)
  .initialization_script(format!("Object.defineProperty(window,'__ATOOLS_UPDATER_WINDOW_ID__',{{value:{id_json},writable:false,configurable:false}});"))
  .on_navigation(move|url|{
   let allowed=navigation.navigation(&nav_owned.id,url);
   if !allowed&&!nav_owned.destroy_queued.swap(true,Ordering::AcqRel){
    let app=nav_app.clone();let label=nav_owned.label.clone();
    // Always leave the WebKit navigation callback stack before requesting destruction.
    tauri::async_runtime::spawn(async move {let lookup=app.clone();let _=app.run_on_main_thread(move||{if let Some(window)=lookup.get_webview_window(&label){let _=window.destroy();}});});
   }
   allowed
  })
  .on_new_window(|_,_|tauri::webview::NewWindowResponse::Deny).build().map_err(|_|error("internal"))?;
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            let already_closing = {
                events
                    .session
                    .lock()
                    .as_ref()
                    .is_some_and(|s| s.id == event_id && s.closing.load(Ordering::Acquire))
            };
            if !already_closing {
                let permit = coordinator(&event_app).and_then(|c| c.reserve_window_close());
                if permit.is_err() || events.begin_close(&event_id, false).is_err() {
                    api.prevent_close()
                }
            }
        }
        WindowEvent::Destroyed => events.destroyed(&event_id),
        WindowEvent::ThemeChanged(_) => native_appearance::theme_changed(&event_app, &event_id),
        _ => {}
    });
    Ok(window)
}
