use super::{assert_files, assert_no_set, recover, FakeModern, Fixture, RecoveryOutcome};
use crate::general_settings_runtime::login_items::{
    legacy::{
        durable::{DurableLegacy, JournalPublicationFailpoint},
        journal::JournalPhase,
        migration::{Choice, LegacyPort, Phase},
    },
    transaction::ServiceStatus,
    RECOVERY_FAILED,
};
use std::fs;

const PENDING_NAME: &str = "transaction.pending";

#[test]
fn initial_prepared_publication_pending_is_published_then_rolled_back_after_restart() {
    let fixture = Fixture::new();
    let mut writer = DurableLegacy::open(fixture.validated(), &fixture.recovery).unwrap();
    writer.fail_journal_publication_at_for_test(JournalPublicationFailpoint::InitialPrepared);
    assert_eq!(
        writer.prepare(Choice::Migrate, ServiceStatus::NotRegistered),
        Err(RECOVERY_FAILED)
    );
    assert!(fixture.recovery.join(PENDING_NAME).is_file());
    assert!(!fixture.recovery.join("transaction.json").exists());
    drop(writer);

    let mut resumed = fixture.resume();
    assert_eq!(resumed.journal().unwrap().phase, JournalPhase::Prepared);
    assert!(!fixture.recovery.join(PENDING_NAME).exists());
    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    assert_eq!(
        recover(&mut modern, &mut resumed),
        Ok(RecoveryOutcome::RolledBack)
    );
    assert_no_set(&modern);
    assert_files(&resumed, true, false);
    drop(resumed);
    fixture.assert_record_cleared();
}

#[test]
fn staged_checkpoint_replacement_pending_restores_from_published_prepared_record() {
    let fixture = Fixture::new();
    let mut writer = fixture.begin(Choice::Migrate, ServiceStatus::NotRegistered);
    writer.stage().unwrap();
    writer.fail_journal_publication_at_for_test(JournalPublicationFailpoint::Replacement);
    assert_eq!(writer.checkpoint(Phase::LegacyStaged), Err(RECOVERY_FAILED));
    assert_eq!(writer.journal().unwrap().phase, JournalPhase::Prepared);
    assert!(fixture.recovery.join(PENDING_NAME).is_file());
    assert_files(&writer, false, true);
    drop(writer);

    let mut resumed = fixture.resume();
    assert_eq!(resumed.journal().unwrap().phase, JournalPhase::Prepared);
    assert!(!fixture.recovery.join(PENDING_NAME).exists());
    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    assert_eq!(
        recover(&mut modern, &mut resumed),
        Ok(RecoveryOutcome::RolledBack)
    );
    assert_no_set(&modern);
    assert_files(&resumed, true, false);
    drop(resumed);
    fixture.assert_record_cleared();
}

#[test]
fn replacement_pending_after_restored_source_resumes_and_rolls_back() {
    let fixture = Fixture::new();
    let mut writer = fixture.begin(Choice::Migrate, ServiceStatus::NotRegistered);
    writer.stage().unwrap();
    writer.fail_journal_publication_at_for_test(JournalPublicationFailpoint::Replacement);
    assert_eq!(writer.checkpoint(Phase::LegacyStaged), Err(RECOVERY_FAILED));
    writer.restore().unwrap();
    assert_files(&writer, true, false);
    assert!(fixture.recovery.join(PENDING_NAME).is_file());
    assert!(fixture.recovery.join("transaction.json").is_file());
    drop(writer);

    let mut resumed = fixture.resume();
    assert_eq!(resumed.journal().unwrap().phase, JournalPhase::Prepared);
    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    assert_eq!(
        recover(&mut modern, &mut resumed),
        Ok(RecoveryOutcome::RolledBack)
    );
    assert_no_set(&modern);
    assert_files(&resumed, true, false);
    assert!(!fixture.recovery.join(PENDING_NAME).exists());
    drop(resumed);
    fixture.assert_record_cleared();
}

#[test]
fn staged_checkpoint_pending_with_modern_target_resumes_forward_commit() {
    let fixture = Fixture::new();
    let mut writer = fixture.begin(Choice::Migrate, ServiceStatus::NotRegistered);
    writer.stage().unwrap();
    writer.fail_journal_publication_at_for_test(JournalPublicationFailpoint::Replacement);
    assert_eq!(writer.checkpoint(Phase::LegacyStaged), Err(RECOVERY_FAILED));
    drop(writer);

    let mut resumed = fixture.resume();
    assert_eq!(resumed.journal().unwrap().phase, JournalPhase::Prepared);
    assert!(!fixture.recovery.join(PENDING_NAME).exists());
    let mut modern = FakeModern::new(ServiceStatus::Enabled);
    assert_eq!(
        recover(&mut modern, &mut resumed),
        Ok(RecoveryOutcome::Committed)
    );
    assert_no_set(&modern);
    assert_files(&resumed, false, false);
    drop(resumed);
    fixture.assert_record_cleared();
}

#[test]
fn malformed_replacement_pending_keeps_published_journal_and_backup() {
    let fixture = Fixture::new();
    let mut writer = fixture.begin(Choice::Migrate, ServiceStatus::NotRegistered);
    writer.stage().unwrap();
    writer.fail_journal_publication_at_for_test(JournalPublicationFailpoint::Replacement);
    assert_eq!(writer.checkpoint(Phase::LegacyStaged), Err(RECOVERY_FAILED));
    drop(writer);
    fs::write(fixture.recovery.join(PENDING_NAME), b"{corrupt").unwrap();

    assert_eq!(
        DurableLegacy::resume(&fixture.source, &fixture.executable, &fixture.recovery).err(),
        Some(RECOVERY_FAILED)
    );
    assert!(fixture.recovery.join(PENDING_NAME).is_file());
    assert!(fixture.recovery.join("transaction.json").is_file());
    assert!(fixture.recovery.join("legacy-login-item.plist").is_file());
    assert!(!fixture.source.exists());
}
