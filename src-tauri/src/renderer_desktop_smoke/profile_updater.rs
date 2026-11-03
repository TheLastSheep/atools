//! Explicit, isolated selection for the finite updater runtime journey.
use std::path::Path;

pub(super) fn validate(enabled: bool, root: &Path, id: &str, clear: &str) -> Result<(), String> {
    if !enabled {
        return Ok(());
    }
    if !cfg!(all(
        target_os = "macos",
        feature = "legacy-node-smoke",
        feature = "ztools-multiwebview"
    )) {
        return Err(
            "updater journey requires macOS and legacy-node-smoke,ztools-multiwebview".into(),
        );
    }
    if clear != "never"
        || root != Path::new("/private/tmp").join(format!("atools-renderer-updater-{id}"))
    {
        return Err(
            "updater journey requires never auto-clear and its exact private run root".into(),
        );
    }
    Ok(())
}

#[cfg(test)]
#[path = "profile_updater_tests.rs"]
mod tests;

pub(super) fn about_mode(value: Option<&str>, updater: bool) -> Result<bool, String> {
    if value.is_some() && !updater {
        return Err("updater-mode requires --journey updater".into());
    }
    match value {
        None | Some("popup") => Ok(false),
        Some("about") => Ok(true),
        _ => Err("updater-mode must be popup or about".into()),
    }
}

#[cfg(test)]
mod mode_tests {
    #[test]
    fn default_popup_and_about_are_explicit_mutually_exclusive() {
        assert!(!super::about_mode(None, true).unwrap());
        assert!(!super::about_mode(Some("popup"), true).unwrap());
        assert!(super::about_mode(Some("about"), true).unwrap());
        for value in ["about", "popup", "unknown", ""] {
            assert!(super::about_mode(Some(value), false).is_err());
        }
        assert!(super::about_mode(Some("unknown"), true).is_err());
    }
}
