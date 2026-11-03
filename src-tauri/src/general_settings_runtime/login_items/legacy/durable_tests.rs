use std::collections::VecDeque;
use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tempfile::TempDir;

use super::super::super::transaction::{ServicePort, ServiceStatus};
use super::super::configuration::{self, ValidatedConfiguration};
use super::super::journal::{Journal, JournalPhase};
use super::super::migration::{resolve, Choice, LegacyPort, Phase};
use super::durable_journal::JOURNAL_NAME;
use super::{
    CommitFailpoint, DurableLegacy, JournalPublicationFailpoint, BACKUP_NAME, LABEL, SOURCE_NAME,
};

struct Fixture {
    _root: TempDir,
    source: PathBuf,
    executable: PathBuf,
    recovery: PathBuf,
    configuration: ValidatedConfiguration,
}

impl Fixture {
    fn new() -> Self {
        let root = TempDir::new().unwrap();
        let root_path = root.path().canonicalize().unwrap();
        let agents = root_path.join("LaunchAgents");
        let recovery = root_path.join("Recovery");
        fs::create_dir(&agents).unwrap();
        fs::create_dir(&recovery).unwrap();
        fs::set_permissions(&agents, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&recovery, fs::Permissions::from_mode(0o700)).unwrap();
        let executable = root_path.join("ATools-test");
        fs::write(&executable, b"fixture executable").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let source = agents.join(SOURCE_NAME);
        let bytes = plist_bytes(&executable);
        fs::write(&source, &bytes).unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o600)).unwrap();
        let configuration = configuration::inspect(&source, LABEL, &executable)
            .unwrap()
            .unwrap();
        Self {
            _root: root,
            source,
            executable,
            recovery,
            configuration,
        }
    }

    fn open(&self) -> DurableLegacy {
        DurableLegacy::open(self.configuration.clone(), &self.recovery).unwrap()
    }

    fn resume(&self) -> Result<Option<DurableLegacy>, &'static str> {
        DurableLegacy::resume(&self.source, &self.executable, &self.recovery)
    }
}

#[derive(Serialize)]
struct LegacyPlist<'a> {
    #[serde(rename = "Label")]
    label: &'static str,
    #[serde(rename = "RunAtLoad")]
    run_at_load: bool,
    #[serde(rename = "Program")]
    program: &'a str,
}

fn plist_bytes(executable: &Path) -> Vec<u8> {
    let mut bytes = Vec::new();
    plist::to_writer_xml(
        &mut bytes,
        &LegacyPlist {
            label: LABEL,
            run_at_load: true,
            program: executable.to_str().unwrap(),
        },
    )
    .unwrap();
    bytes
}

struct FakeService {
    status: ServiceStatus,
    after_set: VecDeque<ServiceStatus>,
    requested: Vec<bool>,
}

impl FakeService {
    fn new(status: ServiceStatus) -> Self {
        Self {
            status,
            after_set: VecDeque::new(),
            requested: Vec::new(),
        }
    }
}

impl ServicePort for FakeService {
    fn status(&mut self) -> Result<ServiceStatus, &'static str> {
        Ok(self.status)
    }

    fn set_enabled(&mut self, enabled: bool) -> Result<(), &'static str> {
        self.requested.push(enabled);
        self.status = self.after_set.pop_front().unwrap_or(if enabled {
            ServiceStatus::Enabled
        } else {
            ServiceStatus::NotRegistered
        });
        Ok(())
    }
}

#[test]
fn real_private_file_transaction_commits_both_choices() {
    for (choice, before, expected, requested) in [
        (
            Choice::TurnOff,
            ServiceStatus::NotFound,
            false,
            Vec::<bool>::new(),
        ),
        (
            Choice::Migrate,
            ServiceStatus::NotRegistered,
            true,
            vec![true],
        ),
    ] {
        let fixture = Fixture::new();
        let mut modern = FakeService::new(before);
        let mut legacy = fixture.open();
        assert_eq!(
            resolve(&mut modern, &mut legacy, false, choice),
            Ok(expected)
        );
        assert_eq!(modern.requested, requested);
        assert!(!fixture.source.exists());
        assert!(!fixture.recovery.join(BACKUP_NAME).exists());
        assert!(!fixture.recovery.join(JOURNAL_NAME).exists());
        assert_eq!(legacy.journal(), None);
    }
}

#[test]
fn modern_readback_failure_restores_source_and_removes_journal_only_after_confirmation() {
    let fixture = Fixture::new();
    let mut modern = FakeService::new(ServiceStatus::NotRegistered);
    modern
        .after_set
        .extend([ServiceStatus::Unknown(42), ServiceStatus::NotRegistered]);
    let mut legacy = fixture.open();

    assert_eq!(
        resolve(&mut modern, &mut legacy, false, Choice::Migrate),
        Err(super::super::super::UNAVAILABLE)
    );
    assert!(fixture.source.exists());
    assert!(!fixture.recovery.join(BACKUP_NAME).exists());
    assert!(!fixture.recovery.join(JOURNAL_NAME).exists());
    assert!(legacy.journal().is_none());
}

#[test]
fn cas_unknown_and_approval_rejections_do_not_create_recovery_state() {
    for (status, expected, error) in [
        (ServiceStatus::Enabled, false, super::super::super::CONFLICT),
        (
            ServiceStatus::Unknown(7),
            false,
            super::super::super::UNAVAILABLE,
        ),
        (
            ServiceStatus::RequiresApproval,
            false,
            super::super::super::APPROVAL_REQUIRED,
        ),
    ] {
        let fixture = Fixture::new();
        let mut modern = FakeService::new(status);
        let mut legacy = fixture.open();
        assert_eq!(
            resolve(&mut modern, &mut legacy, expected, Choice::Migrate),
            Err(error)
        );
        assert!(fixture.source.exists());
        assert!(!fixture.recovery.join(JOURNAL_NAME).exists());
        assert!(!fixture.recovery.join(BACKUP_NAME).exists());
    }
}

#[test]
fn staged_restart_revalidates_backup_and_rejects_tampering() {
    let fixture = Fixture::new();
    let mut legacy = fixture.open();
    LegacyPort::prepare(&mut legacy, Choice::Migrate, ServiceStatus::NotRegistered).unwrap();
    LegacyPort::stage(&mut legacy).unwrap();
    LegacyPort::checkpoint(&mut legacy, Phase::LegacyStaged).unwrap();
    drop(legacy);

    let resumed = fixture.resume().unwrap().unwrap();
    assert_eq!(resumed.journal().unwrap().phase, JournalPhase::LegacyStaged);
    assert!(!resumed.original_present().unwrap());
    assert!(resumed.backup_present().unwrap());
    drop(resumed);

    fs::write(fixture.recovery.join(BACKUP_NAME), b"tampered").unwrap();
    fs::set_permissions(
        fixture.recovery.join(BACKUP_NAME),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert!(matches!(
        fixture.resume(),
        Err(super::super::super::RECOVERY_FAILED)
    ));
    assert!(fixture.recovery.join(JOURNAL_NAME).exists());
}

#[test]
fn open_rejects_existing_journal_and_resume_reports_only_true_absence_as_none() {
    let fixture = Fixture::new();
    assert!(fixture.resume().unwrap().is_none());

    let mut legacy = fixture.open();
    LegacyPort::prepare(&mut legacy, Choice::Migrate, ServiceStatus::NotRegistered).unwrap();
    drop(legacy);
    assert!(matches!(
        DurableLegacy::open(fixture.configuration.clone(), &fixture.recovery).map(|_| ()),
        Err(super::super::super::RECOVERY_FAILED)
    ));

    let stray = Fixture::new();
    fs::write(stray.recovery.join(BACKUP_NAME), b"stray backup").unwrap();
    assert!(matches!(
        stray.resume(),
        Err(super::super::super::RECOVERY_FAILED)
    ));
}

#[test]
fn prepare_rechecks_source_identity_after_adapter_open() {
    let fixture = Fixture::new();
    let mut legacy = fixture.open();
    fs::write(&fixture.source, b"replacement").unwrap();
    fs::set_permissions(&fixture.source, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        LegacyPort::prepare(&mut legacy, Choice::Migrate, ServiceStatus::NotRegistered),
        Err(super::super::super::RECOVERY_FAILED)
    );
    assert!(!fixture.recovery.join(JOURNAL_NAME).exists());
    assert!(fixture.source.exists());
}

#[test]
fn resume_rejects_both_source_and_backup_even_when_source_is_valid() {
    let fixture = Fixture::new();
    let mut legacy = fixture.open();
    LegacyPort::prepare(&mut legacy, Choice::Migrate, ServiceStatus::NotRegistered).unwrap();
    LegacyPort::stage(&mut legacy).unwrap();
    drop(legacy);
    fs::write(&fixture.source, &fixture.configuration.bytes).unwrap();
    fs::set_permissions(&fixture.source, fs::Permissions::from_mode(0o600)).unwrap();

    assert!(matches!(
        fixture.resume(),
        Err(super::super::super::RECOVERY_FAILED)
    ));
    assert!(fixture.source.exists());
    assert!(fixture.recovery.join(BACKUP_NAME).exists());
    assert!(fixture.recovery.join(JOURNAL_NAME).exists());
}

#[test]
fn open_rejects_symlinked_source_or_backup_and_nonprivate_recovery_directory() {
    let source_link = Fixture::new();
    let target = source_link._root.path().join("source-target.plist");
    fs::write(&target, &source_link.configuration.bytes).unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
    fs::remove_file(&source_link.source).unwrap();
    symlink(&target, &source_link.source).unwrap();
    assert!(matches!(
        DurableLegacy::open(source_link.configuration.clone(), &source_link.recovery),
        Err(super::super::super::UNAVAILABLE)
    ));

    let backup_link = Fixture::new();
    let target = backup_link._root.path().join("backup-target.plist");
    fs::write(&target, &backup_link.configuration.bytes).unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
    symlink(&target, backup_link.recovery.join(BACKUP_NAME)).unwrap();
    assert!(matches!(
        DurableLegacy::open(backup_link.configuration.clone(), &backup_link.recovery),
        Err(super::super::super::RECOVERY_FAILED)
    ));

    let loose_recovery = Fixture::new();
    fs::set_permissions(&loose_recovery.recovery, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(
        DurableLegacy::open(
            loose_recovery.configuration.clone(),
            &loose_recovery.recovery
        ),
        Err(super::super::super::UNAVAILABLE)
    ));
}

#[test]
fn replaced_lock_name_fences_held_adapter_before_source_rename() {
    let fixture = Fixture::new();
    let lock_path = fixture.recovery.join(".login-item-migration.lock");
    let mut legacy = fixture.open();
    LegacyPort::prepare(&mut legacy, Choice::Migrate, ServiceStatus::NotRegistered).unwrap();

    fs::remove_file(&lock_path).unwrap();
    fs::write(&lock_path, b"").unwrap();
    fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o600)).unwrap();

    assert_eq!(
        LegacyPort::stage(&mut legacy),
        Err(super::super::super::RECOVERY_FAILED)
    );
    assert_eq!(
        LegacyPort::restore(&mut legacy),
        Err(super::super::super::RECOVERY_FAILED)
    );
    assert!(fixture.source.exists());
    assert!(!fixture.recovery.join(BACKUP_NAME).exists());
    assert!(matches!(
        DurableLegacy::open(fixture.configuration.clone(), &fixture.recovery),
        Err(super::super::super::RECOVERY_FAILED)
    ));
}

#[test]
fn rollback_cleans_a_valid_unpublished_checkpoint_before_removing_journal() {
    let fixture = Fixture::new();
    let mut legacy = fixture.open();
    legacy
        .prepare(Choice::Migrate, ServiceStatus::NotRegistered)
        .unwrap();
    legacy.stage().unwrap();
    legacy.fail_journal_publication_at_for_test(JournalPublicationFailpoint::Replacement);
    assert_eq!(
        legacy.checkpoint(Phase::LegacyStaged),
        Err(super::super::super::RECOVERY_FAILED)
    );

    legacy.restore().unwrap();
    legacy.finish_rollback().unwrap();
    assert!(fixture.source.exists());
    assert!(!fixture.recovery.join(BACKUP_NAME).exists());
    assert!(!fixture.recovery.join(JOURNAL_NAME).exists());
    assert!(!fixture.recovery.join("transaction.pending").exists());
}

#[test]
fn rollback_preserves_journal_when_pending_publication_is_malformed() {
    let fixture = Fixture::new();
    let mut legacy = fixture.open();
    legacy
        .prepare(Choice::Migrate, ServiceStatus::NotRegistered)
        .unwrap();
    legacy.stage().unwrap();
    legacy.fail_journal_publication_at_for_test(JournalPublicationFailpoint::Replacement);
    assert_eq!(
        legacy.checkpoint(Phase::LegacyStaged),
        Err(super::super::super::RECOVERY_FAILED)
    );
    fs::write(fixture.recovery.join("transaction.pending"), b"{invalid").unwrap();

    legacy.restore().unwrap();
    assert_eq!(
        legacy.finish_rollback(),
        Err(super::super::super::RECOVERY_FAILED)
    );
    assert!(fixture.source.exists());
    assert!(fixture.recovery.join(JOURNAL_NAME).exists());
    assert!(fixture.recovery.join("transaction.pending").exists());
}

#[test]
fn resume_rejects_pending_from_another_transaction_without_cleaning_evidence() {
    let fixture = Fixture::new();
    let mut legacy = fixture.open();
    legacy
        .prepare(Choice::Migrate, ServiceStatus::NotRegistered)
        .unwrap();
    legacy.stage().unwrap();
    let mut pending = Journal::prepared(
        &fixture.configuration,
        Choice::TurnOff,
        ServiceStatus::NotRegistered,
    )
    .unwrap();
    pending.phase = JournalPhase::LegacyStaged;
    fs::write(
        fixture.recovery.join("transaction.pending"),
        pending.encode().unwrap(),
    )
    .unwrap();
    fs::set_permissions(
        fixture.recovery.join("transaction.pending"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    drop(legacy);

    assert!(matches!(
        fixture.resume(),
        Err(super::super::super::RECOVERY_FAILED)
    ));
    assert!(fixture.recovery.join(JOURNAL_NAME).exists());
    assert!(fixture.recovery.join(BACKUP_NAME).exists());
    assert!(fixture.recovery.join("transaction.pending").exists());
}

#[test]
fn resume_rejects_advanced_pending_without_its_published_journal() {
    let fixture = Fixture::new();
    let mut legacy = fixture.open();
    legacy
        .prepare(Choice::Migrate, ServiceStatus::NotRegistered)
        .unwrap();
    legacy.stage().unwrap();
    legacy.fail_journal_publication_at_for_test(JournalPublicationFailpoint::Replacement);
    assert_eq!(
        legacy.checkpoint(Phase::LegacyStaged),
        Err(super::super::super::RECOVERY_FAILED)
    );
    drop(legacy);
    fs::remove_file(fixture.recovery.join(JOURNAL_NAME)).unwrap();

    assert!(matches!(
        fixture.resume(),
        Err(super::super::super::RECOVERY_FAILED)
    ));
    assert!(!fixture.recovery.join(JOURNAL_NAME).exists());
    assert!(fixture.recovery.join(BACKUP_NAME).exists());
    assert!(fixture.recovery.join("transaction.pending").exists());
}

#[test]
fn forward_committed_journal_rejects_any_pending_record() {
    let fixture = Fixture::new();
    let mut legacy = fixture.open();
    legacy
        .prepare(Choice::Migrate, ServiceStatus::NotRegistered)
        .unwrap();
    legacy.stage().unwrap();
    legacy.checkpoint(Phase::LegacyStaged).unwrap();
    legacy.fail_commit_at_for_test(CommitFailpoint::AfterForwardCommit);
    assert_eq!(legacy.commit(), Err(super::super::super::RECOVERY_FAILED));
    drop(legacy);
    let journal = fs::read(fixture.recovery.join(JOURNAL_NAME)).unwrap();
    fs::write(fixture.recovery.join("transaction.pending"), journal).unwrap();
    fs::set_permissions(
        fixture.recovery.join("transaction.pending"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();

    assert!(matches!(
        fixture.resume(),
        Err(super::super::super::RECOVERY_FAILED)
    ));
    assert!(fixture.recovery.join(JOURNAL_NAME).exists());
    assert!(fixture.recovery.join(BACKUP_NAME).exists());
    assert!(fixture.recovery.join("transaction.pending").exists());
}
