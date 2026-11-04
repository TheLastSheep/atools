//! Native listener ownership, separate from the authoritative Main binding registry.
#[cfg(not(target_os = "macos"))]
use super::{double_tap::Modifier, main_dispatch::Token};
#[cfg(not(target_os = "macos"))]
use std::sync::Arc;
#[cfg(not(target_os = "macos"))]
use tauri::AppHandle;

pub(super) enum CreateFailure {
    Clean(String),
    Owned(Lease),
}

pub(super) const PERMISSION_REQUIRED: &str = "SETTINGS_HOTKEY_LISTEN_PERMISSION_REQUIRED";
#[cfg(any(test, not(target_os = "macos")))]
pub(super) const UNSUPPORTED: &str = "SETTINGS_HOTKEY_DOUBLE_TAP_UNSUPPORTED";
#[cfg(target_os = "macos")]
#[path = "double_tap_macos.rs"]
mod platform;
#[cfg(target_os = "macos")]
pub(super) use platform::{create, healthy, preflight, recover, release, suspend, Lease};

#[cfg(not(target_os = "macos"))]
#[derive(Clone, Copy)]
pub(super) struct Lease;
#[cfg(not(target_os = "macos"))]
pub(super) fn preflight() -> Result<(), String> {
    Err(UNSUPPORTED.into())
}
#[cfg(not(target_os = "macos"))]
pub(super) fn create(_: &AppHandle, _: Modifier, _: Arc<Token>) -> Result<Lease, CreateFailure> {
    Err(CreateFailure::Clean(UNSUPPORTED.into()))
}
#[cfg(not(target_os = "macos"))]
pub(super) fn healthy(_: &AppHandle, _: Lease) -> Result<bool, String> {
    Ok(false)
}
#[cfg(not(target_os = "macos"))]
pub(super) fn release(_: &AppHandle, _: Lease) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(super) fn recover(_: &AppHandle, _: Lease) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[cfg(not(target_os = "macos"))]
pub(super) fn suspend(_: &AppHandle, _: Lease) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}
