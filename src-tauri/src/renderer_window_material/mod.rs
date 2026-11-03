mod policy;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

use std::path::Path;

use policy::{Ownership, ThemePreference};
use serde_json::Value;
use tauri::{AppHandle, Manager, Theme};

const ORIGINAL_APP_IDENTIFIER: &str = "dev.atools.desktop";
#[cfg(feature = "legacy-node-smoke")]
const SETTINGS_INPUT_IDENTIFIER_PREFIX: &str = "dev.atools.renderer-settings-input.";
// This is the exact `frontendDist` path in tauri.ztools-renderer.conf.json.
const ORIGINAL_FRONTEND_DIST: &str = "../packages/ztools-renderer/dist";

#[derive(Default)]
pub(crate) struct RendererWindowMaterial {
    pub(super) ownership: parking_lot::Mutex<Ownership>,
}

/// Installs the manager in all launch modes. Native appearance is claimed only
/// for the bundled original Main renderer, never for a dev URL or Svelte dist.
pub(crate) fn install_configured(app: &AppHandle, raw_general: Option<&str>) -> Result<(), String> {
    let _state = ensure_manager(app)?;
    if !is_configured_original_main(app) {
        return Ok(());
    }
    _state.ownership.lock().ensure_open()?;

    #[cfg(target_os = "macos")]
    macos::require_main_thread()?;
    apply_main_theme(app, ThemePreference::from_general_json(raw_general))?;
    #[cfg(target_os = "macos")]
    macos::claim_main_owner(app, &_state)?;
    Ok(())
}

/// Fixture-only entrypoint. Its caller must first validate the isolated Profile
/// and load its original renderer assets; renderer-controlled inputs never reach it.
#[cfg(feature = "legacy-node-smoke")]
pub(crate) fn install_original_fixture(
    app: &AppHandle,
    raw_general: Option<&str>,
) -> Result<(), String> {
    let _state = ensure_manager(app)?;
    if !is_settings_input_fixture(app)
        && !crate::renderer_desktop_smoke::manual_ui::authorizes_material(app)
        && !crate::renderer_desktop_smoke::updater_journey::about_authorized(app)
    {
        return Err("Original renderer fixture identity is invalid".into());
    }
    _state.ownership.lock().ensure_open()?;
    #[cfg(target_os = "macos")]
    macos::require_main_thread()?;
    apply_main_theme(app, ThemePreference::from_general_json(raw_general))?;
    #[cfg(target_os = "macos")]
    macos::claim_main_owner(app, &_state)?;
    Ok(())
}

pub(crate) async fn acquire_settings(app: &AppHandle) -> Result<MaterialLease, String> {
    ensure_manager(app)?;
    #[cfg(target_os = "macos")]
    {
        return macos::acquire_settings(app).await;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let state = app
            .try_state::<RendererWindowMaterial>()
            .ok_or_else(|| "Native window material manager is unavailable".to_owned())?;
        let mut ownership = state.ownership.lock();
        let lease_id = ownership.reserve_lease_id()?;
        ownership.add_settings_lease(lease_id)?;
        Ok(MaterialLease {
            app: app.clone(),
            lease_id,
            active: true,
        })
    }
}

pub(crate) fn acquire_settings_on_window_main(
    app: &AppHandle,
    window: &tauri::Window,
) -> Result<MaterialLease, String> {
    ensure_manager(app)?;
    #[cfg(target_os = "macos")]
    {
        macos::acquire_settings_for_window_on_main(app, window)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        let state = app
            .try_state::<RendererWindowMaterial>()
            .ok_or("Native window material manager is unavailable")?;
        let mut ownership = state.ownership.lock();
        let lease_id = ownership.reserve_lease_id()?;
        ownership.add_settings_lease(lease_id)?;
        Ok(MaterialLease {
            app: app.clone(),
            lease_id,
            active: true,
        })
    }
}

pub(crate) async fn observe(app: &AppHandle) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        return macos::observe(app).await;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Native window material observation is supported only on macOS".into())
    }
}

pub(crate) fn stop(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return macos::stop(app);
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(state) = app.try_state::<RendererWindowMaterial>() {
            let mut ownership = state.ownership.lock();
            ownership.begin_stop();
            ownership.mark_effect_cleared();
        }
        Ok(())
    }
}

pub(crate) fn on_window_destroyed(app: &AppHandle, label: &str) {
    if label != "main" {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        macos::on_window_destroyed(app);
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(state) = app.try_state::<RendererWindowMaterial>() {
        state.ownership.lock().forget_destroyed_window();
    }
}

pub(crate) struct MaterialLease {
    app: AppHandle,
    #[cfg(target_os = "macos")]
    window: tauri::Window,
    lease_id: u64,
    active: bool,
}

#[derive(Clone)]
pub(crate) struct MaterialReleaseToken {
    app: AppHandle,
    #[cfg(target_os = "macos")]
    window: tauri::Window,
    lease_id: u64,
}

impl MaterialLease {
    pub(crate) fn release_token(&self) -> MaterialReleaseToken {
        MaterialReleaseToken {
            app: self.app.clone(),
            #[cfg(target_os = "macos")]
            window: self.window.clone(),
            lease_id: self.lease_id,
        }
    }

    pub(crate) async fn release(mut self) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            let result =
                macos::release_settings(self.app.clone(), self.window.clone(), self.lease_id).await;
            if result.is_ok() {
                self.active = false;
            }
            return result;
        }
        #[cfg(not(target_os = "macos"))]
        {
            if let Some(state) = self.app.try_state::<RendererWindowMaterial>() {
                state.ownership.lock().remove_settings_lease(self.lease_id);
            }
            self.active = false;
            Ok(())
        }
    }

    #[cfg(target_os = "macos")]
    pub(super) fn disarm(&mut self) {
        self.active = false;
    }
}

impl MaterialReleaseToken {
    /// Retries release of this exact Settings lease. The token does not own or
    /// implicitly release the lease, so callers can retain it after errors.
    pub(crate) async fn release(&self) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            return macos::release_settings(self.app.clone(), self.window.clone(), self.lease_id)
                .await;
        }
        #[cfg(not(target_os = "macos"))]
        {
            if let Some(state) = self.app.try_state::<RendererWindowMaterial>() {
                state.ownership.lock().remove_settings_lease(self.lease_id);
            }
            Ok(())
        }
    }
}

impl Drop for MaterialLease {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        #[cfg(target_os = "macos")]
        macos::enqueue_release(self.app.clone(), self.window.clone(), self.lease_id);
        #[cfg(not(target_os = "macos"))]
        {
            if let Some(state) = self.app.try_state::<RendererWindowMaterial>() {
                state.ownership.lock().remove_settings_lease(self.lease_id);
            }
            self.active = false;
        }
    }
}

fn ensure_manager(app: &AppHandle) -> Result<tauri::State<'_, RendererWindowMaterial>, String> {
    if app.try_state::<RendererWindowMaterial>().is_none() {
        let _ = app.manage(RendererWindowMaterial::default());
    }
    app.try_state::<RendererWindowMaterial>()
        .ok_or_else(|| "Native window material manager is unavailable".into())
}

fn is_configured_original_main(app: &AppHandle) -> bool {
    let config = app.config();
    let main_transparent = config
        .app
        .windows
        .iter()
        .any(|window| window.label == "main" && window.transparent);
    is_original_config(
        &config.identifier,
        config.build.dev_url.is_some(),
        config.build.frontend_dist.as_ref(),
        main_transparent,
    )
}

fn is_original_config(
    identifier: &str,
    has_dev_url: bool,
    frontend_dist: Option<&tauri::utils::config::FrontendDist>,
    main_transparent: bool,
) -> bool {
    identifier == ORIGINAL_APP_IDENTIFIER
        && !has_dev_url
        && main_transparent
        && matches!(
            frontend_dist,
            Some(tauri::utils::config::FrontendDist::Directory(path))
                if path == Path::new(ORIGINAL_FRONTEND_DIST)
        )
}

#[cfg(feature = "legacy-node-smoke")]
fn is_settings_input_fixture(app: &AppHandle) -> bool {
    let config = app.config();
    let Some(run_id) = config
        .identifier
        .strip_prefix(SETTINGS_INPUT_IDENTIFIER_PREFIX)
    else {
        return false;
    };
    config.build.dev_url.is_none()
        && valid_run_id(run_id)
        && config
            .app
            .windows
            .iter()
            .any(|window| window.label == "main" && window.transparent)
}

#[cfg(feature = "legacy-node-smoke")]
fn valid_run_id(run_id: &str) -> bool {
    run_id.len() == 32
        && run_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn apply_main_theme(app: &AppHandle, theme: ThemePreference) -> Result<(), String> {
    let window = crate::window::main_window(app)
        .map_err(|_| "Original Main window is unavailable for theme application".to_owned())?;
    let theme = match theme {
        ThemePreference::System => None,
        ThemePreference::Light => Some(Theme::Light),
        ThemePreference::Dark => Some(Theme::Dark),
    };
    window
        .set_theme(theme)
        .map_err(|_| "Original Main window theme could not be applied".to_owned())
}
