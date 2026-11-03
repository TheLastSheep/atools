use tauri::Window;

/// Reads ATools' main NSWindow alpha or applies a bounded target and reads it back.
/// `Some(0.0..=1.0)` includes restoration of the actual previously observed alpha;
/// the user-facing General setting is narrower and validated by Core.
pub(crate) async fn read_apply(window: Window, target: Option<f64>) -> Result<f64, String> {
    if target.is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value)) {
        return Err("Window opacity target is outside the native range".into());
    }

    #[cfg(target_os = "macos")]
    {
        read_apply_macos(window, target).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, target);
        Err("Window opacity application is unsupported on this platform".into())
    }
}

#[cfg(target_os = "macos")]
async fn read_apply_macos(window: Window, target: Option<f64>) -> Result<f64, String> {
    use tokio::sync::oneshot;

    let (send, receive) = oneshot::channel();
    let task_window = window.clone();
    window
        .run_on_main_thread(move || {
            let result = read_apply_on_main(&task_window, target);
            let _ = send.send(result);
        })
        .map_err(|_| "Main-thread opacity task could not be scheduled".to_owned())?;
    receive
        .await
        .map_err(|_| "Main-thread opacity task stopped before replying".to_owned())?
}

#[cfg(target_os = "macos")]
pub(crate) fn read_apply_on_main(window: &Window, target: Option<f64>) -> Result<f64, String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSWindow;
    if target.is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value)) {
        return Err("Window opacity target is outside the native range".into());
    }
    let _main_thread = MainThreadMarker::new()
        .ok_or_else(|| "AppKit opacity requires the main thread".to_owned())?;
    let pointer = window
        .ns_window()
        .map_err(|_| "Main native window handle is unavailable".to_owned())?;
    if pointer.is_null() {
        return Err("Main native window handle is unavailable".to_owned());
    }
    // Tauri owns this NSWindow; dereference it only on AppKit's main thread.
    let native = unsafe { &*pointer.cast::<NSWindow>() };
    if let Some(target) = target {
        native.setAlphaValue(target);
    }
    let actual = native.alphaValue() as f64;
    if !actual.is_finite() || !(0.0..=1.0).contains(&actual) {
        return Err("Main native window returned an invalid opacity".to_owned());
    }
    if target.is_some_and(|target| (actual - target).abs() > 0.005) {
        return Err("Main native window opacity readback did not match".to_owned());
    }
    Ok(actual)
}
