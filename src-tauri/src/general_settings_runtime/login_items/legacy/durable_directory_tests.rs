use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tempfile::TempDir;

use super::super::super::transaction::ServiceStatus;
use super::super::configuration::{self, ValidatedConfiguration};
use super::super::durable::DurableLegacy;
use super::super::migration::{Choice, LegacyPort};

const LABEL: &str = "com.atools.desktop";
const BACKUP_NAME: &str = "legacy-login-item.plist";

struct Fixture {
    _root: TempDir,
    source: PathBuf,
    recovery: PathBuf,
    configuration: ValidatedConfiguration,
}

impl Fixture {
    fn new() -> Self {
        let root = TempDir::new().unwrap();
        let root_path = root.path().canonicalize().unwrap();
        let source_directory = root_path.join("LaunchAgents");
        let recovery = root_path.join("Recovery");
        fs::create_dir(&source_directory).unwrap();
        fs::create_dir(&recovery).unwrap();
        fs::set_permissions(&source_directory, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&recovery, fs::Permissions::from_mode(0o700)).unwrap();

        let executable = root_path.join("ATools-test");
        fs::write(&executable, b"private fixture executable").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let source = source_directory.join("com.atools.desktop.plist");
        let bytes = plist_bytes(&executable);
        fs::write(&source, &bytes).unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o600)).unwrap();
        let configuration = configuration::inspect(&source, LABEL, &executable)
            .unwrap()
            .unwrap();

        Self {
            _root: root,
            source,
            recovery,
            configuration,
        }
    }

    fn open_prepared(&self) -> DurableLegacy {
        let mut adapter = DurableLegacy::open(self.configuration.clone(), &self.recovery).unwrap();
        LegacyPort::prepare(&mut adapter, Choice::Migrate, ServiceStatus::NotRegistered).unwrap();
        adapter
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

fn replace_directory(path: &Path, parked: &Path) {
    fs::rename(path, parked).unwrap();
    fs::create_dir(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn replaced_recovery_path_rejects_stage_without_moving_source_or_losing_journal() {
    let fixture = Fixture::new();
    let mut adapter = fixture.open_prepared();
    let parked = fixture._root.path().join("Recovery-parked");
    replace_directory(&fixture.recovery, &parked);

    assert_eq!(
        LegacyPort::stage(&mut adapter),
        Err(super::super::super::RECOVERY_FAILED)
    );
    assert!(fixture.source.exists());
    assert!(parked.join("transaction.json").exists());
    assert!(!parked.join(BACKUP_NAME).exists());
    assert_eq!(fs::read_dir(&fixture.recovery).unwrap().count(), 0);
}

#[test]
fn replaced_recovery_path_cannot_delete_staged_backup_or_journal() {
    let fixture = Fixture::new();
    let mut adapter = fixture.open_prepared();
    LegacyPort::stage(&mut adapter).unwrap();
    assert!(!fixture.source.exists());
    let parked = fixture._root.path().join("Recovery-parked");
    replace_directory(&fixture.recovery, &parked);

    assert_eq!(
        LegacyPort::commit(&mut adapter),
        Err(super::super::super::RECOVERY_FAILED)
    );
    assert!(!fixture.source.exists());
    assert!(parked.join("transaction.json").exists());
    assert!(parked.join(BACKUP_NAME).exists());
    assert_eq!(fs::read_dir(&fixture.recovery).unwrap().count(), 0);
}

#[test]
fn replaced_source_directory_rejects_stage_without_moving_original() {
    let fixture = Fixture::new();
    let mut adapter = fixture.open_prepared();
    let source_directory = fixture.source.parent().unwrap();
    let parked = fixture._root.path().join("LaunchAgents-parked");
    replace_directory(source_directory, &parked);

    assert_eq!(
        LegacyPort::stage(&mut adapter),
        Err(super::super::super::RECOVERY_FAILED)
    );
    assert!(parked.join("com.atools.desktop.plist").exists());
    assert!(!fixture.source.exists());
    assert!(fixture.recovery.join("transaction.json").exists());
    assert!(!fixture.recovery.join(BACKUP_NAME).exists());
}

#[test]
fn recovery_permission_change_rejects_stage_and_preserves_source() {
    let fixture = Fixture::new();
    let mut adapter = fixture.open_prepared();
    fs::set_permissions(&fixture.recovery, fs::Permissions::from_mode(0o750)).unwrap();

    assert_eq!(
        LegacyPort::stage(&mut adapter),
        Err(super::super::super::RECOVERY_FAILED)
    );
    assert!(fixture.source.exists());
    assert!(fixture.recovery.join("transaction.json").exists());
    assert!(!fixture.recovery.join(BACKUP_NAME).exists());
}
