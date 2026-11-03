use super::{Journal, JournalPhase, MAX_JOURNAL_BYTES};
use crate::general_settings_runtime::login_items::{
    legacy::{configuration::ValidatedConfiguration, migration::Choice},
    transaction::ServiceStatus,
    RECOVERY_FAILED, UNAVAILABLE,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

fn fixture() -> ValidatedConfiguration {
    let bytes = b"private validated launch configuration".to_vec();
    let executable = std::env::current_exe().unwrap().canonicalize().unwrap();
    ValidatedConfiguration {
        source: PathBuf::from("/private/fixture/com.atools.desktop.plist"),
        executable,
        identity: super::super::configuration::FileIdentity {
            device: 1,
            inode: 2,
            uid: unsafe { libc::getuid() },
            gid: unsafe { libc::getgid() },
            mode: libc::S_IFREG as u32 | 0o600,
            length: bytes.len() as u64,
            mtime_seconds: 1_700_000_000,
            mtime_nanoseconds: 999_999_999,
            ctime_seconds: 1_700_000_001,
            ctime_nanoseconds: 0,
        },
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        bytes,
    }
}

fn encoded(choice: Choice, status: ServiceStatus) -> (Vec<u8>, PathBuf) {
    let config = fixture();
    let executable = config.executable.clone();
    (
        Journal::prepared(&config, choice, status)
            .unwrap()
            .encode()
            .unwrap(),
        executable,
    )
}

fn edited(mut bytes: Vec<u8>, edit: impl FnOnce(&mut Value)) -> Vec<u8> {
    let mut value: Value = serde_json::from_slice(&bytes).unwrap();
    edit(&mut value);
    bytes.clear();
    serde_json::to_vec(&value).unwrap()
}

#[test]
fn all_choices_and_allowed_raw_service_states_round_trip_exactly() {
    let cases = [
        (Choice::TurnOff, ServiceStatus::NotRegistered, 0),
        (Choice::Migrate, ServiceStatus::NotRegistered, 0),
        (Choice::TurnOff, ServiceStatus::Enabled, 1),
        (Choice::Migrate, ServiceStatus::Enabled, 1),
        (Choice::TurnOff, ServiceStatus::NotFound, 3),
        (Choice::Migrate, ServiceStatus::NotFound, 3),
    ];
    for (choice, status, raw) in cases {
        let config = fixture();
        let executable = config.executable.clone();
        let mut journal = Journal::prepared(&config, choice, status).unwrap();
        assert_eq!(journal.modern_before_raw, raw);
        for phase in [
            JournalPhase::Prepared,
            JournalPhase::LegacyStaged,
            JournalPhase::ModernVerified,
            JournalPhase::ForwardCommitted,
        ] {
            journal.phase = phase;
            let bytes = journal.encode().unwrap();
            assert!(bytes.len() <= MAX_JOURNAL_BYTES);
            assert_eq!(Journal::decode(&bytes, &executable).unwrap(), journal);
        }
    }
}

#[test]
fn preparation_rejects_unapproved_or_unknown_service_status_and_bad_snapshot() {
    let config = fixture();
    assert_eq!(
        Journal::prepared(&config, Choice::TurnOff, ServiceStatus::RequiresApproval),
        Err(UNAVAILABLE)
    );
    assert_eq!(
        Journal::prepared(&config, Choice::Migrate, ServiceStatus::Unknown(88)),
        Err(UNAVAILABLE)
    );

    let mut bad_hash = fixture();
    bad_hash.sha256.make_ascii_uppercase();
    assert_eq!(
        Journal::prepared(&bad_hash, Choice::TurnOff, ServiceStatus::NotFound),
        Err(UNAVAILABLE)
    );
    let mut bad_bytes = fixture();
    bad_bytes.bytes.push(b'!');
    assert_eq!(
        Journal::prepared(&bad_bytes, Choice::TurnOff, ServiceStatus::NotFound),
        Err(UNAVAILABLE)
    );
}

#[test]
fn decode_rejects_oversize_malformed_duplicate_and_unknown_fields() {
    let (bytes, executable) = encoded(Choice::Migrate, ServiceStatus::NotFound);
    assert_eq!(
        Journal::decode(&vec![b' '; MAX_JOURNAL_BYTES + 1], &executable),
        Err(RECOVERY_FAILED)
    );
    assert_eq!(
        Journal::decode(b"{broken", &executable),
        Err(RECOVERY_FAILED)
    );

    let mut duplicate = String::from_utf8(bytes.clone()).unwrap();
    duplicate = duplicate.replacen(
        "\"schemaVersion\":1,",
        "\"schemaVersion\":1,\"schemaVersion\":1,",
        1,
    );
    assert_eq!(
        Journal::decode(duplicate.as_bytes(), &executable),
        Err(RECOVERY_FAILED)
    );

    let unknown_top = edited(bytes.clone(), |value| value["unexpected"] = json!(true));
    assert_eq!(
        Journal::decode(&unknown_top, &executable),
        Err(RECOVERY_FAILED)
    );
    let unknown_identity = edited(bytes, |value| {
        value["configurationIdentity"]["unexpected"] = json!(1);
    });
    assert_eq!(
        Journal::decode(&unknown_identity, &executable),
        Err(RECOVERY_FAILED)
    );
    let missing_phase = edited(unknown_identity, |value| {
        value.as_object_mut().unwrap().remove("phase");
    });
    assert_eq!(
        Journal::decode(&missing_phase, &executable),
        Err(RECOVERY_FAILED)
    );
}

#[test]
fn decode_rejects_bad_version_choice_phase_hash_raw_status_and_identity() {
    let (bytes, executable) = encoded(Choice::TurnOff, ServiceStatus::NotRegistered);
    let mutations: [(&str, Box<dyn Fn(&mut Value)>); 15] = [
        (
            "version",
            Box::new(|value| value["schemaVersion"] = json!(2)),
        ),
        (
            "choice",
            Box::new(|value| value["choice"] = json!("futureChoice")),
        ),
        ("phase", Box::new(|value| value["phase"] = json!("unknown"))),
        (
            "raw state",
            Box::new(|value| value["modernBeforeRaw"] = json!(2)),
        ),
        (
            "hash length",
            Box::new(|value| value["configurationSha256"] = json!("abc")),
        ),
        (
            "hash case",
            Box::new(|value| value["configurationSha256"] = json!("A".repeat(64))),
        ),
        (
            "zero device",
            Box::new(|value| value["configurationIdentity"]["device"] = json!(0)),
        ),
        (
            "zero inode",
            Box::new(|value| value["configurationIdentity"]["inode"] = json!(0)),
        ),
        (
            "nonfile mode",
            Box::new(|value| value["configurationIdentity"]["mode"] = json!(0o120600)),
        ),
        (
            "special mode",
            Box::new(|value| value["configurationIdentity"]["mode"] = json!(0o104600)),
        ),
        (
            "group writable",
            Box::new(|value| value["configurationIdentity"]["mode"] = json!(0o100620)),
        ),
        (
            "zero length",
            Box::new(|value| value["configurationIdentity"]["length"] = json!(0)),
        ),
        (
            "oversize source",
            Box::new(|value| value["configurationIdentity"]["length"] = json!(16_385)),
        ),
        (
            "nanosecond bound",
            Box::new(|value| {
                value["configurationIdentity"]["mtimeNanoseconds"] = json!(1_000_000_000)
            }),
        ),
        (
            "negative nanoseconds",
            Box::new(|value| value["configurationIdentity"]["ctimeNanoseconds"] = json!(-1)),
        ),
    ];
    for (_name, mutation) in mutations {
        let invalid = edited(bytes.clone(), mutation);
        assert_eq!(Journal::decode(&invalid, &executable), Err(RECOVERY_FAILED));
    }
    let wrong_uid = edited(bytes, |value| {
        let current_uid = unsafe { libc::getuid() };
        value["configurationIdentity"]["uid"] = json!(current_uid.wrapping_add(1));
    });
    assert_eq!(
        Journal::decode(&wrong_uid, &executable),
        Err(RECOVERY_FAILED)
    );
}

#[test]
fn decode_rejects_a_different_or_noncanonical_expected_executable() {
    let (bytes, executable) = encoded(Choice::Migrate, ServiceStatus::Enabled);
    let other = Path::new("/usr/bin/true").canonicalize().unwrap();
    assert_ne!(other, executable);
    assert_eq!(Journal::decode(&bytes, &other), Err(RECOVERY_FAILED));
    let noncanonical = executable
        .parent()
        .unwrap()
        .join(".")
        .join(executable.file_name().unwrap());
    assert_eq!(Journal::decode(&bytes, &noncanonical), Err(RECOVERY_FAILED));

    let noncanonical_record = edited(bytes, |value| {
        value["executable"] = json!(noncanonical.as_os_str().to_string_lossy());
    });
    assert_eq!(
        Journal::decode(&noncanonical_record, &executable),
        Err(RECOVERY_FAILED)
    );
}

#[test]
fn encode_rejects_inconsistent_in_memory_records() {
    let config = fixture();
    let mut journal = Journal::prepared(&config, Choice::TurnOff, ServiceStatus::NotFound).unwrap();
    journal.modern_before_raw = 2;
    assert_eq!(journal.encode(), Err(RECOVERY_FAILED));
}
