//! Production-only bridge to the fixed legacy login-item migration host.
use tauri::AppHandle;

#[cfg(any(target_os = "macos", test))]
use super::spec;
#[cfg(target_os = "macos")]
use super::{legacy::host, service::MainAppService};
use super::{with_os_operation, LegacyLoginChoice, LegacyLoginInspection, UNSUPPORTED};
#[cfg(any(target_os = "macos", test))]
use super::{APPROVAL_REQUIRED, CONFLICT, LEGACY_CONFIGURATION, RECOVERY_FAILED, UNAVAILABLE};

pub(crate) fn inspect_legacy_launch_at_login(
    app: &AppHandle,
) -> Result<LegacyLoginInspection, String> {
    #[cfg(target_os = "macos")]
    {
        with_os_operation(|| {
            require_production_bundle(app)?;
            let paths = host::production_paths().map_err(map_error)?;
            let mut modern = MainAppService;
            let inspection = host::inspect(&paths, &mut modern).map_err(map_error)?;
            if !super::valid_legacy_revision(&inspection.revision) {
                return Err(UNAVAILABLE.to_owned());
            }
            Ok(inspection)
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(UNSUPPORTED.to_owned())
    }
}

pub(crate) fn resolve_legacy_launch_at_login(
    app: &AppHandle,
    choice: LegacyLoginChoice,
    expected_modern: bool,
    revision: &str,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        if !super::valid_legacy_revision(revision) {
            return Err(CONFLICT.to_owned());
        }
        with_os_operation(|| {
            require_production_bundle(app)?;
            let paths = host::production_paths().map_err(map_error)?;
            let mut modern = MainAppService;
            host::resolve(&paths, &mut modern, choice, expected_modern, revision).map_err(map_error)
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, choice, expected_modern, revision);
        Err(UNSUPPORTED.to_owned())
    }
}

pub(crate) fn recover_for_startup(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        with_os_operation(|| {
            require_production_bundle(app)?;
            recover_locked()
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(UNSUPPORTED.to_owned())
    }
}

/// Called only when the caller already holds the login-item OS-operation lock
/// and has validated the configured and running production bundle identities.
pub(super) fn recover_locked() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let paths = host::production_paths().map_err(map_error)?;
        let mut modern = MainAppService;
        host::recover_existing(&paths, &mut modern).map_err(map_error)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(UNSUPPORTED.to_owned())
    }
}

#[cfg(any(target_os = "macos", test))]
fn production_scope_matches(configured_identifier: &str, bundle_matches: bool) -> bool {
    spec::production_bundle_matches(configured_identifier, bundle_matches)
}

#[cfg(target_os = "macos")]
fn require_production_bundle(app: &AppHandle) -> Result<(), String> {
    let configured = app.config().identifier.as_str();
    let bundle_matches = super::service::current_bundle_identifier_matches(configured);
    if production_scope_matches(configured, bundle_matches) {
        Ok(())
    } else {
        Err(UNAVAILABLE.to_owned())
    }
}

#[cfg(any(target_os = "macos", test))]
fn map_error(error: &'static str) -> String {
    match error {
        APPROVAL_REQUIRED | CONFLICT | LEGACY_CONFIGURATION | RECOVERY_FAILED | UNSUPPORTED
        | UNAVAILABLE => error.to_owned(),
        _ => UNAVAILABLE.to_owned(),
    }
}

#[cfg(test)]
#[path = "production_legacy_tests.rs"]
mod tests;
