//! OS-path-only, original Main input. No renderer path-stat capability.
mod binding;
mod delivery;
mod metadata;
mod protocol;
mod state;
#[cfg(test)]
mod tests;
mod work;
use parking_lot::Mutex;
use protocol::{Payload, Request, REJECTED};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, EventTarget, Manager, Webview, Wry};
pub(crate) struct Runtime {
    delivery: Mutex<()>,
    #[cfg(test)]
    revoke_attempt: Mutex<Option<std::sync::mpsc::Sender<bool>>>,
    state: Mutex<state::State>,
}
fn runtime(app: &AppHandle) -> Option<Arc<Runtime>> {
    app.try_state::<Arc<Runtime>>().map(|r| r.inner().clone())
}
pub(crate) fn bind_created<T>(
    main: &T,
    bind: impl FnOnce(&T) -> Result<(), String>,
) -> Result<(), String> {
    bind(main)
}
pub(crate) use binding::{bind_main, on_page_load, prepare};
pub(super) fn source_enabled(app: &AppHandle) -> bool {
    if !cfg!(feature = "ztools-multiwebview") {
        return false;
    }
    let c = app.config();
    let original = c.identifier == "dev.atools.desktop"
        && c.build.dev_url.is_none()
        && matches!(c.build.frontend_dist.as_ref(),Some(tauri::utils::config::FrontendDist::Directory(p)) if p==std::path::Path::new("../packages/ztools-renderer/dist"));
    #[cfg(feature = "legacy-node-smoke")]
    {
        return original || crate::renderer_desktop_smoke::main_drop_probe::authorizes(app);
    }
    #[cfg(not(feature = "legacy-node-smoke"))]
    original
}
fn trusted(url: &tauri::Url) -> bool {
    matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    ) && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.path(), "/" | "/index.html")
        && url.query().is_none()
        && url.fragment().is_none()
}
fn current(app: &AppHandle) -> bool {
    source_enabled(app)
        && crate::window::main_webview(app).is_ok_and(|w| {
            w.label() == "main"
                && w.window().label() == "main"
                && w.url().is_ok_and(|u| trusted(&u))
        })
}
fn settings_present(app: &AppHandle) -> bool {
    #[cfg(feature = "ztools-multiwebview")]
    {
        return crate::renderer_settings_view::snapshot(app)["sessionCount"]
            .as_u64()
            .is_some_and(|n| n != 0);
    }
    #[cfg(not(feature = "ztools-multiwebview"))]
    {
        let _ = app;
        false
    }
}
fn emit(app: &AppHandle, value: Option<Value>) {
    if let Some(value) = value {
        let _ = app.emit_to(
            EventTarget::webview("main"),
            "renderer-main-file-drop",
            value,
        );
    }
}
pub(crate) fn suspend(app: &AppHandle) {
    if let Some(r) = runtime(app) {
        delivery::revoke(&r, |s| s.suspend(), |v| emit(app, v));
    }
}
pub(crate) fn resume(app: &AppHandle) {
    if let Some(r) = runtime(app) {
        let _delivery = r.delivery.lock();
        r.state.lock().resume();
    }
}
#[cfg(test)]
pub(crate) fn invalidate(app: &AppHandle) {
    if let Some(r) = runtime(app) {
        delivery::revoke(&r, |s| s.rotate(), |v| emit(app, v));
    }
}
pub(crate) fn stop(app: &AppHandle) {
    if let Some(r) = runtime(app) {
        delivery::revoke(
            &r,
            |s| {
                s.rotate();
                s.stopped = true
            },
            |v| emit(app, v),
        );
    }
}
pub(crate) struct SettingsOpening {
    runtime: Option<Arc<Runtime>>,
}
pub(crate) fn settings_start(app: &AppHandle) -> SettingsOpening {
    let r = runtime(app);
    if let Some(r) = &r {
        delivery::revoke(
            r,
            |s| {
                s.rotate();
                s.opening = s.opening.saturating_add(1)
            },
            |v| emit(app, v),
        );
    }
    SettingsOpening { runtime: r }
}
impl Drop for SettingsOpening {
    fn drop(&mut self) {
        if let Some(r) = &self.runtime {
            let _delivery = r.delivery.lock();
            let mut s = r.state.lock();
            s.opening = s.opening.saturating_sub(1)
        }
    }
}
#[tauri::command]
pub(crate) fn set_renderer_main_drop_target(
    app: AppHandle,
    webview: Webview<Wry>,
    ipc_request: tauri::ipc::Request<'_>,
) -> Result<Value, String> {
    let tauri::ipc::InvokeBody::Json(body) = ipc_request.body() else {
        return Err(REJECTED.into());
    };
    let request = protocol::parse(body).map_err(str::to_owned)?;
    if webview.label() != "main"
        || webview.window().label() != "main"
        || !current(&app)
        || settings_present(&app)
    {
        return Err(REJECTED.into());
    }
    let r = runtime(&app).ok_or(REJECTED)?;
    let _delivery = r.delivery.lock();
    let mut s = r.state.lock();
    if s.stopped || s.opening != 0 {
        return Err(REJECTED.into());
    }
    match request {
        Request::Context => Ok(json!({"contextId":s.context})),
        Request::Set {
            context,
            lease,
            target,
        } => {
            if context != s.context || s.lease.as_ref().map(|l| l.id.as_str()) != lease.as_deref() {
                return Err(REJECTED.into());
            }
            let notice = if target.is_none() {
                s.hover(false)
            } else {
                None
            };
            let ack = s
                .set(&context, lease.as_deref(), target)
                .map_err(str::to_owned)?;
            drop(s);
            emit(&app, notice);
            Ok(json!({"leaseId":ack}))
        }
    }
}
#[cfg(feature = "legacy-node-smoke")]
pub(crate) fn fixture_snapshot(app: &AppHandle) -> Value {
    let Some(r) = runtime(app) else {
        return json!({"targetRegistered":false,"actualWorkers":0,"pendingBatches":0});
    };
    let s = r.state.lock();
    json!({"targetRegistered":s.lease.is_some(),"nativeAccepted":s.accepted,"metadataFiles":s.metadata_files,"actualWorkers":u8::from(s.running),"pendingBatches":u8::from(s.pending.is_some())})
}
#[cfg(feature = "legacy-node-smoke")]
pub(crate) fn inject_fixture(
    app: &AppHandle,
    paths: Vec<std::path::PathBuf>,
) -> Result<(), String> {
    if !crate::renderer_desktop_smoke::main_drop_probe::authorizes(app) {
        return Err(REJECTED.into());
    }
    let r = runtime(app).ok_or(REJECTED)?;
    let (binding, rect) = {
        let s = r.state.lock();
        (s.binding.clone(), s.lease.as_ref().ok_or(REJECTED)?.rect)
    };
    let scale = crate::window::main_window(app)
        .map_err(|_| REJECTED)?
        .scale_factor()
        .map_err(|_| REJECTED)?;
    let point = ((rect.x + rect.width / 2.0), (rect.y + rect.height / 2.0));
    if !point.0.is_finite()
        || !point.1.is_finite()
        || [point.0, point.1]
            .iter()
            .any(|v| *v < f64::from(i32::MIN) || *v > f64::from(i32::MAX))
    {
        return Err(REJECTED.into());
    }
    // Emulate the locked backend's raw event, not hand-crafted post-normalized physical points.
    let position = if cfg!(target_os = "macos") {
        tauri::PhysicalPosition::new(point.0.trunc(), point.1.trunc())
    } else {
        tauri::PhysicalPosition::new(point.0 * scale, point.1 * scale)
    };
    binding::handle(
        app,
        &binding,
        &tauri::DragDropEvent::Drop { paths, position },
    );
    Ok(())
}
