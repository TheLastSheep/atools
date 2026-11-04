//! Durable, fixed-path adapter for the legacy login-item transaction.
use std::path::{Path, PathBuf};

use super::super::{RECOVERY_FAILED, UNAVAILABLE};
use super::configuration::{self, ValidatedConfiguration};
#[cfg(test)]
use super::durable_io::SOURCE_NAME;
use super::durable_io::{validate_executable, validate_source_path, Directory, Lock};
use super::journal::{Journal, JournalPhase};

#[path = "durable_journal.rs"]
mod durable_journal;
#[path = "durable_port.rs"]
mod durable_port;
#[path = "durable_resume.rs"]
mod durable_resume;

const LABEL: &str = "com.atools.desktop";
const BACKUP_NAME: &str = "legacy-login-item.plist";
const MAX_CONFIGURATION_BYTES: u64 = 16 * 1024;

const SOURCE_C: &std::ffi::CStr = c"com.atools.desktop.plist";
const BACKUP_C: &std::ffi::CStr = c"legacy-login-item.plist";

/// Owns pinned source/recovery directories and the advisory transaction lock.
/// It never performs OS login-item operations; the caller supplies the observed
/// modern state to the pure migration policy.
pub(super) struct DurableLegacy {
    source_path: PathBuf,
    executable: PathBuf,
    source_directory: Directory,
    recovery_directory: Directory,
    _lock: Lock,
    snapshot: Option<ValidatedConfiguration>,
    journal: Option<Journal>,
    requires_reopen: bool,
    #[cfg(test)]
    fail_commit_at: Option<CommitFailpoint>,
    #[cfg(test)]
    journal_publication_failpoint: Option<JournalPublicationFailpoint>,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CommitFailpoint {
    AfterForwardCommit,
    AfterBackupRemoval,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum JournalPublicationFailpoint {
    InitialPrepared,
    Replacement,
}

impl DurableLegacy {
    /// Opens a fresh fixed-name transaction without writing a journal.
    /// `prepare` is called only after the migration policy checks modern-state CAS.
    pub(super) fn open(
        configuration: ValidatedConfiguration,
        recovery_directory: &Path,
    ) -> Result<Self, &'static str> {
        validate_source_path(&configuration.source)?;
        validate_executable(&configuration.executable)?;
        let fresh =
            configuration::inspect(&configuration.source, LABEL, &configuration.executable)?
                .ok_or(UNAVAILABLE)?;
        if fresh.identity != configuration.identity
            || fresh.sha256 != configuration.sha256
            || fresh.bytes != configuration.bytes
        {
            return Err(UNAVAILABLE);
        }
        let (source_directory, recovery_directory_handle) =
            Directory::open_layout(&configuration.source, recovery_directory)?;
        let lock = recovery_directory_handle.lock()?;
        durable_journal::reject_existing(&recovery_directory_handle)?;
        Ok(Self {
            source_path: configuration.source.clone(),
            executable: configuration.executable.clone(),
            source_directory,
            recovery_directory: recovery_directory_handle,
            _lock: lock,
            snapshot: Some(configuration),
            journal: None,
            requires_reopen: false,
            #[cfg(test)]
            fail_commit_at: None,
            #[cfg(test)]
            journal_publication_failpoint: None,
        })
    }

    /// Reopens a durable transaction after process restart. It derives all file
    /// locations from the fixed source basename and journal, never from journal paths.
    pub(super) fn resume(
        source: &Path,
        expected_executable: &Path,
        recovery_directory: &Path,
    ) -> Result<Option<Self>, &'static str> {
        durable_resume::resume(source, expected_executable, recovery_directory)
    }

    pub(super) fn journal(&self) -> Option<&Journal> {
        self.journal.as_ref()
    }

    /// Returns true only when the source matches the recorded original bytes and
    /// rename-stable identity; actual absence is the only false result.
    pub(super) fn original_present(&self) -> Result<bool, &'static str> {
        self.candidate_present(false)
    }

    /// Returns true only when the staged backup matches the recorded original bytes
    /// and rename-stable identity; actual absence is the only false result.
    pub(super) fn backup_present(&self) -> Result<bool, &'static str> {
        self.candidate_present(true)
    }

    #[cfg(test)]
    pub(super) fn fail_commit_at_for_test(&mut self, point: CommitFailpoint) {
        self.fail_commit_at = Some(point);
    }

    #[cfg(test)]
    pub(super) fn fail_journal_publication_at_for_test(
        &mut self,
        point: JournalPublicationFailpoint,
    ) {
        self.journal_publication_failpoint = Some(point);
    }

    fn candidate_present(&self, backup: bool) -> Result<bool, &'static str> {
        match self.inspect_candidate(backup) {
            Ok(Some(_)) => Ok(true),
            Ok(None) => Ok(false),
            Err(_) => Err(RECOVERY_FAILED),
        }
    }

    fn inspect_candidate(
        &self,
        backup: bool,
    ) -> Result<Option<ValidatedConfiguration>, &'static str> {
        let (directory, name, path) = if backup {
            (
                &self.recovery_directory,
                BACKUP_C,
                self.recovery_directory.path().join(BACKUP_NAME),
            )
        } else {
            (&self.source_directory, SOURCE_C, self.source_path.clone())
        };
        let Some(anchored) = directory.read_child(name, MAX_CONFIGURATION_BYTES)? else {
            return Ok(None);
        };
        let inspected = configuration::inspect(&path, LABEL, &self.executable)
            .map_err(|_| RECOVERY_FAILED)?
            .ok_or(RECOVERY_FAILED)?;
        if inspected.identity != anchored.identity || inspected.bytes != anchored.bytes {
            return Err(RECOVERY_FAILED);
        }
        self.validate_record(&inspected, backup)?;
        Ok(Some(inspected))
    }

    fn validate_record(
        &self,
        candidate: &ValidatedConfiguration,
        _backup: bool,
    ) -> Result<(), &'static str> {
        let (identity, sha256, bytes) = match (&self.journal, &self.snapshot) {
            (Some(record), _) => (
                &record.configuration_identity,
                record.configuration_sha256.as_str(),
                self.snapshot.as_ref().map(|value| value.bytes.as_slice()),
            ),
            (None, Some(snapshot)) => (
                &snapshot.identity,
                snapshot.sha256.as_str(),
                Some(snapshot.bytes.as_slice()),
            ),
            (None, None) => return Err(RECOVERY_FAILED),
        };
        if !identity.preserved_metadata_after_rename(&candidate.identity)
            || candidate.sha256 != sha256
            || bytes.is_some_and(|bytes| bytes != candidate.bytes)
        {
            return Err(RECOVERY_FAILED);
        }
        Ok(())
    }

    fn snapshot_from_record(&self, bytes: Vec<u8>) -> ValidatedConfiguration {
        let record = self.journal.as_ref().expect("resume has a journal");
        ValidatedConfiguration {
            source: self.source_path.clone(),
            executable: self.executable.clone(),
            identity: record.configuration_identity.clone(),
            sha256: record.configuration_sha256.clone(),
            bytes,
        }
    }

    fn current_record_bytes(&self) -> Result<Vec<u8>, &'static str> {
        self.journal.as_ref().ok_or(RECOVERY_FAILED)?.encode()
    }

    fn ensure_lock_named(&mut self) -> Result<(), &'static str> {
        match self._lock.ensure_named(&self.recovery_directory) {
            Ok(()) => Ok(()),
            Err(_) => {
                self.requires_reopen = true;
                Err(RECOVERY_FAILED)
            }
        }
    }

    fn ensure_open_source_matches(&self) -> Result<(), &'static str> {
        let snapshot = self.snapshot.as_ref().ok_or(RECOVERY_FAILED)?;
        let current = self.inspect_candidate(false)?.ok_or(RECOVERY_FAILED)?;
        if current.identity != snapshot.identity
            || current.sha256 != snapshot.sha256
            || current.bytes != snapshot.bytes
        {
            return Err(RECOVERY_FAILED);
        }
        Ok(())
    }

    fn rename_source_to_backup(&mut self) -> Result<(), &'static str> {
        self.ensure_open_source_matches()?;
        self.ensure_lock_named()?;
        if self.recovery_directory.contains(BACKUP_C)? {
            return Err(RECOVERY_FAILED);
        }
        let snapshot = self.snapshot.as_ref().ok_or(RECOVERY_FAILED)?;
        let source = self
            .source_directory
            .read_child(SOURCE_C, MAX_CONFIGURATION_BYTES)?
            .ok_or(RECOVERY_FAILED)?;
        if source.identity != snapshot.identity || source.bytes != snapshot.bytes {
            return Err(RECOVERY_FAILED);
        }
        self.ensure_lock_named()?;
        self.source_directory.publish_exclusive(
            SOURCE_C,
            &self.recovery_directory,
            BACKUP_C,
            &source,
            MAX_CONFIGURATION_BYTES,
        )?;
        self.source_directory.sync()?;
        self.recovery_directory.sync()?;
        if self.original_present()? || !self.backup_present()? {
            return Err(RECOVERY_FAILED);
        }
        Ok(())
    }

    fn restore_backup_to_source(&mut self) -> Result<(), &'static str> {
        if self.original_present()? && !self.backup_present()? {
            return Ok(());
        }
        if self.original_present()? || !self.backup_present()? {
            return Err(RECOVERY_FAILED);
        }
        let backup = self.inspect_candidate(true)?.ok_or(RECOVERY_FAILED)?;
        let backup_contents = self
            .recovery_directory
            .read_child(BACKUP_C, MAX_CONFIGURATION_BYTES)?
            .ok_or(RECOVERY_FAILED)?;
        if backup_contents.identity != backup.identity || backup_contents.bytes != backup.bytes {
            return Err(RECOVERY_FAILED);
        }
        self.ensure_lock_named()?;
        self.recovery_directory.publish_exclusive(
            BACKUP_C,
            &self.source_directory,
            SOURCE_C,
            &backup_contents,
            MAX_CONFIGURATION_BYTES,
        )?;
        self.recovery_directory.sync()?;
        self.source_directory.sync()?;
        if !self.original_present()? || self.backup_present()? {
            return Err(RECOVERY_FAILED);
        }
        Ok(())
    }

    fn remove_backup(&mut self) -> Result<(), &'static str> {
        let backup = self.inspect_candidate(true)?.ok_or(RECOVERY_FAILED)?;
        let bytes = backup.bytes;
        self.ensure_lock_named()?;
        self.recovery_directory.remove_exact(
            BACKUP_C,
            &bytes,
            &backup.identity,
            MAX_CONFIGURATION_BYTES,
        )?;
        self.recovery_directory.sync()
    }

    fn is_forward_committed(&self) -> bool {
        self.journal
            .as_ref()
            .is_some_and(|journal| journal.phase == JournalPhase::ForwardCommitted)
    }

    #[cfg(test)]
    fn should_fail_commit_at(&mut self, point: CommitFailpoint) -> bool {
        if self.fail_commit_at == Some(point) {
            self.fail_commit_at = None;
            true
        } else {
            false
        }
    }

    #[cfg(test)]
    fn should_fail_journal_publication_at(&mut self, point: JournalPublicationFailpoint) -> bool {
        if self.journal_publication_failpoint == Some(point) {
            self.journal_publication_failpoint = None;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
#[path = "durable_tests.rs"]
mod tests;
