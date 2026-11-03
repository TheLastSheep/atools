use std::{
    collections::VecDeque,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
};

use tempfile::TempDir;

use super::super::super::{
    transaction::{ServicePort, ServiceStatus},
    CONFLICT, RECOVERY_FAILED, UNAVAILABLE,
};
use super::super::{
    configuration,
    durable::DurableLegacy,
    host_paths::HostPaths,
    migration::{Choice, LegacyPort, Phase},
};
use super::{inspect, recover_existing, resolve, LegacyLoginChoice};

struct FakeModern {
    status: ServiceStatus,
    status_reads: usize,
    requested: Vec<bool>,
    after_set: VecDeque<ServiceStatus>,
}

impl FakeModern {
    fn new(status: ServiceStatus) -> Self {
        Self {
            status,
            status_reads: 0,
            requested: Vec::new(),
            after_set: VecDeque::new(),
        }
    }
}

impl ServicePort for FakeModern {
    fn status(&mut self) -> Result<ServiceStatus, &'static str> {
        self.status_reads += 1;
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

struct Fixture {
    _temp: TempDir,
    paths: HostPaths,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let app_data = root.join("app-data");
        let launch_agents = root.join("LaunchAgents");
        let bin = root.join("App.app/Contents/MacOS");
        fs::create_dir_all(&app_data).unwrap();
        fs::create_dir_all(&launch_agents).unwrap();
        fs::create_dir_all(&bin).unwrap();
        fs::set_permissions(&app_data, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&launch_agents, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(root.join("App.app"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(
            root.join("App.app/Contents"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        let executable = bin.join("ATools");
        fs::write(&executable, b"fixture executable").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let source = launch_agents.join("com.atools.desktop.plist");
        let paths = HostPaths::for_test(app_data, source, executable);
        Self { _temp: temp, paths }
    }

    fn write_legacy(&self) {
        let xml = crate::general_settings_runtime::login_items::legacy_plist(
            &self.paths.executable.to_string_lossy(),
        );
        fs::write(&self.paths.source, xml).unwrap();
        fs::set_permissions(&self.paths.source, fs::Permissions::from_mode(0o600)).unwrap();
    }

    fn rewrite_legacy(&self) {
        let replacement = self.paths.source.with_file_name("legacy-replacement.plist");
        let xml = crate::general_settings_runtime::login_items::legacy_plist(
            &self.paths.executable.to_string_lossy(),
        );
        fs::write(&replacement, xml).unwrap();
        fs::set_permissions(&replacement, fs::Permissions::from_mode(0o600)).unwrap();
        fs::rename(replacement, &self.paths.source).unwrap();
    }

    fn stage_interrupted_transaction(&self, before: ServiceStatus) {
        self.paths.ensure_recovery_directory().unwrap();
        let configuration = configuration::inspect(
            &self.paths.source,
            "com.atools.desktop",
            &self.paths.executable,
        )
        .unwrap()
        .unwrap();
        let mut legacy = DurableLegacy::open(configuration, &self.paths.recovery).unwrap();
        legacy.prepare(Choice::Migrate, before).unwrap();
        legacy.stage().unwrap();
        legacy.checkpoint(Phase::LegacyStaged).unwrap();
        drop(legacy);
    }
}

#[test]
fn inspection_is_fixed_shape_and_choice_names_are_closed() {
    let fixture = Fixture::new();
    fixture.write_legacy();
    let mut modern = FakeModern::new(ServiceStatus::NotFound);
    let value = inspect(&fixture.paths, &mut modern).unwrap();
    assert_eq!(value.modern_enabled, false);
    assert_eq!(value.revision.len(), 64);
    assert!(value
        .revision
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    assert_eq!(
        serde_json::to_value(&value).unwrap(),
        serde_json::json!({"modernEnabled":false,"revision":value.revision})
    );
    assert_eq!(
        serde_json::to_string(&LegacyLoginChoice::TurnOff).unwrap(),
        "\"turnOff\""
    );
    assert_eq!(
        serde_json::to_string(&LegacyLoginChoice::Migrate).unwrap(),
        "\"migrate\""
    );
    assert!(serde_json::from_str::<LegacyLoginChoice>("\"delete\"").is_err());
}

#[test]
fn inspection_requires_a_validated_legacy_file_before_reading_modern_state() {
    let fixture = Fixture::new();
    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    assert_eq!(inspect(&fixture.paths, &mut modern), Err(CONFLICT));
    assert_eq!(modern.status_reads, 0);
}

#[test]
fn both_choices_preserve_all_known_raw_disabled_and_enabled_states() {
    for before in [
        ServiceStatus::NotRegistered,
        ServiceStatus::Enabled,
        ServiceStatus::NotFound,
    ] {
        for choice in [LegacyLoginChoice::TurnOff, LegacyLoginChoice::Migrate] {
            let fixture = Fixture::new();
            fixture.write_legacy();
            let enabled_before = matches!(before, ServiceStatus::Enabled);
            let target = choice == LegacyLoginChoice::Migrate;
            let mut modern = FakeModern::new(before);
            let inspection = inspect(&fixture.paths, &mut modern).unwrap();
            assert_eq!(inspection.modern_enabled, enabled_before);

            assert_eq!(
                resolve(
                    &fixture.paths,
                    &mut modern,
                    choice,
                    enabled_before,
                    &inspection.revision,
                ),
                Ok(target)
            );
            assert_eq!(
                modern.status,
                if target {
                    ServiceStatus::Enabled
                } else if before == ServiceStatus::NotFound {
                    ServiceStatus::NotFound
                } else {
                    ServiceStatus::NotRegistered
                }
            );
            assert!(!fixture.paths.source.exists());
            assert_eq!(
                fixture.paths.recovery.join("transaction.json").exists(),
                false
            );
            assert_eq!(
                modern.requested,
                if enabled_before == target {
                    vec![]
                } else {
                    vec![target]
                }
            );
        }
    }
}

#[test]
fn stale_revision_and_modern_cas_conflict_do_not_create_recovery_state() {
    let fixture = Fixture::new();
    fixture.write_legacy();
    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    let inspection = inspect(&fixture.paths, &mut modern).unwrap();
    assert_eq!(
        resolve(
            &fixture.paths,
            &mut modern,
            LegacyLoginChoice::Migrate,
            false,
            "bad-revision",
        ),
        Err(CONFLICT)
    );
    assert!(!fixture.paths.recovery.exists());
    assert!(modern.requested.is_empty());
    fixture.rewrite_legacy();
    let before_writes = modern.requested.len();
    assert_eq!(
        resolve(
            &fixture.paths,
            &mut modern,
            LegacyLoginChoice::Migrate,
            false,
            &inspection.revision,
        ),
        Err(CONFLICT)
    );
    assert!(!fixture.paths.recovery.exists());
    assert_eq!(modern.requested.len(), before_writes);

    let second = Fixture::new();
    second.write_legacy();
    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    let inspection = inspect(&second.paths, &mut modern).unwrap();
    modern.status = ServiceStatus::Enabled;
    assert_eq!(
        resolve(
            &second.paths,
            &mut modern,
            LegacyLoginChoice::Migrate,
            false,
            &inspection.revision,
        ),
        Err(CONFLICT)
    );
    assert!(!second.paths.recovery.exists());
    assert!(modern.requested.is_empty());
}

#[test]
fn no_recovery_artifacts_do_not_create_paths_lock_or_read_modern_state() {
    let fixture = Fixture::new();
    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    assert_eq!(recover_existing(&fixture.paths, &mut modern), Ok(()));
    assert_eq!(modern.status_reads, 0);
    assert!(!fixture.paths.recovery.exists());

    fixture.paths.ensure_recovery_directory().unwrap();
    modern.status_reads = 0;
    assert_eq!(recover_existing(&fixture.paths, &mut modern), Ok(()));
    assert_eq!(modern.status_reads, 0);
    assert!(!fixture
        .paths
        .recovery
        .join(".login-item-migration.lock")
        .exists());
}

#[test]
fn valid_lock_only_recovery_root_is_read_only_noop() {
    let fixture = Fixture::new();
    fixture.paths.ensure_recovery_directory().unwrap();
    let lock = fixture.paths.recovery.join(".login-item-migration.lock");
    fs::write(&lock, b"").unwrap();
    fs::set_permissions(&lock, fs::Permissions::from_mode(0o600)).unwrap();
    let before = fs::symlink_metadata(&lock).unwrap();

    let mut modern = FakeModern::new(ServiceStatus::Enabled);
    assert_eq!(recover_existing(&fixture.paths, &mut modern), Ok(()));
    assert_eq!(modern.status_reads, 0);
    assert!(modern.requested.is_empty());

    let after = fs::symlink_metadata(&lock).unwrap();
    assert_eq!(before.dev(), after.dev());
    assert_eq!(before.ino(), after.ino());
    assert_eq!(before.uid(), after.uid());
    assert_eq!(before.mode(), after.mode());
    assert_eq!(before.nlink(), after.nlink());
    assert_eq!(before.len(), after.len());
    assert!(!fixture.paths.recovery.join("transaction.json").exists());
    assert!(!fixture.paths.recovery.join("transaction.pending").exists());
    assert!(!fixture
        .paths
        .recovery
        .join("legacy-login-item.plist")
        .exists());
}

#[test]
fn symlink_lock_entry_fails_closed_without_following_or_mutating_it() {
    let fixture = Fixture::new();
    fixture.paths.ensure_recovery_directory().unwrap();
    let target = fixture._temp.path().join("lock-target");
    fs::write(&target, b"untouched").unwrap();
    let lock = fixture.paths.recovery.join(".login-item-migration.lock");
    std::os::unix::fs::symlink(&target, &lock).unwrap();

    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    assert_eq!(
        recover_existing(&fixture.paths, &mut modern),
        Err(RECOVERY_FAILED)
    );
    assert_eq!(modern.status_reads, 0);
    assert_eq!(fs::read(&target).unwrap(), b"untouched");
    assert!(fs::symlink_metadata(&lock)
        .unwrap()
        .file_type()
        .is_symlink());
}

#[test]
fn absent_app_data_root_means_no_recovery_without_creating_or_reading_service() {
    let fixture = Fixture::new();
    fs::remove_dir(&fixture.paths.app_data).unwrap();
    let mut modern = FakeModern::new(ServiceStatus::Enabled);
    assert_eq!(recover_existing(&fixture.paths, &mut modern), Ok(()));
    assert_eq!(modern.status_reads, 0);
    assert!(!fixture.paths.app_data.exists());
}

#[test]
fn inspect_and_resolve_recover_durable_transactions_before_using_the_source() {
    let first = Fixture::new();
    first.write_legacy();
    first.stage_interrupted_transaction(ServiceStatus::NotRegistered);
    assert!(!first.paths.source.exists());
    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    let inspection = inspect(&first.paths, &mut modern).unwrap();
    assert!(first.paths.source.exists());
    assert!(!first.paths.recovery.join("transaction.json").exists());
    assert_eq!(modern.requested, Vec::<bool>::new());
    assert!(!inspection.modern_enabled);

    let second = Fixture::new();
    second.write_legacy();
    second.stage_interrupted_transaction(ServiceStatus::NotRegistered);
    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    let inspection = inspect(&second.paths, &mut modern).unwrap();
    assert_eq!(
        resolve(
            &second.paths,
            &mut modern,
            LegacyLoginChoice::Migrate,
            false,
            &inspection.revision,
        ),
        Ok(true)
    );
    assert!(modern.status == ServiceStatus::Enabled);
    assert!(!second.paths.source.exists());
    assert!(!second.paths.recovery.join("transaction.json").exists());
}

#[test]
fn ambiguous_recovery_keeps_the_journal_and_backup() {
    let fixture = Fixture::new();
    fixture.write_legacy();
    fixture.stage_interrupted_transaction(ServiceStatus::NotRegistered);
    let mut modern = FakeModern::new(ServiceStatus::RequiresApproval);
    assert_eq!(inspect(&fixture.paths, &mut modern), Err(RECOVERY_FAILED));
    assert!(!fixture.paths.source.exists());
    assert!(fixture.paths.recovery.join("transaction.json").exists());
    assert!(fixture
        .paths
        .recovery
        .join("legacy-login-item.plist")
        .exists());
    assert!(modern.requested.is_empty());
}

#[test]
fn invalid_source_executable_and_recovery_root_fail_closed() {
    let malformed = Fixture::new();
    fs::write(&malformed.paths.source, b"not a plist").unwrap();
    assert_eq!(
        inspect(
            &malformed.paths,
            &mut FakeModern::new(ServiceStatus::NotRegistered)
        ),
        Err(UNAVAILABLE)
    );

    let non_executable = Fixture::new();
    non_executable.write_legacy();
    fs::set_permissions(
        &non_executable.paths.executable,
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert_eq!(
        inspect(
            &non_executable.paths,
            &mut FakeModern::new(ServiceStatus::NotRegistered)
        ),
        Err(UNAVAILABLE)
    );

    let invalid_root = Fixture::new();
    let target = invalid_root._temp.path().join("other");
    fs::create_dir(&target).unwrap();
    std::os::unix::fs::symlink(&target, &invalid_root.paths.recovery).unwrap();
    let mut modern = FakeModern::new(ServiceStatus::NotRegistered);
    assert_eq!(
        recover_existing(&invalid_root.paths, &mut modern),
        Err(RECOVERY_FAILED)
    );
    assert_eq!(modern.status_reads, 0);
}

#[test]
fn empty_private_test_root_is_canonical_and_bound_to_app_data() {
    let fixture = Fixture::new();
    fixture.paths.ensure_recovery_directory().unwrap();
    let canonical = fixture.paths.recovery.canonicalize().unwrap();
    assert_eq!(canonical, fixture.paths.recovery);
    assert!(fixture.paths.recovery.starts_with(&fixture.paths.app_data));
}
