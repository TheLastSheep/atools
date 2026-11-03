//! Restart recovery for journal records and interrupted journal publication.
use std::path::Path;

use super::super::durable_io::{validate_executable, validate_source_path, Directory};
use super::super::journal::{Journal, JournalPhase};
use super::durable_journal;
use super::{DurableLegacy, BACKUP_C, RECOVERY_FAILED};

pub(super) fn resume(
    source: &Path,
    expected_executable: &Path,
    recovery_path: &Path,
) -> Result<Option<DurableLegacy>, &'static str> {
    validate_source_path(source)?;
    validate_executable(expected_executable)?;
    let (source_directory, recovery_directory) = Directory::open_layout(source, recovery_path)?;
    let lock = recovery_directory.lock()?;
    let current = durable_journal::read_record(&recovery_directory, expected_executable)?;
    let pending = durable_journal::read_pending(&recovery_directory, expected_executable)?;

    match (current, pending) {
        (None, None) => {
            if recovery_directory.contains(BACKUP_C)? {
                return Err(RECOVERY_FAILED);
            }
            Ok(None)
        }
        (None, Some((pending, bytes))) => {
            if pending.phase != JournalPhase::Prepared {
                return Err(RECOVERY_FAILED);
            }
            let mut adapter = adapter(
                source,
                expected_executable,
                source_directory,
                recovery_directory,
                lock,
                pending,
            );
            let original = adapter.inspect_candidate(false)?;
            if adapter.inspect_candidate(true)?.is_some() {
                return Err(RECOVERY_FAILED);
            }
            let original = original.ok_or(RECOVERY_FAILED)?;
            let record = adapter.journal.as_ref().ok_or(RECOVERY_FAILED)?;
            if original.identity != record.configuration_identity
                || original.sha256 != record.configuration_sha256
            {
                return Err(RECOVERY_FAILED);
            }
            adapter._lock.ensure_named(&adapter.recovery_directory)?;
            durable_journal::publish_prepared_pending(&adapter.recovery_directory, &bytes)?;
            adapter.snapshot = Some(adapter.snapshot_from_record(original.bytes));
            Ok(Some(adapter))
        }
        (Some((current, current_bytes)), Some((pending, bytes))) => {
            if current.phase == JournalPhase::ForwardCommitted
                || !durable_journal::same_transaction(&current, &pending)
                || !durable_journal::pending_advances(&current, &pending)
            {
                return Err(RECOVERY_FAILED);
            }
            let mut adapter = adapter(
                source,
                expected_executable,
                source_directory,
                recovery_directory,
                lock,
                current,
            );
            let original = adapter.inspect_candidate(false)?;
            let backup = adapter.inspect_candidate(true)?;
            if original.is_some() == backup.is_some() || pending.phase == JournalPhase::Prepared {
                return Err(RECOVERY_FAILED);
            }
            adapter._lock.ensure_named(&adapter.recovery_directory)?;
            durable_journal::verify_current(&adapter.recovery_directory, &current_bytes)?;
            durable_journal::remove_pending(&adapter.recovery_directory, &bytes)?;
            finish_resume(adapter).map(Some)
        }
        (Some((current, _)), None) => {
            let adapter = adapter(
                source,
                expected_executable,
                source_directory,
                recovery_directory,
                lock,
                current,
            );
            finish_resume(adapter).map(Some)
        }
    }
}

fn adapter(
    source: &Path,
    executable: &Path,
    source_directory: Directory,
    recovery_directory: Directory,
    lock: super::super::durable_io::Lock,
    journal: Journal,
) -> DurableLegacy {
    DurableLegacy {
        source_path: source.to_path_buf(),
        executable: executable.to_path_buf(),
        source_directory,
        recovery_directory,
        _lock: lock,
        snapshot: None,
        journal: Some(journal),
        requires_reopen: false,
        #[cfg(test)]
        fail_commit_at: None,
        #[cfg(test)]
        journal_publication_failpoint: None,
    }
}

fn finish_resume(mut adapter: DurableLegacy) -> Result<DurableLegacy, &'static str> {
    let original = adapter.inspect_candidate(false)?;
    let backup = adapter.inspect_candidate(true)?;
    if original.is_some() && backup.is_some() {
        return Err(RECOVERY_FAILED);
    }
    if original.is_none() && backup.is_none() {
        if adapter.journal.as_ref().map(|record| record.phase)
            != Some(JournalPhase::ForwardCommitted)
        {
            return Err(RECOVERY_FAILED);
        }
    } else {
        let observed = original
            .as_ref()
            .or(backup.as_ref())
            .ok_or(RECOVERY_FAILED)?;
        adapter.snapshot = Some(adapter.snapshot_from_record(observed.bytes.clone()));
    }
    if adapter.journal.as_ref().map(|record| record.phase) == Some(JournalPhase::ForwardCommitted)
        && original.is_some()
    {
        return Err(RECOVERY_FAILED);
    }
    Ok(adapter)
}
