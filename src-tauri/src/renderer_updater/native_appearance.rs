//! Owned-popup Native effects/readback. Pure General projection lives separately.
use super::{appearance::*, runtime::Session};
use crate::updater::UpdateCommandError;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, EventTarget, Manager, Theme, WebviewWindow};
fn unavailable() -> UpdateCommandError {
    UpdateCommandError::new("appearance_unavailable", "更新窗口外观状态暂不可用")
}
pub(super) async fn read_general(app: &AppHandle) -> Result<Option<String>, UpdateCommandError> {
    let state = app
        .try_state::<crate::state::AppState>()
        .ok_or_else(unavailable)?;
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || db.get_setting("settings-general"))
        .await
        .map_err(|_| unavailable())?
        .map_err(|_| unavailable())
}
pub(super) async fn refresh(
    app: &AppHandle,
    session: &Session,
    raw: Option<&str>,
    apply: bool,
) -> Result<Appearance, UpdateCommandError> {
    let target = if apply {
        Some(parse_general(raw)?)
    } else {
        None
    };
    let requested = if apply {
        session.appearance_requested.fetch_add(1, Ordering::AcqRel) + 1
    } else {
        0
    };
    let _operation = session.appearance_gate.lock().await;
    let requested = if apply {
        requested
    } else {
        session.appearance_requested.load(Ordering::Acquire)
    };
    let config = target
        .or_else(|| session.appearance_config.lock().clone())
        .ok_or_else(unavailable)?;
    if !session.alive.load(Ordering::Acquire)
        || session.appearance_requested.load(Ordering::Acquire) != requested
    {
        return Err(unavailable());
    }
    let window = app
        .get_webview_window(&session.label)
        .ok_or_else(unavailable)?;
    let facts = facts(&window, session, &config, apply, requested).await?;
    if !session.alive.load(Ordering::Acquire)
        || session.appearance_requested.load(Ordering::Acquire) != requested
    {
        return Err(unavailable());
    }
    let sequence = session.appearance_sequence.fetch_add(1, Ordering::AcqRel) + 1;
    let result = project(&session.id, sequence, &config, facts)?;
    *session.appearance_config.lock() = Some(config);
    *session.appearance_value.lock() = Some(result.clone());
    *session.appearance_error.lock() = None;
    session.appearance_changed.notify_waiters();
    let runtime = super::runtime(app)?;
    let _delivery = runtime.delivery.lock();
    if runtime
        .session
        .lock()
        .as_ref()
        .is_some_and(|s| s.id == session.id && s.ready && s.alive.load(Ordering::Acquire))
    {
        let _ = app.emit_to(
            EventTarget::webview(&session.label),
            "renderer-updater-appearance",
            &result,
        );
    }
    Ok(result)
}
async fn facts(
    window: &WebviewWindow,
    session: &Session,
    config: &Config,
    apply: bool,
    requested: u64,
) -> Result<NativeFacts, UpdateCommandError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let native = window.clone();
    let owned = session.clone();
    let cfg = config.clone();
    window
        .run_on_main_thread(move || {
            let result = (|| {
                if !owned.alive.load(Ordering::Acquire)
                    || owned.appearance_requested.load(Ordering::Acquire) != requested
                {
                    return Err(unavailable());
                }
                if apply {
                    native
                        .set_theme(match cfg.theme {
                            ThemePreference::System => None,
                            ThemePreference::Light => Some(Theme::Light),
                            ThemePreference::Dark => Some(Theme::Dark),
                        })
                        .map_err(|_| unavailable())?;
                }
                let effective = match native.theme().map_err(|_| unavailable())? {
                    Theme::Light => EffectiveTheme::Light,
                    Theme::Dark => EffectiveTheme::Dark,
                    _ => return Err(unavailable()),
                };
                #[cfg(target_os = "macos")]
                {
                    let material = macos_material(&native, &owned, apply)?;
                    Ok((effective, material))
                }
                #[cfg(not(target_os = "macos"))]
                {
                    Ok((effective, false))
                }
            })();
            let _ = tx.send(result);
        })
        .map_err(|_| unavailable())?;
    let (effective, material_applied) = tokio::time::timeout(std::time::Duration::from_secs(2), rx)
        .await
        .map_err(|_| unavailable())?
        .map_err(|_| unavailable())??;
    #[cfg(target_os = "macos")]
    {
        let native_window: tauri::Window = AsRef::<tauri::Webview>::as_ref(window).window();
        let opacity = crate::native_window_opacity::read_apply(
            native_window,
            apply.then_some(config.opacity),
        )
        .await
        .map_err(|_| unavailable())?;
        Ok(NativeFacts {
            platform: Platform::Darwin,
            material: Material::None,
            native_material: NativeMaterial::FullScreenUi,
            material_applied,
            effective_theme: effective,
            opacity: Some(opacity),
            opacity_applied: (opacity - config.opacity).abs() < 1e-6,
            error: None,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = material_applied;
        Ok(NativeFacts {
            platform: if cfg!(target_os = "windows") {
                Platform::Win32
            } else {
                Platform::Linux
            },
            material: Material::None,
            native_material: NativeMaterial::None,
            material_applied: false,
            effective_theme: effective,
            opacity: None,
            opacity_applied: false,
            error: Some(UpdateCommandError::new(
                "appearance_unsupported",
                "当前系统暂不支持更新窗口原生材质或透明度",
            )),
        })
    }
}
#[cfg(target_os = "macos")]
fn macos_material(
    window: &WebviewWindow,
    session: &Session,
    apply: bool,
) -> Result<bool, UpdateCommandError> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSVisualEffectView, NSWindow};
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
    let _main = MainThreadMarker::new().ok_or_else(unavailable)?;
    let ptr = window.ns_window().map_err(|_| unavailable())?;
    if ptr.is_null() {
        return Err(unavailable());
    }
    // SAFETY: Tauri owns this exact live NSWindow; use only on AppKit's main thread.
    let native = unsafe { &*ptr.cast::<NSWindow>() };
    let content = native.contentView().ok_or_else(unavailable)?;
    let inspect = || {
        let children = content.subviews();
        let mut count = 0;
        let mut expected = false;
        if children.count() > 256 {
            return Err(unavailable());
        }
        for i in 0..children.count() {
            let view = children.objectAtIndex(i);
            if view.tag() == 91_376_254 {
                count += 1;
                if let Some(effect) = view.downcast_ref::<NSVisualEffectView>() {
                    expected = effect.material().0 == 15
                        && effect.blendingMode().0 == 0
                        && effect.state().0 == 0;
                }
            }
        }
        Ok((count, expected))
    };
    let (count, expected) = inspect()?;
    if session.material_owned.load(Ordering::Acquire) {
        return if count == 1 && expected {
            Ok(true)
        } else {
            Err(unavailable())
        };
    }
    if count != 0 || !apply {
        return Err(unavailable());
    }
    apply_vibrancy(
        window,
        NSVisualEffectMaterial::FullScreenUI,
        Some(NSVisualEffectState::FollowsWindowActiveState),
        None,
    )
    .map_err(|_| unavailable())?;
    let (count, expected) = inspect()?;
    if count != 1 || !expected {
        return Err(unavailable());
    }
    session.material_owned.store(true, Ordering::Release);
    Ok(true)
}
pub(crate) fn committed(app: &AppHandle, raw: &str) {
    let Ok(runtime) = super::runtime(app) else {
        return;
    };
    let Some(session) = runtime.session.lock().clone() else {
        return;
    };
    let app = app.clone();
    let raw = raw.to_string();
    tauri::async_runtime::spawn(async move {
        let _ = refresh(&app, &session, Some(&raw), true).await;
    });
}
pub(super) fn theme_changed(app: &AppHandle, id: &str) {
    let Ok(runtime) = super::runtime(app) else {
        return;
    };
    let Some(session) = runtime.session.lock().clone().filter(|s| s.id == id) else {
        return;
    };
    if session.appearance_config.lock().is_none() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = refresh(&app, &session, None, false).await;
    });
}

// A getter waits only for the existing initialization, never spawns another Native effect.
pub(super) async fn observed(session: &Session) -> Result<Appearance, UpdateCommandError> {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let changed = session.appearance_changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if !session.alive.load(Ordering::Acquire) {
                return Err(unavailable());
            }
            if let Some(value) = session.appearance_value.lock().clone() {
                return Ok(value);
            }
            if let Some(error) = session.appearance_error.lock().clone() {
                return Err(error);
            }
            changed.await;
        }
    })
    .await
    .map_err(|_| unavailable())?
}
