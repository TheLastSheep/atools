#[cfg(not(target_os = "macos"))]
use std::sync::{LazyLock, Mutex};
use tauri::Window;

pub(crate) const MIN_USER_OPACITY: f64 = 0.2;
pub(crate) const MAX_USER_OPACITY: f64 = 1.0;

pub(crate) fn validate_native_opacity_target(target: Option<f64>) -> Result<Option<f64>, String> {
    if target.is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value)) {
        return Err("Window opacity target is outside the native range".into());
    }
    Ok(target)
}

#[allow(dead_code)]
pub(crate) fn clamp_user_opacity(value: f64) -> Result<f64, String> {
    if !value.is_finite() {
        return Err("Window opacity target is outside the native range".into());
    }
    Ok(value.clamp(MIN_USER_OPACITY, MAX_USER_OPACITY))
}

#[allow(dead_code)]
pub(crate) fn apply_clamped_opacity_state(
    state: &mut f64,
    target: Option<f64>,
) -> Result<f64, String> {
    if let Some(value) = validate_native_opacity_target(target)? {
        *state = clamp_user_opacity(value)?;
    }
    Ok(*state)
}

#[cfg(not(target_os = "macos"))]
static FALLBACK_OPACITY: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(MAX_USER_OPACITY));

/// Reads ATools' main NSWindow alpha or applies a bounded target and reads it back.
/// `Some(0.0..=1.0)` includes restoration of the actual previously observed alpha;
/// the user-facing General setting is narrower and validated by Core.
pub(crate) async fn read_apply(window: Window, target: Option<f64>) -> Result<f64, String> {
    validate_native_opacity_target(target)?;

    #[cfg(target_os = "macos")]
    {
        read_apply_macos(window, target).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        let mut guard = FALLBACK_OPACITY
            .lock()
            .map_err(|_| "Window opacity state lock poisoned".to_string())?;
        apply_clamped_opacity_state(&mut guard, target)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opacity_clamping_and_validation_enforces_bounds() {
        assert_eq!(clamp_user_opacity(0.05).unwrap(), MIN_USER_OPACITY);
        assert_eq!(clamp_user_opacity(0.85).unwrap(), 0.85);
        assert_eq!(clamp_user_opacity(1.5).unwrap(), MAX_USER_OPACITY);
        assert!(clamp_user_opacity(f64::NAN).is_err());

        let mut state = MAX_USER_OPACITY;
        assert_eq!(apply_clamped_opacity_state(&mut state, None).unwrap(), 1.0);
        assert_eq!(
            apply_clamped_opacity_state(&mut state, Some(0.1)).unwrap(),
            MIN_USER_OPACITY
        );
        assert_eq!(
            apply_clamped_opacity_state(&mut state, Some(0.75)).unwrap(),
            0.75
        );
        assert!(apply_clamped_opacity_state(&mut state, Some(1.2)).is_err());
        assert!(apply_clamped_opacity_state(&mut state, Some(-0.1)).is_err());
    }
}
