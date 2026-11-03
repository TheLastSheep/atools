use std::collections::VecDeque;

use super::super::super::transaction::{ServicePort, ServiceStatus};
use super::super::super::{APPROVAL_REQUIRED, CONFLICT, RECOVERY_FAILED, UNAVAILABLE};
use super::{resolve, Choice, LegacyPort, Phase};

const LEGACY_TEST_ERROR: &str = "LEGACY_TEST_ERROR";

struct FakeModern {
    current: ServiceStatus,
    status_reads: usize,
    status_replies: VecDeque<Result<ServiceStatus, &'static str>>,
    after_set: VecDeque<ServiceStatus>,
    set_replies: VecDeque<Result<(), &'static str>>,
    requested: Vec<bool>,
}

impl FakeModern {
    fn new(current: ServiceStatus) -> Self {
        Self {
            current,
            status_reads: 0,
            status_replies: VecDeque::new(),
            after_set: VecDeque::new(),
            set_replies: VecDeque::new(),
            requested: Vec::new(),
        }
    }
}

impl ServicePort for FakeModern {
    fn status(&mut self) -> Result<ServiceStatus, &'static str> {
        self.status_reads += 1;
        let reply = self.status_replies.pop_front().unwrap_or(Ok(self.current));
        if let Ok(status) = reply {
            self.current = status;
        }
        reply
    }

    fn set_enabled(&mut self, enabled: bool) -> Result<(), &'static str> {
        self.requested.push(enabled);
        self.current = self.after_set.pop_front().unwrap_or(if enabled {
            ServiceStatus::Enabled
        } else {
            ServiceStatus::NotRegistered
        });
        self.set_replies.pop_front().unwrap_or(Ok(()))
    }
}

struct FakeLegacy {
    calls: Vec<&'static str>,
    fail_at: Option<&'static str>,
    verified: Result<bool, &'static str>,
    restore_result: Result<(), &'static str>,
    finish_result: Result<(), &'static str>,
    commit_result: Result<(), &'static str>,
    choice: Option<Choice>,
    before: Option<ServiceStatus>,
    journal_present: bool,
    commit_marker_present: bool,
    backup_present: bool,
    committed: bool,
    source_restored: bool,
}

impl FakeLegacy {
    fn new() -> Self {
        Self {
            calls: Vec::new(),
            fail_at: None,
            verified: Ok(true),
            restore_result: Ok(()),
            finish_result: Ok(()),
            commit_result: Ok(()),
            choice: None,
            before: None,
            journal_present: false,
            commit_marker_present: false,
            backup_present: false,
            committed: false,
            source_restored: false,
        }
    }

    fn checkpoint_name(phase: Phase) -> &'static str {
        match phase {
            Phase::LegacyStaged => "checkpoint-legacy-staged",
            Phase::ModernVerified => "checkpoint-modern-verified",
        }
    }

    fn should_fail(&self, phase: &'static str) -> bool {
        self.fail_at == Some(phase)
    }
}

impl LegacyPort for FakeLegacy {
    fn prepare(&mut self, choice: Choice, before: ServiceStatus) -> Result<(), &'static str> {
        self.calls.push("prepare");
        if self.should_fail("prepare") {
            return Err(LEGACY_TEST_ERROR);
        }
        self.choice = Some(choice);
        self.before = Some(before);
        self.journal_present = true;
        Ok(())
    }

    fn stage(&mut self) -> Result<(), &'static str> {
        self.calls.push("stage");
        if self.should_fail("stage") {
            return Err(LEGACY_TEST_ERROR);
        }
        self.backup_present = true;
        Ok(())
    }

    fn checkpoint(&mut self, phase: Phase) -> Result<(), &'static str> {
        let name = Self::checkpoint_name(phase);
        self.calls.push(name);
        if self.should_fail(name) {
            return Err(LEGACY_TEST_ERROR);
        }
        Ok(())
    }

    fn staged_verified(&mut self) -> Result<bool, &'static str> {
        self.calls.push("staged-verified");
        match self.verified {
            Ok(true) => Ok(self.backup_present),
            other => other,
        }
    }

    fn restore(&mut self) -> Result<(), &'static str> {
        self.calls.push("restore");
        if self.restore_result.is_ok() {
            self.source_restored = true;
            self.backup_present = false;
        }
        self.restore_result
    }

    fn finish_rollback(&mut self) -> Result<(), &'static str> {
        self.calls.push("finish-rollback");
        if self.finish_result.is_ok() {
            self.journal_present = false;
        }
        self.finish_result
    }

    fn commit(&mut self) -> Result<(), &'static str> {
        self.calls.push("commit");
        // Model the durable forward marker, synced backup deletion, and a
        // failure before the journal can be safely removed.
        self.commit_marker_present = true;
        self.committed = true;
        self.backup_present = false;
        if self.commit_result.is_ok() {
            self.journal_present = false;
            self.commit_marker_present = false;
        }
        self.commit_result
    }
}

fn calls_after_rollback() -> Vec<&'static str> {
    vec![
        "prepare",
        "stage",
        "checkpoint-legacy-staged",
        "restore",
        "finish-rollback",
    ]
}

#[test]
fn choices_reconcile_both_states_and_only_register_when_needed() {
    let mut off_modern = FakeModern::new(ServiceStatus::NotFound);
    let mut off_legacy = FakeLegacy::new();
    assert_eq!(
        resolve(&mut off_modern, &mut off_legacy, false, Choice::TurnOff),
        Ok(false)
    );
    assert!(off_modern.requested.is_empty());
    assert_eq!(off_modern.status_reads, 3);
    assert_eq!(off_legacy.choice, Some(Choice::TurnOff));
    assert_eq!(off_legacy.before, Some(ServiceStatus::NotFound));
    assert!(off_legacy.committed);
    assert!(!off_legacy.backup_present && !off_legacy.journal_present);
    assert!(!off_legacy.commit_marker_present);

    let mut migrate_modern = FakeModern::new(ServiceStatus::NotRegistered);
    let mut migrate_legacy = FakeLegacy::new();
    assert_eq!(
        resolve(
            &mut migrate_modern,
            &mut migrate_legacy,
            false,
            Choice::Migrate
        ),
        Ok(true)
    );
    assert_eq!(migrate_modern.requested, vec![true]);
    assert!(migrate_legacy.committed);
    assert!(!migrate_legacy.backup_present && !migrate_legacy.journal_present);
    assert!(!migrate_legacy.commit_marker_present);

    let mut already_enabled = FakeModern::new(ServiceStatus::Enabled);
    let mut already_enabled_legacy = FakeLegacy::new();
    assert_eq!(
        resolve(
            &mut already_enabled,
            &mut already_enabled_legacy,
            true,
            Choice::Migrate
        ),
        Ok(true)
    );
    assert!(already_enabled.requested.is_empty());
    assert_eq!(already_enabled.status_reads, 3);
    assert_eq!(already_enabled_legacy.calls.last(), Some(&"commit"));

    let mut enabled_to_off = FakeModern::new(ServiceStatus::Enabled);
    let mut enabled_to_off_legacy = FakeLegacy::new();
    assert_eq!(
        resolve(
            &mut enabled_to_off,
            &mut enabled_to_off_legacy,
            true,
            Choice::TurnOff
        ),
        Ok(false)
    );
    assert_eq!(enabled_to_off.requested, vec![false]);
}

#[test]
fn cas_unknown_and_approval_refuse_before_creating_a_journal() {
    let mut conflict_modern = FakeModern::new(ServiceStatus::NotRegistered);
    let mut conflict_legacy = FakeLegacy::new();
    assert_eq!(
        resolve(
            &mut conflict_modern,
            &mut conflict_legacy,
            true,
            Choice::Migrate
        ),
        Err(CONFLICT)
    );
    assert!(conflict_legacy.calls.is_empty());
    assert!(conflict_modern.requested.is_empty());

    for (status, error) in [
        (ServiceStatus::RequiresApproval, APPROVAL_REQUIRED),
        (ServiceStatus::Unknown(72), UNAVAILABLE),
    ] {
        let mut modern = FakeModern::new(status);
        let mut legacy = FakeLegacy::new();
        assert_eq!(
            resolve(&mut modern, &mut legacy, false, Choice::Migrate),
            Err(error)
        );
        assert!(legacy.calls.is_empty());
        assert!(modern.requested.is_empty());
    }

    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    modern.status_replies.push_back(Err(UNAVAILABLE));
    let mut legacy = FakeLegacy::new();
    assert_eq!(
        resolve(&mut modern, &mut legacy, false, Choice::Migrate),
        Err(UNAVAILABLE)
    );
    assert!(legacy.calls.is_empty());
}

#[test]
fn every_legacy_stage_failure_is_compensated_before_returning_its_error() {
    for failed_phase in ["stage", "checkpoint-legacy-staged"] {
        let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
        let mut legacy = FakeLegacy::new();
        legacy.fail_at = Some(failed_phase);
        assert_eq!(
            resolve(&mut modern, &mut legacy, false, Choice::Migrate),
            Err(LEGACY_TEST_ERROR)
        );
        assert_eq!(legacy.calls.last(), Some(&"finish-rollback"));
        assert!(legacy.source_restored);
        assert!(!legacy.journal_present);
        assert!(modern.requested.is_empty());
    }

    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    let mut legacy = FakeLegacy::new();
    legacy.fail_at = Some("prepare");
    assert_eq!(
        resolve(&mut modern, &mut legacy, false, Choice::Migrate),
        Err(LEGACY_TEST_ERROR)
    );
    assert_eq!(legacy.calls, vec!["prepare"]);
    assert!(!legacy.journal_present);
    assert!(modern.requested.is_empty());
}

#[test]
fn setter_result_is_ignored_when_readback_confirms_the_target() {
    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    modern.set_replies.push_back(Err(UNAVAILABLE));
    let mut legacy = FakeLegacy::new();
    assert_eq!(
        resolve(&mut modern, &mut legacy, false, Choice::Migrate),
        Ok(true)
    );
    assert_eq!(modern.requested, vec![true]);
    assert_eq!(legacy.calls.last(), Some(&"commit"));
}

#[test]
fn wrong_modern_readback_rolls_back_and_returns_the_primary_error() {
    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    modern.after_set.push_back(ServiceStatus::NotRegistered);
    let mut legacy = FakeLegacy::new();
    assert_eq!(
        resolve(&mut modern, &mut legacy, false, Choice::Migrate),
        Err(UNAVAILABLE)
    );
    assert_eq!(modern.requested, vec![true]);
    assert_eq!(legacy.calls, calls_after_rollback());
    assert!(legacy.source_restored);
    assert!(!legacy.journal_present);
}

#[test]
fn approval_during_modern_readback_is_preserved_after_verified_rollback() {
    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    modern.after_set.push_back(ServiceStatus::RequiresApproval);
    let mut legacy = FakeLegacy::new();
    assert_eq!(
        resolve(&mut modern, &mut legacy, false, Choice::Migrate),
        Err(APPROVAL_REQUIRED)
    );
    assert_eq!(modern.requested, vec![true, false]);
    assert!(legacy.source_restored);
    assert!(!legacy.journal_present);
}

#[test]
fn modern_verified_checkpoint_failure_restores_modern_before_legacy() {
    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    let mut legacy = FakeLegacy::new();
    legacy.fail_at = Some("checkpoint-modern-verified");
    assert_eq!(
        resolve(&mut modern, &mut legacy, false, Choice::Migrate),
        Err(LEGACY_TEST_ERROR)
    );
    assert_eq!(modern.requested, vec![true, false]);
    assert_eq!(legacy.calls.last(), Some(&"finish-rollback"));
    assert!(legacy.source_restored);
    assert!(!legacy.journal_present);
}

#[test]
fn false_staged_verification_rolls_back_without_claiming_success() {
    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    let mut legacy = FakeLegacy::new();
    legacy.verified = Ok(false);
    assert_eq!(
        resolve(&mut modern, &mut legacy, false, Choice::Migrate),
        Err(UNAVAILABLE)
    );
    assert_eq!(modern.requested, vec![true, false]);
    assert_eq!(legacy.calls.last(), Some(&"finish-rollback"));
    assert!(legacy.source_restored);
}

#[test]
fn final_modern_readback_drift_blocks_commit_and_restores_legacy() {
    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    modern.status_replies.extend([
        Ok(ServiceStatus::NotRegistered),
        Ok(ServiceStatus::Enabled),
        Ok(ServiceStatus::NotRegistered),
    ]);
    modern.after_set.push_back(ServiceStatus::Enabled);
    let mut legacy = FakeLegacy::new();

    assert_eq!(
        resolve(&mut modern, &mut legacy, false, Choice::Migrate),
        Err(UNAVAILABLE)
    );
    assert_eq!(modern.requested, vec![true]);
    assert!(!legacy.calls.contains(&"commit"));
    assert!(legacy.source_restored);
    assert!(!legacy.backup_present);
    assert!(!legacy.journal_present);
}

#[test]
fn unknown_final_modern_readback_blocks_commit_and_preserves_recovery_evidence() {
    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    modern.status_replies.extend([
        Ok(ServiceStatus::NotRegistered),
        Ok(ServiceStatus::Enabled),
        Ok(ServiceStatus::Unknown(80)),
    ]);
    modern
        .after_set
        .extend([ServiceStatus::Enabled, ServiceStatus::Unknown(81)]);
    let mut legacy = FakeLegacy::new();

    assert_eq!(
        resolve(&mut modern, &mut legacy, false, Choice::Migrate),
        Err(RECOVERY_FAILED)
    );
    assert_eq!(modern.requested, vec![true, false]);
    assert!(!legacy.calls.contains(&"commit"));
    assert!(!legacy.calls.contains(&"restore"));
    assert!(legacy.journal_present);
    assert!(legacy.backup_present);
    assert!(!legacy.committed);
}

#[test]
fn failed_modern_recovery_keeps_legacy_backup_and_does_not_restore_it() {
    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    modern
        .after_set
        .extend([ServiceStatus::Unknown(1), ServiceStatus::Unknown(2)]);
    let mut legacy = FakeLegacy::new();
    assert_eq!(
        resolve(&mut modern, &mut legacy, false, Choice::Migrate),
        Err(RECOVERY_FAILED)
    );
    assert_eq!(modern.requested, vec![true, false]);
    assert!(legacy.journal_present);
    assert!(!legacy.source_restored);
    assert!(!legacy.calls.contains(&"restore"));
    assert!(!legacy.calls.contains(&"finish-rollback"));
}

#[test]
fn legacy_restore_or_finish_failure_is_recovery_failed_and_keeps_journal() {
    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    let mut restore_failure = FakeLegacy::new();
    restore_failure.verified = Ok(false);
    restore_failure.restore_result = Err(LEGACY_TEST_ERROR);
    assert_eq!(
        resolve(&mut modern, &mut restore_failure, false, Choice::Migrate),
        Err(RECOVERY_FAILED)
    );
    assert!(restore_failure.journal_present);
    assert!(!restore_failure.calls.contains(&"finish-rollback"));

    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    let mut finish_failure = FakeLegacy::new();
    finish_failure.verified = Ok(false);
    finish_failure.finish_result = Err(LEGACY_TEST_ERROR);
    assert_eq!(
        resolve(&mut modern, &mut finish_failure, false, Choice::Migrate),
        Err(RECOVERY_FAILED)
    );
    assert!(finish_failure.source_restored);
    assert!(finish_failure.journal_present);
}

#[test]
fn commit_failure_never_attempts_rollback_after_backup_may_be_deleted() {
    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    let mut legacy = FakeLegacy::new();
    legacy.commit_result = Err(LEGACY_TEST_ERROR);
    assert_eq!(
        resolve(&mut modern, &mut legacy, false, Choice::Migrate),
        Err(RECOVERY_FAILED)
    );
    assert_eq!(legacy.calls.last(), Some(&"commit"));
    assert!(!legacy.calls.contains(&"restore"));
    assert!(!legacy.calls.contains(&"finish-rollback"));
    assert_eq!(modern.current, ServiceStatus::Enabled);
    assert!(legacy.committed);
    assert!(legacy.commit_marker_present);
    assert!(!legacy.backup_present);
    assert!(legacy.journal_present);
}
