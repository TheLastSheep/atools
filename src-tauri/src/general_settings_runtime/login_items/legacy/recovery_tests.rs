use super::{recover, RecoveryOutcome};
use crate::general_settings_runtime::login_items::{
    legacy::{
        configuration::{self, ValidatedConfiguration},
        durable::{CommitFailpoint, DurableLegacy},
        journal::JournalPhase,
        migration::{Choice, LegacyPort, Phase},
    },
    spec::legacy_plist,
    transaction::{ServicePort, ServiceStatus},
    RECOVERY_FAILED,
};
use std::{collections::VecDeque, fs, os::unix::fs::PermissionsExt, path::PathBuf};
use tempfile::TempDir;

const LABEL: &str = "com.atools.desktop";

struct Fixture {
    _root: TempDir,
    source: PathBuf,
    recovery: PathBuf,
    executable: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = TempDir::new().unwrap();
        let root_path = root.path().canonicalize().unwrap();
        let source_parent = root_path.join("LaunchAgents");
        let recovery = root_path.join("Recovery");
        fs::create_dir(&source_parent).unwrap();
        fs::create_dir(&recovery).unwrap();
        fs::set_permissions(&source_parent, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&recovery, fs::Permissions::from_mode(0o700)).unwrap();
        let executable = root_path.join("ATools");
        fs::write(&executable, b"isolated executable fixture").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let source = source_parent.join("com.atools.desktop.plist");
        let bytes = legacy_plist(executable.to_str().unwrap());
        fs::write(&source, bytes).unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o600)).unwrap();
        Self {
            _root: root,
            source,
            recovery,
            executable,
        }
    }

    fn validated(&self) -> ValidatedConfiguration {
        configuration::inspect(&self.source, LABEL, &self.executable)
            .unwrap()
            .expect("strict fixture plist")
    }

    fn begin(&self, choice: Choice, before: ServiceStatus) -> DurableLegacy {
        let mut legacy = DurableLegacy::open(self.validated(), &self.recovery).unwrap();
        legacy.prepare(choice, before).unwrap();
        legacy
    }

    fn staged(&self, choice: Choice, before: ServiceStatus, phase: Phase) -> DurableLegacy {
        let mut legacy = self.begin(choice, before);
        legacy.stage().unwrap();
        legacy.checkpoint(Phase::LegacyStaged).unwrap();
        if phase == Phase::ModernVerified {
            legacy.checkpoint(Phase::ModernVerified).unwrap();
        }
        legacy
    }

    fn resume(&self) -> DurableLegacy {
        DurableLegacy::resume(&self.source, &self.executable, &self.recovery)
            .unwrap()
            .expect("durable journal")
    }

    fn assert_record_cleared(&self) {
        assert!(
            DurableLegacy::resume(&self.source, &self.executable, &self.recovery)
                .unwrap()
                .is_none()
        );
        self.assert_artifacts(false, false);
    }

    fn assert_artifacts(&self, journal: bool, backup: bool) {
        assert_eq!(self.recovery.join("transaction.json").exists(), journal);
        assert_eq!(
            self.recovery.join("legacy-login-item.plist").exists(),
            backup
        );
    }
}

#[derive(Clone)]
struct FakeModern {
    current: ServiceStatus,
    replies: VecDeque<Result<ServiceStatus, &'static str>>,
    set_calls: usize,
}

impl FakeModern {
    fn new(current: ServiceStatus) -> Self {
        Self {
            current,
            replies: VecDeque::new(),
            set_calls: 0,
        }
    }

    fn with_replies(
        current: ServiceStatus,
        replies: impl IntoIterator<Item = Result<ServiceStatus, &'static str>>,
    ) -> Self {
        let mut modern = Self::new(current);
        modern.replies.extend(replies);
        modern
    }
}

impl ServicePort for FakeModern {
    fn status(&mut self) -> Result<ServiceStatus, &'static str> {
        match self.replies.pop_front() {
            Some(Ok(status)) => {
                self.current = status;
                Ok(status)
            }
            Some(Err(error)) => Err(error),
            None => Ok(self.current),
        }
    }

    fn set_enabled(&mut self, _enabled: bool) -> Result<(), &'static str> {
        self.set_calls += 1;
        Err(RECOVERY_FAILED)
    }
}

fn assert_no_set(modern: &FakeModern) {
    assert_eq!(modern.set_calls, 0, "recovery must only read modern status");
}

fn assert_files(legacy: &DurableLegacy, source: bool, backup: bool) {
    assert_eq!(legacy.original_present(), Ok(source));
    assert_eq!(legacy.backup_present(), Ok(backup));
}

#[test]
fn prepared_journal_rolls_back_without_mutation_for_both_choices_and_raw_not_found() {
    for (choice, before) in [
        (Choice::TurnOff, ServiceStatus::NotFound),
        (Choice::Migrate, ServiceStatus::Enabled),
        (Choice::Migrate, ServiceStatus::NotRegistered),
    ] {
        let fixture = Fixture::new();
        let legacy = fixture.begin(choice, before);
        assert_eq!(legacy.journal().unwrap().phase, JournalPhase::Prepared);
        if before == ServiceStatus::NotFound {
            assert_eq!(legacy.journal().unwrap().modern_before_raw, 3);
        }
        drop(legacy);

        let mut legacy = fixture.resume();
        let mut modern = FakeModern::new(before);
        assert_eq!(
            recover(&mut modern, &mut legacy),
            Ok(RecoveryOutcome::RolledBack)
        );
        assert_no_set(&modern);
        assert_files(&legacy, true, false);
        drop(legacy);
        fixture.assert_record_cleared();
    }
}

#[test]
fn staged_legacy_with_original_modern_state_restores_file_and_finishes_rollback() {
    let fixture = Fixture::new();
    let legacy = fixture.staged(
        Choice::Migrate,
        ServiceStatus::NotFound,
        Phase::LegacyStaged,
    );
    assert_files(&legacy, false, true);
    drop(legacy);

    let mut legacy = fixture.resume();
    let mut modern = FakeModern::new(ServiceStatus::NotFound);
    assert_eq!(
        recover(&mut modern, &mut legacy),
        Ok(RecoveryOutcome::RolledBack)
    );
    assert_no_set(&modern);
    assert_files(&legacy, true, false);
    drop(legacy);
    fixture.assert_record_cleared();
}

#[test]
fn staged_legacy_with_target_modern_state_commits_without_mutating_os_state() {
    for (choice, before, target) in [
        (
            Choice::Migrate,
            ServiceStatus::NotRegistered,
            ServiceStatus::Enabled,
        ),
        (
            Choice::TurnOff,
            ServiceStatus::Enabled,
            ServiceStatus::NotRegistered,
        ),
        (
            Choice::TurnOff,
            ServiceStatus::NotFound,
            ServiceStatus::NotRegistered,
        ),
    ] {
        let fixture = Fixture::new();
        let legacy = fixture.staged(choice, before, Phase::ModernVerified);
        drop(legacy);

        let mut legacy = fixture.resume();
        let mut modern = FakeModern::new(target);
        assert_eq!(
            recover(&mut modern, &mut legacy),
            Ok(RecoveryOutcome::Committed)
        );
        assert_no_set(&modern);
        assert_files(&legacy, false, false);
        drop(legacy);
        fixture.assert_record_cleared();
    }
}

#[test]
fn forward_committed_journals_finish_with_backup_present_or_already_removed() {
    for failpoint in [
        CommitFailpoint::AfterForwardCommit,
        CommitFailpoint::AfterBackupRemoval,
    ] {
        let fixture = Fixture::new();
        let mut legacy = fixture.staged(
            Choice::Migrate,
            ServiceStatus::NotRegistered,
            Phase::ModernVerified,
        );
        legacy.fail_commit_at_for_test(failpoint);
        assert_eq!(legacy.commit(), Err(RECOVERY_FAILED));
        assert_eq!(
            legacy.journal().unwrap().phase,
            JournalPhase::ForwardCommitted
        );
        let backup_remains = failpoint == CommitFailpoint::AfterForwardCommit;
        assert_files(&legacy, false, backup_remains);
        drop(legacy);

        let mut legacy = fixture.resume();
        let mut modern = FakeModern::new(ServiceStatus::Enabled);
        assert_eq!(
            recover(&mut modern, &mut legacy),
            Ok(RecoveryOutcome::Committed)
        );
        assert_no_set(&modern);
        assert_files(&legacy, false, false);
        drop(legacy);
        fixture.assert_record_cleared();
    }
}

#[test]
fn staged_before_equals_target_commits_the_persisted_choice_and_preserves_raw_three() {
    let fixture = Fixture::new();
    let legacy = fixture.staged(
        Choice::TurnOff,
        ServiceStatus::NotFound,
        Phase::LegacyStaged,
    );
    drop(legacy);
    let mut legacy = fixture.resume();
    assert_eq!(legacy.journal().unwrap().modern_before_raw, 3);
    legacy.fail_commit_at_for_test(CommitFailpoint::AfterForwardCommit);
    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    assert_eq!(recover(&mut modern, &mut legacy), Err(RECOVERY_FAILED));
    assert_no_set(&modern);
    assert_eq!(
        legacy.journal().unwrap().phase,
        JournalPhase::ForwardCommitted
    );
    assert_eq!(legacy.journal().unwrap().modern_before_raw, 3);
    assert_files(&legacy, false, true);
    drop(legacy);

    let mut legacy = fixture.resume();
    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    assert_eq!(
        recover(&mut modern, &mut legacy),
        Ok(RecoveryOutcome::Committed)
    );
    assert_no_set(&modern);
    assert_files(&legacy, false, false);
    drop(legacy);
    fixture.assert_record_cleared();
}

#[test]
fn conflicting_missing_or_unrecognized_evidence_is_preserved() {
    let fixture = Fixture::new();
    let legacy = fixture.staged(
        Choice::Migrate,
        ServiceStatus::NotRegistered,
        Phase::LegacyStaged,
    );
    fs::write(&fixture.source, b"unexpected replacement").unwrap();
    drop(legacy);
    assert_eq!(
        DurableLegacy::resume(&fixture.source, &fixture.executable, &fixture.recovery).err(),
        Some(RECOVERY_FAILED)
    );
    fixture.assert_artifacts(true, true);

    let fixture = Fixture::new();
    let legacy = fixture.staged(
        Choice::Migrate,
        ServiceStatus::NotRegistered,
        Phase::LegacyStaged,
    );
    fs::remove_file(fixture.recovery.join("legacy-login-item.plist")).unwrap();
    drop(legacy);
    assert_eq!(
        DurableLegacy::resume(&fixture.source, &fixture.executable, &fixture.recovery).err(),
        Some(RECOVERY_FAILED)
    );
    fixture.assert_artifacts(true, false);

    for status in [ServiceStatus::Unknown(99), ServiceStatus::RequiresApproval] {
        let fixture = Fixture::new();
        let legacy = fixture.staged(
            Choice::Migrate,
            ServiceStatus::NotRegistered,
            Phase::LegacyStaged,
        );
        drop(legacy);
        let mut legacy = fixture.resume();
        let mut modern = FakeModern::new(status);
        assert_eq!(recover(&mut modern, &mut legacy), Err(RECOVERY_FAILED));
        assert_no_set(&modern);
        assert!(legacy.journal().is_some());
        assert_files(&legacy, false, true);
        fixture.assert_artifacts(true, true);
    }
}

#[test]
fn service_state_drift_before_a_final_filesystem_action_keeps_recovery_evidence() {
    let fixture = Fixture::new();
    let legacy = fixture.staged(
        Choice::Migrate,
        ServiceStatus::NotRegistered,
        Phase::LegacyStaged,
    );
    drop(legacy);
    let mut legacy = fixture.resume();
    let mut modern = FakeModern::with_replies(
        ServiceStatus::Enabled,
        [Ok(ServiceStatus::Enabled), Ok(ServiceStatus::NotRegistered)],
    );
    assert_eq!(recover(&mut modern, &mut legacy), Err(RECOVERY_FAILED));
    assert_no_set(&modern);
    assert!(legacy.journal().is_some());
    assert_files(&legacy, false, true);
    fixture.assert_artifacts(true, true);

    let fixture = Fixture::new();
    let legacy = fixture.staged(
        Choice::Migrate,
        ServiceStatus::NotRegistered,
        Phase::LegacyStaged,
    );
    drop(legacy);
    let mut legacy = fixture.resume();
    let mut modern = FakeModern::with_replies(
        ServiceStatus::NotRegistered,
        [
            Ok(ServiceStatus::NotRegistered),
            Ok(ServiceStatus::NotRegistered),
            Ok(ServiceStatus::Enabled),
        ],
    );
    assert_eq!(recover(&mut modern, &mut legacy), Err(RECOVERY_FAILED));
    assert_no_set(&modern);
    assert!(legacy.journal().is_some());
    assert_files(&legacy, true, false);
    fixture.assert_artifacts(true, false);
}

#[path = "recovery_pending_tests.rs"]
mod pending;
