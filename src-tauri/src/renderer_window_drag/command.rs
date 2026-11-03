use super::{
    request::{
        is_main_caller, logical_position, logical_size, main_local_root_url, validate_position,
        validate_window_size, Position, Request, CALLER_REJECTED,
    },
    state::{DragState, LockInstall},
};
use std::{sync::Arc, time::Duration};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Position as TauriPosition, Size, Webview,
    Window, Wry,
};
use tokio::sync::oneshot;

const OPERATION_TIMEOUT: Duration = Duration::from_secs(5);

#[tauri::command]
pub(crate) async fn renderer_window_drag(
    webview: Webview<Wry>,
    app: AppHandle<Wry>,
    request: Request,
) -> Result<Option<Position>, String> {
    validate_caller_labels(&webview).map_err(str::to_owned)?;
    let state = app
        .try_state::<Arc<DragState>>()
        .ok_or("renderer window drag state is unavailable")?
        .inner()
        .clone();
    let (permit, generation) = state.try_admit().map_err(str::to_owned)?;
    let (sender, receiver) = oneshot::channel();
    let native_app = app.clone();
    let native_state = Arc::clone(&state);
    let native_webview = webview.clone();

    app.run_on_main_thread(move || {
        // Keep the slot occupied until native execution actually finishes,
        // even if the JavaScript invocation has timed out or been cancelled.
        let _permit = permit;
        if sender.is_closed() {
            return;
        }
        let result = match native_state.is_current(generation) {
            Ok(true) => validate_caller_source(&native_webview)
                .and_then(|()| {
                    crate::window::main_window(&native_app)
                        .map_err(|_| "main window is unavailable")
                })
                .and_then(|window| execute(&window, &native_state, generation, request)),
            Ok(false) => Err("window drag operation was invalidated"),
            Err(error) => Err(error),
        };
        let _ = sender.send(result);
    })
    .map_err(|_| "main-thread geometry dispatch failed")?;

    match tokio::time::timeout(OPERATION_TIMEOUT, receiver).await {
        Ok(Ok(result)) => result.map_err(str::to_owned),
        Ok(Err(_)) => Err("main-thread geometry result was interrupted".to_owned()),
        Err(_) => Err("main-thread geometry operation timed out".to_owned()),
    }
}

fn validate_caller_labels(webview: &Webview<Wry>) -> Result<(), &'static str> {
    if !is_main_caller(webview.label(), webview.window().label()) {
        return Err(CALLER_REJECTED);
    }
    Ok(())
}

fn validate_caller_source(webview: &Webview<Wry>) -> Result<(), &'static str> {
    validate_caller_labels(webview)?;
    let url = webview.url().map_err(|_| CALLER_REJECTED)?;
    if !main_local_root_url(&url) {
        return Err(CALLER_REJECTED);
    }
    Ok(())
}

fn execute(
    window: &Window<Wry>,
    state: &DragState,
    generation: u64,
    request: Request,
) -> Result<Option<Position>, &'static str> {
    match request {
        Request::Position {} => {
            let scale = scale_factor(window)?;
            let position = window
                .outer_position()
                .map_err(|_| "main window position is unavailable")?;
            Ok(Some(logical_position(position, scale)?))
        }
        Request::Lock { locked: true } => {
            lock_size(window, state, generation)?;
            Ok(None)
        }
        Request::Lock { locked: false } => {
            unlock_size(window, state, generation)?;
            Ok(None)
        }
        Request::Move { x, y } => {
            move_window(window, state, generation, x, y)?;
            Ok(None)
        }
    }
}

fn lock_size(window: &Window<Wry>, state: &DragState, generation: u64) -> Result<(), &'static str> {
    if state.locked_size(generation)?.is_some() {
        return Ok(());
    }
    let scale = scale_factor(window)?;
    let size = logical_size(
        window
            .inner_size()
            .map_err(|_| "main window size is unavailable")?,
        scale,
    )?;
    match state.install_lock(generation, size)? {
        LockInstall::Installed | LockInstall::AlreadyLocked => Ok(()),
        LockInstall::Invalidated => Err("window drag operation was invalidated"),
    }
}

fn unlock_size(
    window: &Window<Wry>,
    state: &DragState,
    generation: u64,
) -> Result<(), &'static str> {
    let Some(size) = state.locked_size(generation)? else {
        return Ok(());
    };
    let scale = scale_factor(window)?;
    let size = validate_window_size(size, scale)?;
    let position = logical_position(
        window
            .outer_position()
            .map_err(|_| "main window position is unavailable")?,
        scale,
    )?;
    window
        .set_size(Size::Logical(LogicalSize::new(size.width, size.height)))
        .map_err(|_| "main window size restoration failed")?;
    set_position(window, position)?;

    if state.release_lock(generation)? || state.is_locked() == Some(false) {
        Ok(())
    } else {
        Err("window drag lock changed during size restoration")
    }
}

fn move_window(
    window: &Window<Wry>,
    state: &DragState,
    generation: u64,
    x: f64,
    y: f64,
) -> Result<(), &'static str> {
    let scale = scale_factor(window)?;
    let position = validate_position(x, y, scale)?;
    if let Some(size) = state.locked_size(generation)? {
        let size = validate_window_size(size, scale)?;
        window
            .set_size(Size::Logical(LogicalSize::new(size.width, size.height)))
            .map_err(|_| "main window locked size restoration failed")?;
    }
    set_position(window, position)
}

fn set_position(window: &Window<Wry>, position: Position) -> Result<(), &'static str> {
    window
        .set_position(TauriPosition::Logical(LogicalPosition::new(
            position.x, position.y,
        )))
        .map_err(|_| "main window position update failed")
}

fn scale_factor(window: &Window<Wry>) -> Result<f64, &'static str> {
    let scale = window
        .scale_factor()
        .map_err(|_| "main window scale factor is unavailable")?;
    super::request::valid_scale_factor(scale)
}
