//! Production-facing host facade for the fixed legacy login-item transaction.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;

use super::super::transaction::{known_state, ServicePort, ServiceStatus};
use super::super::{valid_legacy_revision, CONFLICT, RECOVERY_FAILED, UNAVAILABLE};
pub(in crate::general_settings_runtime::login_items) use super::super::{
    LegacyLoginChoice, LegacyLoginInspection,
};
use super::{
    configuration::{self, ValidatedConfiguration},
    durable::DurableLegacy,
    host_paths::{self, HostPaths},
    migration::{self, Choice, LegacyPort},
    recovery,
};

const LEGACY_LABEL: &str = "com.atools.desktop";

pub(in crate::general_settings_runtime::login_items) fn production_paths(
) -> Result<HostPaths, &'static str> {
    host_paths::production_paths()
}

/// Repairs only an already-persisted transaction. It never chooses or starts a
/// migration, and it does not query SMAppService when no recovery artifact exists.
pub(in crate::general_settings_runtime::login_items) fn recover_existing<P: ServicePort>(
    paths: &HostPaths,
    modern: &mut P,
) -> Result<(), &'static str> {
    if !paths.has_recovery_artifacts()? {
        return Ok(());
    }
    let mut legacy = DurableLegacy::resume(&paths.source, &paths.executable, &paths.recovery)
        .map_err(|_| RECOVERY_FAILED)?;
    let Some(legacy) = legacy.as_mut() else {
        return Ok(());
    };
    recovery::recover(modern, legacy)
        .map(|_| ())
        .map_err(|_| RECOVERY_FAILED)
}

pub(in crate::general_settings_runtime::login_items) fn inspect<P: ServicePort>(
    paths: &HostPaths,
    modern: &mut P,
) -> Result<LegacyLoginInspection, &'static str> {
    recover_existing(paths, modern)?;
    let configuration = inspect_configuration(paths)?;
    let status = modern.status().map_err(status_error)?;
    let modern_enabled = known_state(status)?;
    let revision = revision(&configuration, status)?;
    Ok(LegacyLoginInspection {
        modern_enabled,
        revision,
    })
}

pub(in crate::general_settings_runtime::login_items) fn resolve<P: ServicePort>(
    paths: &HostPaths,
    modern: &mut P,
    choice: LegacyLoginChoice,
    expected_modern: bool,
    expected_revision: &str,
) -> Result<bool, &'static str> {
    recover_existing(paths, modern)?;
    if !valid_legacy_revision(expected_revision) {
        return Err(CONFLICT);
    }
    let configuration = inspect_configuration(paths)?;
    let status = modern.status().map_err(status_error)?;
    let current = known_state(status)?;
    if current != expected_modern || revision(&configuration, status)? != expected_revision {
        return Err(CONFLICT);
    }

    paths.ensure_recovery_directory()?;
    let mut legacy = DurableLegacy::open(configuration, &paths.recovery).map_err(map_open_error)?;
    migration::resolve(
        modern,
        &mut legacy,
        expected_modern,
        migration_choice(choice),
    )
}

fn inspect_configuration(paths: &HostPaths) -> Result<ValidatedConfiguration, &'static str> {
    configuration::inspect(&paths.source, LEGACY_LABEL, &paths.executable)
        .map_err(|_| UNAVAILABLE)?
        .ok_or(CONFLICT)
}

fn revision(
    configuration: &ValidatedConfiguration,
    status: ServiceStatus,
) -> Result<String, &'static str> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct RevisionMaterial<'a> {
        source: &'a Path,
        identity: &'a configuration::FileIdentity,
        configuration_sha256: &'a str,
        executable: &'a Path,
        modern_status: i64,
    }

    let modern_status = match status {
        ServiceStatus::NotRegistered => 0,
        ServiceStatus::Enabled => 1,
        ServiceStatus::NotFound => 3,
        ServiceStatus::RequiresApproval | ServiceStatus::Unknown(_) => {
            return Err(status_error(UNAVAILABLE))
        }
    };
    let material = RevisionMaterial {
        source: &configuration.source,
        identity: &configuration.identity,
        configuration_sha256: &configuration.sha256,
        executable: &configuration.executable,
        modern_status,
    };
    let bytes = serde_json::to_vec(&material).map_err(|_| UNAVAILABLE)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn migration_choice(choice: LegacyLoginChoice) -> Choice {
    if choice.target_enabled() {
        Choice::Migrate
    } else {
        Choice::TurnOff
    }
}

fn status_error(error: &'static str) -> &'static str {
    if error == super::super::APPROVAL_REQUIRED {
        super::super::APPROVAL_REQUIRED
    } else {
        UNAVAILABLE
    }
}

fn map_open_error(error: &'static str) -> &'static str {
    if error == UNAVAILABLE {
        UNAVAILABLE
    } else {
        RECOVERY_FAILED
    }
}

#[cfg(test)]
#[path = "host_tests.rs"]
mod tests;
