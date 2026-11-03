use super::super::transaction::{known_state, ServicePort, ServiceStatus};
use super::super::RECOVERY_FAILED;
use super::durable::DurableLegacy;
use super::journal::JournalPhase;
use super::migration::{Choice, LegacyPort};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RecoveryOutcome {
    RolledBack,
    Committed,
}

pub(super) fn recover<M: ServicePort>(
    modern: &mut M,
    legacy: &mut DurableLegacy,
) -> Result<RecoveryOutcome, &'static str> {
    let (choice, before_raw, phase) = {
        let journal = legacy.journal().ok_or(RECOVERY_FAILED)?;
        (journal.choice, journal.modern_before_raw, journal.phase)
    };
    let before_status = status_from_raw(before_raw)?;
    let before = decision_state(before_status)?;
    let target = choice == Choice::Migrate;
    let current = read_state(modern)?;
    let (source_exists, backup_exists) = read_files(legacy)?;

    if source_exists && backup_exists {
        return Err(RECOVERY_FAILED);
    }
    if phase == JournalPhase::ForwardCommitted {
        return recover_forward_committed(modern, legacy, current, target, backup_exists);
    }
    if source_exists {
        if backup_exists || current != before {
            return Err(RECOVERY_FAILED);
        }
        confirm_state(modern, before)?;
        confirm_files(legacy, true, false)?;
        legacy.finish_rollback().map_err(|_| RECOVERY_FAILED)?;
        return Ok(RecoveryOutcome::RolledBack);
    }
    if !backup_exists || !legacy.staged_verified().map_err(|_| RECOVERY_FAILED)? {
        return Err(RECOVERY_FAILED);
    }

    // If the choice was already satisfied before staging, the persisted choice
    // still wins once the original file has been safely moved aside.
    if current == target {
        return commit_target(modern, legacy, target);
    }
    if current == before {
        return restore_prior_state(modern, legacy, before);
    }
    Err(RECOVERY_FAILED)
}

fn recover_forward_committed<M: ServicePort>(
    modern: &mut M,
    legacy: &mut DurableLegacy,
    current: bool,
    target: bool,
    backup_exists: bool,
) -> Result<RecoveryOutcome, &'static str> {
    if current != target || legacy.original_present().map_err(|_| RECOVERY_FAILED)? {
        return Err(RECOVERY_FAILED);
    }
    if backup_exists && !legacy.staged_verified().map_err(|_| RECOVERY_FAILED)? {
        return Err(RECOVERY_FAILED);
    }
    confirm_state(modern, target)?;
    confirm_files(legacy, false, backup_exists)?;
    if backup_exists && !legacy.staged_verified().map_err(|_| RECOVERY_FAILED)? {
        return Err(RECOVERY_FAILED);
    }
    legacy.commit().map_err(|_| RECOVERY_FAILED)?;
    Ok(RecoveryOutcome::Committed)
}

fn commit_target<M: ServicePort>(
    modern: &mut M,
    legacy: &mut DurableLegacy,
    target: bool,
) -> Result<RecoveryOutcome, &'static str> {
    confirm_state(modern, target)?;
    confirm_files(legacy, false, true)?;
    if !legacy.staged_verified().map_err(|_| RECOVERY_FAILED)? {
        return Err(RECOVERY_FAILED);
    }
    legacy.commit().map_err(|_| RECOVERY_FAILED)?;
    Ok(RecoveryOutcome::Committed)
}

fn restore_prior_state<M: ServicePort>(
    modern: &mut M,
    legacy: &mut DurableLegacy,
    before: bool,
) -> Result<RecoveryOutcome, &'static str> {
    confirm_state(modern, before)?;
    confirm_files(legacy, false, true)?;
    if !legacy.staged_verified().map_err(|_| RECOVERY_FAILED)? {
        return Err(RECOVERY_FAILED);
    }
    legacy.restore().map_err(|_| RECOVERY_FAILED)?;
    confirm_state(modern, before)?;
    confirm_files(legacy, true, false)?;
    legacy.finish_rollback().map_err(|_| RECOVERY_FAILED)?;
    Ok(RecoveryOutcome::RolledBack)
}

fn status_from_raw(raw: i64) -> Result<ServiceStatus, &'static str> {
    match raw {
        0 => Ok(ServiceStatus::NotRegistered),
        1 => Ok(ServiceStatus::Enabled),
        3 => Ok(ServiceStatus::NotFound),
        _ => Err(RECOVERY_FAILED),
    }
}

fn decision_state(status: ServiceStatus) -> Result<bool, &'static str> {
    known_state(status).map_err(|_| RECOVERY_FAILED)
}

fn read_state<M: ServicePort>(modern: &mut M) -> Result<bool, &'static str> {
    modern
        .status()
        .map_err(|_| RECOVERY_FAILED)
        .and_then(decision_state)
}

fn confirm_state<M: ServicePort>(modern: &mut M, expected: bool) -> Result<(), &'static str> {
    if read_state(modern)? == expected {
        Ok(())
    } else {
        Err(RECOVERY_FAILED)
    }
}

fn read_files(legacy: &DurableLegacy) -> Result<(bool, bool), &'static str> {
    Ok((
        legacy.original_present().map_err(|_| RECOVERY_FAILED)?,
        legacy.backup_present().map_err(|_| RECOVERY_FAILED)?,
    ))
}

fn confirm_files(
    legacy: &DurableLegacy,
    expected_source: bool,
    expected_backup: bool,
) -> Result<(), &'static str> {
    if read_files(legacy)? == (expected_source, expected_backup) {
        Ok(())
    } else {
        Err(RECOVERY_FAILED)
    }
}

#[cfg(test)]
#[path = "recovery_tests.rs"]
mod tests;
