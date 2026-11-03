//! Closed height cases and owned R68 profile identity, without arbitrary seed paths.
use super::Profile;
use std::{fs, os::unix::fs::MetadataExt, path::Path};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HeightCase {
    A,
    B,
    C,
    D,
}
impl HeightCase {
    pub(super) fn parse(
        value: Option<&str>,
        journey: Option<&str>,
    ) -> Result<Option<Self>, String> {
        if journey != Some("settings-height") {
            return if value.is_none() {
                Ok(None)
            } else {
                Err("height-case requires settings-height journey".into())
            };
        }
        if !cfg!(all(
            feature = "legacy-node-smoke",
            feature = "ztools-multiwebview"
        )) {
            return Err(
                "settings-height requires --features legacy-node-smoke,ztools-multiwebview".into(),
            );
        }
        match value {
            Some("a") => Ok(Some(Self::A)),
            Some("b") => Ok(Some(Self::B)),
            Some("c") => Ok(Some(Self::C)),
            Some("d") => Ok(Some(Self::D)),
            _ => Err("settings-height requires height-case a, b, c, or d".into()),
        }
    }
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::A => "a",
            Self::B => "b",
            Self::C => "c",
            Self::D => "d",
        }
    }
    pub(crate) fn desired(self) -> f64 {
        match self {
            Self::A => 542.0,
            Self::B => 200.5,
            Self::C => 541.0,
            Self::D => 2001.0,
        }
    }
    pub(crate) fn target(self) -> Option<f64> {
        match self {
            Self::A => Some(200.5),
            Self::B => Some(541.0),
            Self::C => Some(2001.0),
            Self::D => None,
        }
    }
    pub(crate) fn stages(self) -> &'static [&'static str] {
        if self == Self::D {
            &["initial-open", "initial-closed"]
        } else {
            &[
                "initial-open",
                "patch-committed",
                "after-write-observed",
                "initial-closed",
                "reopened",
                "reopened-closed",
            ]
        }
    }
}

pub(super) fn validate_paths(
    root: &Path,
    output: &Path,
    run_id: &str,
    auto_clear: &str,
) -> Result<(), String> {
    let expected = Path::new("/private/tmp").join(format!("atools-renderer-smoke-{run_id}"));
    if root != expected || output != root.join("report.json") || auto_clear != "never" {
        return Err("settings-height requires its fixed private root, root/report.json, and --auto-clear never".into());
    }
    Ok(())
}

impl Profile {
    pub(crate) fn validate_settings_height_fixture(&self) -> Result<(), String> {
        validate_paths(&self.root, &self.output, &self.run_id, &self.auto_clear)?;
        if self.settings_height_case.is_none()
            || self.manual_ui
            || self.settings_journey
            || self.settings_input_journey
            || self.launcher_journey
            || self.launch_return_journey
            || self.catalog_journey
            || self.clipboard_context_journey
            || self.main_panel_journey
            || self.builtin_state_seed
            || self.builtin_state_journey
            || self.identifier != self.expected_identifier()
        {
            return Err("settings-height profile scope rejected".into());
        }
        super::super::fixture_owner::verify(self).map_err(str::to_owned)?;
        for (path, mode) in [
            (&self.root, 0o700),
            (&self.root.join(".atools-renderer-smoke-owner.json"), 0o600),
        ] {
            let info = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
            if info.uid() != unsafe { libc::geteuid() } || info.mode() & 0o777 != mode {
                return Err("settings-height owner permissions rejected".into());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "profile_height_tests.rs"]
mod tests;
