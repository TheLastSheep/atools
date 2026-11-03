use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};

use super::super::transaction::ServiceStatus;
use super::super::{RECOVERY_FAILED, UNAVAILABLE};
use super::configuration::{FileIdentity, ValidatedConfiguration};
use super::migration::Choice;

pub(super) const MAX_JOURNAL_BYTES: usize = 4_096;
const MAX_CONFIGURATION_BYTES: u64 = 16 * 1024;
const JOURNAL_SCHEMA_VERSION: u32 = 1;
#[cfg(unix)]
const NANOS_PER_SECOND: i64 = 1_000_000_000;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum JournalPhase {
    Prepared,
    LegacyStaged,
    ModernVerified,
    ForwardCommitted,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Journal {
    pub(super) schema_version: u32,
    pub(super) choice: Choice,
    pub(super) modern_before_raw: i64,
    pub(super) phase: JournalPhase,
    pub(super) configuration_identity: FileIdentity,
    pub(super) configuration_sha256: String,
    pub(super) executable: PathBuf,
}

impl Journal {
    pub(super) fn prepared(
        configuration: &ValidatedConfiguration,
        choice: Choice,
        status: ServiceStatus,
    ) -> Result<Self, &'static str> {
        let modern_before_raw = match status {
            ServiceStatus::NotRegistered => 0,
            ServiceStatus::Enabled => 1,
            ServiceStatus::NotFound => 3,
            ServiceStatus::RequiresApproval | ServiceStatus::Unknown(_) => return Err(UNAVAILABLE),
        };
        if !valid_file_identity(&configuration.identity)
            || configuration.bytes.is_empty()
            || configuration.bytes.len() as u64 != configuration.identity.length
            || configuration.bytes.len() as u64 > MAX_CONFIGURATION_BYTES
            || !valid_sha256(&configuration.sha256)
            || sha256(&configuration.bytes) != configuration.sha256
            || !valid_executable(&configuration.executable)
        {
            return Err(UNAVAILABLE);
        }

        Ok(Self {
            schema_version: JOURNAL_SCHEMA_VERSION,
            choice,
            modern_before_raw,
            phase: JournalPhase::Prepared,
            configuration_identity: configuration.identity.clone(),
            configuration_sha256: configuration.sha256.clone(),
            executable: configuration.executable.clone(),
        })
    }

    pub(super) fn encode(&self) -> Result<Vec<u8>, &'static str> {
        validate_journal(self, &self.executable).map_err(|_| RECOVERY_FAILED)?;
        let bytes = serde_json::to_vec(self).map_err(|_| RECOVERY_FAILED)?;
        if bytes.is_empty() || bytes.len() > MAX_JOURNAL_BYTES {
            return Err(RECOVERY_FAILED);
        }
        Ok(bytes)
    }

    pub(super) fn decode(bytes: &[u8], expected_executable: &Path) -> Result<Self, &'static str> {
        if bytes.is_empty() || bytes.len() > MAX_JOURNAL_BYTES {
            return Err(RECOVERY_FAILED);
        }
        let journal: Self = serde_json::from_slice(bytes).map_err(|_| RECOVERY_FAILED)?;
        validate_journal(&journal, expected_executable).map_err(|_| RECOVERY_FAILED)?;
        Ok(journal)
    }
}

fn validate_journal(journal: &Journal, expected_executable: &Path) -> Result<(), ()> {
    if journal.schema_version != JOURNAL_SCHEMA_VERSION
        || !matches!(journal.modern_before_raw, 0 | 1 | 3)
        || !valid_file_identity(&journal.configuration_identity)
        || !valid_sha256(&journal.configuration_sha256)
        || !valid_executable(expected_executable)
        || journal.executable.as_os_str() != expected_executable.as_os_str()
    {
        return Err(());
    }
    Ok(())
}

fn valid_file_identity(identity: &FileIdentity) -> bool {
    #[cfg(unix)]
    {
        identity.device > 0
            && identity.inode > 0
            && identity.uid == unsafe { libc::getuid() }
            && identity.length > 0
            && identity.length <= MAX_CONFIGURATION_BYTES
            && identity.mode & libc::S_IFMT as u32 == libc::S_IFREG as u32
            && identity.mode & 0o7000 == 0
            && identity.mode & 0o022 == 0
            && identity.mode & 0o400 != 0
            && (0..NANOS_PER_SECOND).contains(&identity.mtime_nanoseconds)
            && (0..NANOS_PER_SECOND).contains(&identity.ctime_nanoseconds)
    }
    #[cfg(not(unix))]
    {
        let _ = identity;
        false
    }
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn valid_executable(path: &Path) -> bool {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return false;
    }
    let Ok(canonical) = path.canonicalize() else {
        return false;
    };
    if canonical.as_os_str() != path.as_os_str() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match std::fs::symlink_metadata(path) {
            Ok(metadata) => {
                metadata.is_file()
                    && !metadata.file_type().is_symlink()
                    && metadata.permissions().mode() & 0o111 != 0
            }
            Err(_) => false,
        }
    }
    #[cfg(not(unix))]
    {
        false
    }
}

#[cfg(all(test, unix))]
#[path = "journal_tests.rs"]
mod tests;
