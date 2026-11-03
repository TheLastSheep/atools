//! Resource selection for the opt-in cross-renderer acceptance journey.
use super::{assets::RendererAssets, profile::Profile};
use serde_json::Value;
use std::path::Path;

pub(super) fn enabled(profile: &Profile) -> bool {
    profile.settings_input_journey
        && !profile.builtin_state_journey
        && !profile.main_hotkey_recovery_first
        && !profile.main_hotkey_recovery_second
}

pub(super) fn add_assets(
    assets: &mut RendererAssets,
    profile: &Profile,
) -> Result<Option<Value>, String> {
    if !enabled(profile) {
        return Ok(None);
    }
    if profile.identifier != format!("dev.atools.renderer-settings-input.{}", profile.run_id) {
        return Err("Fallback settings resources require the isolated settings-input app".into());
    }
    let executable = std::env::current_exe()
        .map_err(|_| "Cannot resolve the isolated settings-input executable")?;
    let macos = executable
        .parent()
        .filter(|path| path.file_name() == Some(std::ffi::OsStr::new("MacOS")))
        .ok_or("Fallback settings resources require an app bundle executable")?;
    let contents = macos
        .parent()
        .filter(|path| path.file_name() == Some(std::ffi::OsStr::new("Contents")))
        .ok_or("Fallback settings resources require an app bundle Contents directory")?;
    if contents.parent().and_then(Path::extension) != Some(std::ffi::OsStr::new("app")) {
        return Err("Fallback settings resources require an app bundle".into());
    }
    let resource_root = contents.join("Resources/atools-fallback-settings-qa");
    assets.add_fallback_settings(&resource_root).map(Some)
}
