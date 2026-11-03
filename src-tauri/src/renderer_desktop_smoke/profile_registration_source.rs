use super::{LaunchTargetKind, Profile};
use std::{fs, os::unix::fs::MetadataExt, path::Path};

/// Source of local-shortcut records used by the launch-return fixture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistrationSource {
    CoreSeed,
    SettingsChild,
}

impl RegistrationSource {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::CoreSeed => "core-seed",
            Self::SettingsChild => "settings-child",
        }
    }

    pub(super) fn parse(
        value: Option<&str>,
        launch_return: bool,
        target: LaunchTargetKind,
    ) -> Result<Self, String> {
        let source = match value {
            None | Some("core-seed") => Self::CoreSeed,
            Some("settings-child") => Self::SettingsChild,
            Some(_) => return Err("registration-source must be core-seed or settings-child".into()),
        };
        if value.is_some() && !launch_return {
            return Err("registration-source requires --journey launch-return".into());
        }
        if source == Self::SettingsChild && target != LaunchTargetKind::LocalShortcut {
            return Err(
                "settings-child registration-source requires local-shortcut target-kind".into(),
            );
        }
        Ok(source)
    }
}

impl Profile {
    pub(crate) fn expected_identifier(&self) -> String {
        format!("dev.atools.renderer-smoke.{}", self.run_id)
    }

    /// Restrict the test-only hidden policy and drop injector to the same owned fixture.
    pub(crate) fn validate_settings_child_fixture(&self) -> Result<(), String> {
        let run_id_valid = uuid::Uuid::parse_str(&self.run_id)
            .is_ok_and(|id| id.get_version_num() == 4 && id.simple().to_string() == self.run_id);
        let expected_root = Path::new("/private/tmp")
            .join(format!("atools-renderer-launch-return-{}", self.run_id));
        if !run_id_valid
            || !self.launch_return_journey
            || self.launch_target_kind != LaunchTargetKind::LocalShortcut
            || self.registration_source != RegistrationSource::SettingsChild
            || self.root.as_os_str() != expected_root.as_os_str()
            || self.identifier != self.expected_identifier()
        {
            return Err("settings-registration-fixture-owner-rejected".into());
        }
        let root = fs::symlink_metadata(&self.root)
            .map_err(|_| "settings-registration-fixture-owner-rejected")?;
        let marker = fs::symlink_metadata(self.root.join(".atools-renderer-smoke-owner.json"))
            .map_err(|_| "settings-registration-fixture-owner-rejected")?;
        let uid = unsafe { libc::geteuid() };
        if !root.file_type().is_dir()
            || root.uid() != uid
            || root.mode() & 0o777 != 0o700
            || !marker.file_type().is_file()
            || marker.uid() != uid
            || marker.mode() & 0o777 != 0o600
        {
            return Err("settings-registration-fixture-owner-rejected".into());
        }
        super::super::fixture_owner::verify(self)
            .map_err(|_| "settings-registration-fixture-owner-rejected".into())
    }
}

#[cfg(test)]
#[path = "profile_registration_source_tests.rs"]
mod tests;
