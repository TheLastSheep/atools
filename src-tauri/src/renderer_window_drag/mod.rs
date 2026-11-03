pub(crate) mod command;
mod request;
mod state;

use std::sync::Arc;
use tauri::{
    plugin::Builder as PluginBuilder, webview::PageLoadEvent, AppHandle, Builder, Manager,
    PhysicalSize, WindowEvent, Wry,
};

use state::DragState;

pub(crate) fn register(builder: Builder<Wry>) -> Builder<Wry> {
    let plugin = PluginBuilder::<Wry, ()>::new("renderer-window-drag")
        .setup(|app, _api| {
            app.manage(Arc::new(DragState::new()));
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started
                && webview.label() == "main"
                && webview.window().label() == "main"
            {
                clear(webview.app_handle());
            }
        })
        .on_window_ready(|window| {
            if window.label() != "main" {
                return;
            }
            let app = window.app_handle().clone();
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::Destroyed) {
                    clear(&app);
                }
            });
        })
        .build();
    builder.plugin(plugin)
}

/// Clear a pending size lock before the main window is hidden or replaced.
pub(crate) fn clear(app: &AppHandle<Wry>) {
    let Some(state) = app.try_state::<Arc<DragState>>() else {
        return;
    };
    if state.invalidate_lock().is_err() {
        tracing::warn!(
            diagnostic = "renderer-window-drag-state-clear-failed",
            "Window drag state could not be cleared"
        );
    }
}

/// Keep an active drag lock aligned with a successful production resize.
pub(crate) fn resized(app: &AppHandle<Wry>, physical_size: PhysicalSize<u32>, scale: f64) {
    let Some(state) = app.try_state::<Arc<DragState>>() else {
        return;
    };
    match request::logical_size(physical_size, scale) {
        Ok(size) => {
            if state.resize_locked_size(size).is_err() {
                tracing::warn!(
                    diagnostic = "renderer-window-drag-resize-state-failed",
                    "Window drag size lock could not be updated after resize"
                );
            }
        }
        Err(_) => {
            let _ = state.invalidate_lock();
            tracing::warn!(
                diagnostic = "renderer-window-drag-invalid-resize-geometry",
                "Window drag size lock was cleared after invalid resize geometry"
            );
        }
    }
}

#[cfg(feature = "legacy-node-smoke")]
pub(crate) fn locked(app: &AppHandle<Wry>) -> Option<bool> {
    app.try_state::<Arc<DragState>>()
        .and_then(|state| state.is_locked())
}
