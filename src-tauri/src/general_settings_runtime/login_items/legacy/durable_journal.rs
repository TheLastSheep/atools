//! Durable journal file operations built on the private descriptor-anchored directory.
use std::ffi::CStr;

use super::super::super::{RECOVERY_FAILED, UNAVAILABLE};
use super::super::durable_io::{Directory, FileContents};
use super::super::journal::{Journal, MAX_JOURNAL_BYTES};

pub(super) const JOURNAL_C: &CStr = c"transaction.json";
pub(super) const PENDING_C: &CStr = c"transaction.pending";
pub(super) const JOURNAL_NAME: &str = "transaction.json";

pub(super) fn has_pending(directory: &Directory) -> Result<bool, &'static str> {
    directory.contains(PENDING_C)
}

pub(super) fn reject_existing(directory: &Directory) -> Result<(), &'static str> {
    if directory.contains(JOURNAL_C)?
        || directory.contains(PENDING_C)?
        || directory.contains(c"legacy-login-item.plist")?
    {
        return Err(RECOVERY_FAILED);
    }
    Ok(())
}

pub(super) fn read_record(
    directory: &Directory,
    expected_executable: &std::path::Path,
) -> Result<Option<(Journal, Vec<u8>)>, &'static str> {
    let Some(contents) = directory.read_child(JOURNAL_C, MAX_JOURNAL_BYTES as u64)? else {
        return Ok(None);
    };
    validate_file(&contents)?;
    let journal = Journal::decode(&contents.bytes, expected_executable)?;
    if journal.encode()? != contents.bytes {
        return Err(RECOVERY_FAILED);
    }
    Ok(Some((journal, contents.bytes)))
}

pub(super) fn read_pending(
    directory: &Directory,
    expected_executable: &std::path::Path,
) -> Result<Option<(Journal, Vec<u8>)>, &'static str> {
    let Some(contents) = directory.read_child(PENDING_C, MAX_JOURNAL_BYTES as u64)? else {
        return Ok(None);
    };
    validate_file(&contents)?;
    let journal = Journal::decode(&contents.bytes, expected_executable)?;
    if journal.encode()? != contents.bytes {
        return Err(RECOVERY_FAILED);
    }
    Ok(Some((journal, contents.bytes)))
}

pub(super) fn verify_current(directory: &Directory, expected: &[u8]) -> Result<(), &'static str> {
    let current = directory
        .read_child(JOURNAL_C, MAX_JOURNAL_BYTES as u64)?
        .ok_or(RECOVERY_FAILED)?;
    validate_file(&current)?;
    if current.bytes != expected {
        return Err(RECOVERY_FAILED);
    }
    Ok(())
}

pub(super) fn publish_prepared_pending(
    directory: &Directory,
    expected: &[u8],
) -> Result<(), &'static str> {
    if directory.contains(JOURNAL_C)? {
        return Err(RECOVERY_FAILED);
    }
    let pending = directory
        .read_child(PENDING_C, MAX_JOURNAL_BYTES as u64)?
        .ok_or(RECOVERY_FAILED)?;
    validate_file(&pending)?;
    if pending.bytes != expected {
        return Err(RECOVERY_FAILED);
    }
    directory.publish_exclusive(
        PENDING_C,
        directory,
        JOURNAL_C,
        &pending,
        MAX_JOURNAL_BYTES as u64,
    )?;
    directory.sync()?;
    verify(directory, expected)
}

pub(super) fn remove_pending(directory: &Directory, expected: &[u8]) -> Result<(), &'static str> {
    let pending = directory
        .read_child(PENDING_C, MAX_JOURNAL_BYTES as u64)?
        .ok_or(RECOVERY_FAILED)?;
    validate_file(&pending)?;
    if pending.bytes != expected {
        return Err(RECOVERY_FAILED);
    }
    directory.remove_exact(
        PENDING_C,
        expected,
        &pending.identity,
        MAX_JOURNAL_BYTES as u64,
    )?;
    directory.sync()
}

pub(super) fn same_transaction(first: &Journal, second: &Journal) -> bool {
    first.schema_version == second.schema_version
        && first.choice == second.choice
        && first.modern_before_raw == second.modern_before_raw
        && first.configuration_identity == second.configuration_identity
        && first.configuration_sha256 == second.configuration_sha256
        && first.executable == second.executable
}

pub(super) fn pending_advances(current: &Journal, pending: &Journal) -> bool {
    use super::super::journal::JournalPhase::{
        ForwardCommitted, LegacyStaged, ModernVerified, Prepared,
    };
    matches!(
        (current.phase, pending.phase),
        (Prepared, LegacyStaged | ForwardCommitted)
            | (LegacyStaged, ModernVerified | ForwardCommitted)
            | (ModernVerified, ForwardCommitted)
    )
}

pub(super) fn persist_initial(
    directory: &Directory,
    journal: &Journal,
) -> Result<(), &'static str> {
    persist_initial_inner(directory, journal, false)
}

#[cfg(test)]
pub(super) fn interrupt_initial_after_pending(
    directory: &Directory,
    journal: &Journal,
) -> Result<(), &'static str> {
    persist_initial_inner(directory, journal, true)
}

fn persist_initial_inner(
    directory: &Directory,
    journal: &Journal,
    interrupt_after_pending: bool,
) -> Result<(), &'static str> {
    if directory.contains(JOURNAL_C)? || has_pending(directory)? {
        return Err(RECOVERY_FAILED);
    }
    let bytes = journal.encode()?;
    write_pending(directory, &bytes)?;
    if interrupt_after_pending {
        return Err(RECOVERY_FAILED);
    }
    let pending = directory
        .read_child(PENDING_C, MAX_JOURNAL_BYTES as u64)?
        .ok_or(RECOVERY_FAILED)?;
    validate_file(&pending)?;
    if pending.bytes != bytes {
        return Err(RECOVERY_FAILED);
    }
    directory.publish_exclusive(
        PENDING_C,
        directory,
        JOURNAL_C,
        &pending,
        MAX_JOURNAL_BYTES as u64,
    )?;
    directory.sync()?;
    verify(directory, &bytes)
}

pub(super) fn persist_replacement(
    directory: &Directory,
    old: &Journal,
    new: &Journal,
) -> Result<(), &'static str> {
    persist_replacement_inner(directory, old, new, false)
}

#[cfg(test)]
pub(super) fn interrupt_replacement_after_pending(
    directory: &Directory,
    old: &Journal,
    new: &Journal,
) -> Result<(), &'static str> {
    persist_replacement_inner(directory, old, new, true)
}

fn persist_replacement_inner(
    directory: &Directory,
    old: &Journal,
    new: &Journal,
    interrupt_after_pending: bool,
) -> Result<(), &'static str> {
    if has_pending(directory)? {
        return Err(RECOVERY_FAILED);
    }
    let old_bytes = old.encode()?;
    let new_bytes = new.encode()?;
    write_pending(directory, &new_bytes)?;
    if interrupt_after_pending {
        return Err(RECOVERY_FAILED);
    }
    directory.replace_owned_child(PENDING_C, JOURNAL_C, &old_bytes, &new_bytes)?;
    directory.sync()?;
    verify(directory, &new_bytes)
}

pub(super) fn remove_durable(directory: &Directory, bytes: &[u8]) -> Result<(), &'static str> {
    let current = directory
        .read_child(JOURNAL_C, MAX_JOURNAL_BYTES as u64)?
        .ok_or(RECOVERY_FAILED)?;
    validate_file(&current)?;
    if current.bytes != bytes {
        return Err(RECOVERY_FAILED);
    }
    directory.remove_exact(
        JOURNAL_C,
        bytes,
        &current.identity,
        MAX_JOURNAL_BYTES as u64,
    )?;
    if directory.sync().is_ok() {
        return Ok(());
    }
    // Directory-sync failure leaves deletion persistence uncertain. Best-effort
    // recreation keeps a valid recovery record if the unlink is still visible.
    if !directory.contains(JOURNAL_C)? {
        let _ = directory.write_exclusive(JOURNAL_C, bytes, MAX_JOURNAL_BYTES as u64);
        let _ = directory.sync();
    }
    Err(RECOVERY_FAILED)
}

fn write_pending(directory: &Directory, bytes: &[u8]) -> Result<(), &'static str> {
    directory.write_exclusive(PENDING_C, bytes, MAX_JOURNAL_BYTES as u64)?;
    directory.sync()
}

fn verify(directory: &Directory, expected: &[u8]) -> Result<(), &'static str> {
    let current = directory
        .read_child(JOURNAL_C, MAX_JOURNAL_BYTES as u64)?
        .ok_or(RECOVERY_FAILED)?;
    validate_file(&current)?;
    if current.bytes != expected {
        return Err(RECOVERY_FAILED);
    }
    Ok(())
}

fn validate_file(contents: &FileContents) -> Result<(), &'static str> {
    if contents.identity.mode & 0o777 != 0o600
        || contents.identity.uid != unsafe { libc::geteuid() }
        || contents.identity.length as usize != contents.bytes.len()
    {
        return Err(RECOVERY_FAILED);
    }
    if contents.bytes.is_empty() || contents.bytes.len() > MAX_JOURNAL_BYTES {
        return Err(UNAVAILABLE);
    }
    Ok(())
}
