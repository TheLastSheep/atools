use serde::{Deserialize, Serialize};

use super::super::transaction::{known_state, ServicePort, ServiceStatus};
use super::super::{APPROVAL_REQUIRED, CONFLICT, RECOVERY_FAILED, UNAVAILABLE};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Choice {
    TurnOff,
    Migrate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Phase {
    LegacyStaged,
    ModernVerified,
}

/// Fixed, non-path-bearing operations over a prevalidated legacy snapshot.
pub(super) trait LegacyPort {
    /// Persist a private recovery record without changing either registration.
    fn prepare(&mut self, choice: Choice, before: ServiceStatus) -> Result<(), &'static str>;
    /// Atomically stage the source and verify the staged identity.
    fn stage(&mut self) -> Result<(), &'static str>;
    /// Durably record the completed transaction phase.
    fn checkpoint(&mut self, phase: Phase) -> Result<(), &'static str>;
    /// Confirm the source is absent and the staged backup matches its snapshot.
    fn staged_verified(&mut self) -> Result<bool, &'static str>;
    /// Restore and verify the original bytes and filesystem identity.
    fn restore(&mut self) -> Result<(), &'static str>;
    /// Remove rollback evidence only after both systems are verified restored.
    fn finish_rollback(&mut self) -> Result<(), &'static str>;
    /// Durably mark forward commit, delete the backup and sync its directory, then
    /// remove the journal and sync its directory. Any error must retain durable
    /// forward-recovery evidence; this operation may not be rolled back.
    fn commit(&mut self) -> Result<(), &'static str>;
}

pub(super) fn resolve<M: ServicePort, L: LegacyPort>(
    modern: &mut M,
    legacy: &mut L,
    expected_modern: bool,
    choice: Choice,
) -> Result<bool, &'static str> {
    let before_status = modern.status().map_err(status_error)?;
    let before = known_state(before_status)?;
    if before != expected_modern {
        return Err(CONFLICT);
    }

    let target = matches!(choice, Choice::Migrate);
    legacy.prepare(choice, before_status)?;

    if let Err(error) = legacy.stage() {
        return rollback(modern, legacy, before, error);
    }
    if let Err(error) = legacy.checkpoint(Phase::LegacyStaged) {
        return rollback(modern, legacy, before, error);
    }

    if before != target {
        let _set_result = modern.set_enabled(target);
    }
    if let Err(error) = verify_status(modern.status(), target) {
        return rollback(modern, legacy, before, error);
    }
    if let Err(error) = legacy.checkpoint(Phase::ModernVerified) {
        return rollback(modern, legacy, before, error);
    }
    match legacy.staged_verified() {
        Ok(true) => {}
        Ok(false) => return rollback(modern, legacy, before, UNAVAILABLE),
        Err(error) => return rollback(modern, legacy, before, error),
    }
    if let Err(error) = verify_status(modern.status(), target) {
        return rollback(modern, legacy, before, error);
    }

    legacy.commit().map_err(|_| RECOVERY_FAILED)?;
    Ok(target)
}

fn rollback<M: ServicePort, L: LegacyPort>(
    modern: &mut M,
    legacy: &mut L,
    before: bool,
    primary_error: &'static str,
) -> Result<bool, &'static str> {
    if !restore_modern(modern, before) {
        return Err(RECOVERY_FAILED);
    }
    if legacy.restore().is_err() || legacy.finish_rollback().is_err() {
        return Err(RECOVERY_FAILED);
    }
    Err(primary_error)
}

fn restore_modern<M: ServicePort>(modern: &mut M, before: bool) -> bool {
    if matches!(modern.status(), Ok(status) if known_state(status) == Ok(before)) {
        return true;
    }
    let _set_result = modern.set_enabled(before);
    verify_status(modern.status(), before).is_ok()
}

fn verify_status(
    status: Result<ServiceStatus, &'static str>,
    expected: bool,
) -> Result<(), &'static str> {
    let status = status.map_err(status_error)?;
    let actual = known_state(status)?;
    if actual == expected {
        Ok(())
    } else {
        Err(UNAVAILABLE)
    }
}

fn status_error(error: &'static str) -> &'static str {
    if error == APPROVAL_REQUIRED {
        APPROVAL_REQUIRED
    } else {
        UNAVAILABLE
    }
}

#[cfg(test)]
#[path = "migration_tests.rs"]
mod migration_tests;
