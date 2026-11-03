//! Native Main identity. Labels are routing names, never instance identity.
use super::{
    open_claims::MainKey,
    validation::{inactive_session, validate_main_context, BridgeError},
};
use tauri::{
    webview::{PageLoadEvent, PageLoadPayload},
    AppHandle, Manager, Webview, Window, Wry,
};

#[derive(Clone)]
pub(crate) struct MainBinding {
    pub(crate) key: MainKey,
    pub(crate) webview: Webview<Wry>,
    pub(crate) window: Window<Wry>,
}

#[derive(Clone)]
pub(crate) struct CapturedMain {
    pub(crate) key: MainKey,
    pub(crate) webview: Webview<Wry>,
    pub(crate) window: Window<Wry>,
    source: tauri::Url,
}

// Locked Tauri 2.11.2 allocates each ResourceTable in a new Arc on native
// construction; clones share it. Retained handles keep that allocation alive.
// Window/Webview PartialEq only compares labels and cannot serve this purpose.
pub(super) fn same_webview(a: &Webview<Wry>, b: &Webview<Wry>) -> bool {
    let a_id = &*a.resources_table() as *const _ as usize;
    let b_id = &*b.resources_table() as *const _ as usize;
    a_id == b_id
}
pub(super) fn same_window(a: &Window<Wry>, b: &Window<Wry>) -> bool {
    let a_id = &*a.resources_table() as *const _ as usize;
    let b_id = &*b.resources_table() as *const _ as usize;
    a_id == b_id
}

pub(crate) fn capture_main(
    app: &AppHandle<Wry>,
    webview: &Webview<Wry>,
    window: &Window<Wry>,
) -> Result<CapturedMain, BridgeError> {
    validate_main_context(app, webview, window)?;
    let runtime = super::runtime(app).map_err(|_| inactive_session())?;
    let key = runtime
        .capture_main_binding(webview, window)
        .ok_or_else(inactive_session)?;
    let captured = CapturedMain {
        key,
        webview: webview.clone(),
        window: window.clone(),
        source: webview.url().map_err(|_| inactive_session())?,
    };
    captured.validate(app)?;
    Ok(captured)
}

impl CapturedMain {
    pub(crate) fn validate(&self, app: &AppHandle<Wry>) -> Result<(), BridgeError> {
        validate_main_context(app, &self.webview, &self.window)?;
        let runtime = super::runtime(app).map_err(|_| inactive_session())?;
        if runtime.capture_main_binding(&self.webview, &self.window) != Some(self.key)
            || self.webview.url().map_err(|_| inactive_session())? != self.source
            || !app
                .get_webview("main")
                .is_some_and(|view| same_webview(&view, &self.webview))
            || !app
                .get_window("main")
                .is_some_and(|window| same_window(&window, &self.window))
            || !same_window(&self.webview.window(), &self.window)
        {
            return Err(inactive_session());
        }
        Ok(())
    }
}

pub(crate) fn prepare_main(app: &AppHandle<Wry>) -> Result<u64, String> {
    let (instance, tickets) = super::runtime(app)?.register_main_instance()?;
    super::open_service::cleanup_tickets(app, tickets);
    Ok(instance)
}

pub(crate) fn on_main_page_load(view: &Webview<Wry>, payload: &PageLoadPayload<'_>, instance: u64) {
    let app = view.app_handle();
    let Ok(runtime) = super::runtime(app) else {
        return;
    };
    match payload.event() {
        PageLoadEvent::Started => {
            if let Ok((key, tickets)) = runtime.note_main_started(instance) {
                runtime.bind_main_handles(key, view);
                super::open_service::cleanup_tickets(app, tickets);
            }
        }
        PageLoadEvent::Finished => {
            if let Some(key) = runtime.bound_main_key(instance, view) {
                let _ = runtime.note_main_finished(key);
            }
        }
    }
}

pub(crate) fn on_main_destroyed_instance(app: &AppHandle<Wry>, instance: u64) {
    if let Ok(runtime) = super::runtime(app) {
        if let Ok(tickets) = runtime.note_main_destroyed(instance) {
            super::open_service::cleanup_tickets(app, tickets);
        }
    }
}

/// Global event handler must bind the event's actual Window before revoking.
pub(crate) fn on_main_window_destroyed(window: &Window<Wry>) {
    let app = window.app_handle();
    let instance = super::runtime(app)
        .ok()
        .and_then(|r| r.main_instance_for_window(window));
    if let Some(instance) = instance {
        on_main_destroyed_instance(app, instance);
    }
}

pub(crate) fn revoke_main_for_shutdown(app: &AppHandle<Wry>) {
    if let Some(key) = super::runtime(app).ok().and_then(|r| r.current_main_key()) {
        on_main_destroyed_instance(app, key.window_instance);
    }
}
