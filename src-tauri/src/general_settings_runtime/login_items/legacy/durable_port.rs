//! Transaction-policy adapter over the durable legacy filesystem owner.
use super::super::super::transaction::ServiceStatus;
use super::super::super::RECOVERY_FAILED;
use super::super::journal::{Journal, JournalPhase};
use super::super::migration::{Choice, LegacyPort, Phase};
use super::durable_journal;
use super::DurableLegacy;
#[cfg(test)]
use super::{CommitFailpoint, JournalPublicationFailpoint};

impl LegacyPort for DurableLegacy {
    fn prepare(&mut self, choice: Choice, before: ServiceStatus) -> Result<(), &'static str> {
        if self.requires_reopen || self.journal.is_some() || self.snapshot.is_none() {
            return Err(RECOVERY_FAILED);
        }
        self.ensure_lock_named()?;
        self.ensure_open_source_matches()?;
        let journal = Journal::prepared(
            self.snapshot.as_ref().ok_or(RECOVERY_FAILED)?,
            choice,
            before,
        )?;
        self.ensure_lock_named()?;
        #[cfg(test)]
        if self.should_fail_journal_publication_at(JournalPublicationFailpoint::InitialPrepared) {
            durable_journal::interrupt_initial_after_pending(&self.recovery_directory, &journal)?;
        } else {
            durable_journal::persist_initial(&self.recovery_directory, &journal)?;
        }
        #[cfg(not(test))]
        durable_journal::persist_initial(&self.recovery_directory, &journal)?;
        self.journal = Some(journal);
        Ok(())
    }

    fn stage(&mut self) -> Result<(), &'static str> {
        if self.requires_reopen || self.journal.is_none() {
            return Err(RECOVERY_FAILED);
        }
        self.ensure_lock_named()?;
        let original = self.original_present()?;
        let backup = self.backup_present()?;
        match (original, backup) {
            (true, false) => self.rename_source_to_backup(),
            (false, true) => Ok(()),
            _ => Err(RECOVERY_FAILED),
        }
    }

    fn checkpoint(&mut self, phase: Phase) -> Result<(), &'static str> {
        if self.requires_reopen {
            return Err(RECOVERY_FAILED);
        }
        self.ensure_lock_named()?;
        let old = self.journal.clone().ok_or(RECOVERY_FAILED)?;
        let next_phase = match (old.phase, phase) {
            (JournalPhase::Prepared, Phase::LegacyStaged)
            | (JournalPhase::LegacyStaged, Phase::LegacyStaged) => JournalPhase::LegacyStaged,
            (JournalPhase::LegacyStaged, Phase::ModernVerified)
            | (JournalPhase::ModernVerified, Phase::ModernVerified) => JournalPhase::ModernVerified,
            (JournalPhase::ForwardCommitted, _) => return Err(RECOVERY_FAILED),
            _ => return Err(RECOVERY_FAILED),
        };
        if self.original_present()? || !self.backup_present()? {
            return Err(RECOVERY_FAILED);
        }
        let mut next = old.clone();
        next.phase = next_phase;
        if next != old {
            self.ensure_lock_named()?;
            #[cfg(test)]
            if self.should_fail_journal_publication_at(JournalPublicationFailpoint::Replacement) {
                durable_journal::interrupt_replacement_after_pending(
                    &self.recovery_directory,
                    &old,
                    &next,
                )?;
            } else {
                durable_journal::persist_replacement(&self.recovery_directory, &old, &next)?;
            }
            #[cfg(not(test))]
            durable_journal::persist_replacement(&self.recovery_directory, &old, &next)?;
            self.journal = Some(next);
        }
        Ok(())
    }

    fn staged_verified(&mut self) -> Result<bool, &'static str> {
        let original = self.original_present()?;
        let backup = self.backup_present()?;
        match (original, backup) {
            (false, true) => Ok(true),
            (true, false) => Ok(false),
            _ => Err(RECOVERY_FAILED),
        }
    }

    fn restore(&mut self) -> Result<(), &'static str> {
        if self.requires_reopen || self.is_forward_committed() {
            return Err(RECOVERY_FAILED);
        }
        self.ensure_lock_named()?;
        self.restore_backup_to_source()
    }

    fn finish_rollback(&mut self) -> Result<(), &'static str> {
        self.ensure_lock_named()?;
        if self.requires_reopen
            || self.is_forward_committed()
            || !self.original_present()?
            || self.backup_present()?
        {
            return Err(RECOVERY_FAILED);
        }
        let journal_bytes = self.current_record_bytes()?;
        self.ensure_lock_named()?;
        durable_journal::verify_current(&self.recovery_directory, &journal_bytes)?;
        if let Some((pending, bytes)) =
            durable_journal::read_pending(&self.recovery_directory, &self.executable)?
        {
            let current = self.journal.as_ref().ok_or(RECOVERY_FAILED)?;
            if pending.phase == JournalPhase::ForwardCommitted
                || !durable_journal::same_transaction(current, &pending)
                || !durable_journal::pending_advances(current, &pending)
            {
                return Err(RECOVERY_FAILED);
            }
            self.ensure_lock_named()?;
            durable_journal::remove_pending(&self.recovery_directory, &bytes)?;
        }
        self.ensure_lock_named()?;
        durable_journal::remove_durable(&self.recovery_directory, &journal_bytes)?;
        self.journal = None;
        Ok(())
    }

    fn commit(&mut self) -> Result<(), &'static str> {
        if self.requires_reopen {
            return Err(RECOVERY_FAILED);
        }
        self.ensure_lock_named()?;
        let mut journal = self.journal.clone().ok_or(RECOVERY_FAILED)?;
        if !self.is_forward_committed() {
            if !matches!(
                journal.phase,
                JournalPhase::Prepared | JournalPhase::LegacyStaged | JournalPhase::ModernVerified
            ) || self.original_present()?
                || !self.backup_present()?
            {
                return Err(RECOVERY_FAILED);
            }
            let old = journal.clone();
            journal.phase = JournalPhase::ForwardCommitted;
            self.requires_reopen = true;
            self.ensure_lock_named()?;
            durable_journal::persist_replacement(&self.recovery_directory, &old, &journal)?;
            self.journal = Some(journal.clone());
        } else if self.original_present()? {
            return Err(RECOVERY_FAILED);
        }

        #[cfg(test)]
        if self.should_fail_commit_at(CommitFailpoint::AfterForwardCommit) {
            return Err(RECOVERY_FAILED);
        }

        if self.backup_present()? {
            self.ensure_lock_named()?;
            self.remove_backup()?;
        }
        if self.original_present()? || self.backup_present()? {
            return Err(RECOVERY_FAILED);
        }

        #[cfg(test)]
        if self.should_fail_commit_at(CommitFailpoint::AfterBackupRemoval) {
            return Err(RECOVERY_FAILED);
        }

        let journal_bytes = self.current_record_bytes()?;
        self.ensure_lock_named()?;
        durable_journal::remove_durable(&self.recovery_directory, &journal_bytes)?;
        self.journal = None;
        Ok(())
    }
}
