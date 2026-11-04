//! Small platform-specific native settings that Tauri does not expose.

use tauri::WebviewWindow;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SkipTaskbarBehavior {
    Noop,
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Native(bool),
}

pub(super) fn skip_taskbar_behavior(enabled: bool) -> SkipTaskbarBehavior {
    #[cfg(target_os = "macos")]
    {
        let _ = enabled;
        SkipTaskbarBehavior::Noop
    }
    #[cfg(not(target_os = "macos"))]
    {
        SkipTaskbarBehavior::Native(enabled)
    }
}

#[cfg(target_os = "macos")]
pub(super) fn configure_fullscreenable(
    window: &WebviewWindow,
    fullscreenable: bool,
) -> Result<(), String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};

    let _main_thread = MainThreadMarker::new()
        .ok_or_else(|| unsupported("fullscreenable requires the AppKit main thread"))?;
    let pointer = window
        .ns_window()
        .map_err(|error| format!("ERR_ATOOLS_NATIVE_WINDOW_BUILD: {error}"))?;
    if pointer.is_null() {
        return Err(unsupported("the native NSWindow handle is unavailable"));
    }

    // Tauri owns the live NSWindow and this adapter runs synchronously on its
    // main thread. Keep unrelated collection behavior bits unchanged.
    let native = unsafe { &*pointer.cast::<NSWindow>() };
    let mut behavior = native.collectionBehavior();
    if fullscreenable {
        behavior.remove(NSWindowCollectionBehavior::FullScreenNone);
        behavior.insert(NSWindowCollectionBehavior::FullScreenPrimary);
    } else {
        behavior.remove(NSWindowCollectionBehavior::FullScreenPrimary);
        behavior.insert(NSWindowCollectionBehavior::FullScreenNone);
    }
    native.setCollectionBehavior(behavior);
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(super) fn configure_fullscreenable(
    _window: &WebviewWindow,
    fullscreenable: bool,
) -> Result<(), String> {
    if fullscreenable {
        Ok(())
    } else {
        Err(unsupported(
            "fullscreenable=false is only supported by the macOS native adapter",
        ))
    }
}

fn unsupported(message: impl AsRef<str>) -> String {
    format!("ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED: {}", message.as_ref())
}

#[cfg(test)]
mod tests {
    use super::{skip_taskbar_behavior, SkipTaskbarBehavior};

    #[test]
    fn taskbar_policy_matches_electron_macos_noop() {
        #[cfg(target_os = "macos")]
        assert_eq!(skip_taskbar_behavior(true), SkipTaskbarBehavior::Noop);
        #[cfg(not(target_os = "macos"))]
        assert_eq!(
            skip_taskbar_behavior(true),
            SkipTaskbarBehavior::Native(true)
        );
    }
}
