use super::{inspect, FileIdentity};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{symlink, MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
};
use tempfile::TempDir;

const LABEL: &str = "com.atools.desktop";

struct Fixture {
    _root: TempDir,
    source: PathBuf,
    executable: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = TempDir::new().unwrap();
        let root_path = root.path().canonicalize().unwrap();
        let parent = root_path.join("LaunchAgents");
        fs::create_dir(&parent).unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
        let executable = root_path.join("ATools");
        fs::write(&executable, b"private test executable").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        Self {
            source: parent.join("com.atools.desktop.plist"),
            executable,
            _root: root,
        }
    }

    fn write(&self, bytes: &[u8]) {
        fs::write(&self.source, bytes).unwrap();
        fs::set_permissions(&self.source, fs::Permissions::from_mode(0o600)).unwrap();
    }

    fn inspect(&self) -> Result<Option<super::ValidatedConfiguration>, &'static str> {
        inspect(&self.source, LABEL, &self.executable)
    }
}

fn xml_string(key: &str, value: &str) -> String {
    format!("<key>{key}</key><string>{}</string>", escape_xml(value))
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn xml_plist(
    label: &str,
    run_at_load: bool,
    program: Option<&str>,
    arguments: Option<&[&str]>,
    extra: &str,
) -> Vec<u8> {
    let mut entries = xml_string("Label", label);
    entries.push_str("<key>RunAtLoad</key>");
    entries.push_str(if run_at_load { "<true/>" } else { "<false/>" });
    if let Some(program) = program {
        entries.push_str(&xml_string("Program", program));
    }
    if let Some(arguments) = arguments {
        entries.push_str("<key>ProgramArguments</key><array>");
        for argument in arguments {
            entries.push_str(&format!("<string>{}</string>", escape_xml(argument)));
        }
        entries.push_str("</array>");
    }
    entries.push_str(extra);
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict>{entries}</dict></plist>"
    )
    .into_bytes()
}

#[derive(Serialize)]
struct BinaryPlist {
    #[serde(rename = "Label")]
    label: String,
    #[serde(rename = "RunAtLoad")]
    run_at_load: bool,
    #[serde(rename = "Program")]
    program: String,
}

fn binary_plist(executable: &Path) -> Vec<u8> {
    let mut bytes = Vec::new();
    plist::to_writer_binary(
        &mut bytes,
        &BinaryPlist {
            label: LABEL.to_owned(),
            run_at_load: true,
            program: executable.to_string_lossy().into_owned(),
        },
    )
    .unwrap();
    bytes
}

fn reject(fixture: &Fixture, bytes: &[u8]) {
    fixture.write(bytes);
    assert_eq!(fixture.inspect(), Err(super::super::super::UNAVAILABLE));
}

#[test]
fn accepts_legacy_xml_and_preserves_raw_identity_hash_and_metadata() {
    let fixture = Fixture::new();
    let bytes = xml_plist(
        LABEL,
        true,
        None,
        Some(&[fixture.executable.to_str().unwrap()]),
        "",
    );
    fixture.write(&bytes);
    let metadata = fs::symlink_metadata(&fixture.source).unwrap();
    let validated = fixture.inspect().unwrap().unwrap();

    assert_eq!(validated.source, fixture.source);
    assert_eq!(validated.executable, fixture.executable);
    assert_eq!(validated.bytes, bytes);
    assert_eq!(
        validated.sha256,
        format!("{:x}", Sha256::digest(&validated.bytes))
    );
    assert_eq!(
        validated.identity,
        FileIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
            uid: metadata.uid(),
            gid: metadata.gid(),
            mode: metadata.mode(),
            length: metadata.len(),
            mtime_seconds: metadata.mtime(),
            mtime_nanoseconds: metadata.mtime_nsec(),
            ctime_seconds: metadata.ctime(),
            ctime_nanoseconds: metadata.ctime_nsec(),
        }
    );
}

#[test]
fn rename_preserves_validated_bytes_and_compares_only_rename_stable_metadata() {
    let fixture = Fixture::new();
    let bytes = xml_plist(
        LABEL,
        true,
        Some(fixture.executable.to_str().unwrap()),
        None,
        "",
    );
    fixture.write(&bytes);
    let before_rename = fixture.inspect().unwrap().unwrap();
    let backup = fixture.source.with_extension("plist.backup");
    fs::rename(&fixture.source, &backup).unwrap();

    let after_rename = inspect(&backup, LABEL, &fixture.executable)
        .unwrap()
        .unwrap();
    assert!(before_rename
        .identity
        .preserved_metadata_after_rename(&after_rename.identity));
    assert_eq!(after_rename.bytes, before_rename.bytes);
    assert_eq!(after_rename.sha256, before_rename.sha256);
    assert!(!fixture.source.exists());

    fs::set_permissions(&backup, fs::Permissions::from_mode(0o644)).unwrap();
    let changed_mode = inspect(&backup, LABEL, &fixture.executable)
        .unwrap()
        .unwrap();
    assert!(!after_rename
        .identity
        .preserved_metadata_after_rename(&changed_mode.identity));
}

#[test]
fn accepts_binary_and_program_only_legacy_forms() {
    let binary = Fixture::new();
    binary.write(&binary_plist(&binary.executable));
    assert!(binary.inspect().unwrap().is_some());

    let program = Fixture::new();
    program.write(&xml_plist(
        LABEL,
        true,
        Some(program.executable.to_str().unwrap()),
        None,
        "",
    ));
    assert!(program.inspect().unwrap().is_some());
}

#[test]
fn accepts_matching_program_and_single_program_argument() {
    let fixture = Fixture::new();
    let path = fixture.executable.to_str().unwrap();
    fixture.write(&xml_plist(LABEL, true, Some(path), Some(&[path]), ""));
    assert!(fixture.inspect().unwrap().is_some());
}

#[test]
fn only_an_absent_source_in_a_valid_parent_is_none() {
    let fixture = Fixture::new();
    assert_eq!(fixture.inspect(), Ok(None));

    let missing_parent = fixture
        .source
        .parent()
        .unwrap()
        .join("missing")
        .join("job.plist");
    assert_eq!(
        inspect(&missing_parent, LABEL, &fixture.executable),
        Err(super::super::super::UNAVAILABLE)
    );
}

#[test]
fn rejects_wrong_identity_unknown_or_duplicate_keys_and_disabled_jobs() {
    let fixture = Fixture::new();
    let path = fixture.executable.to_str().unwrap();
    reject(
        &fixture,
        &xml_plist("other.label", true, Some(path), None, ""),
    );
    reject(&fixture, &xml_plist(LABEL, false, Some(path), None, ""));
    reject(
        &fixture,
        &xml_plist(LABEL, true, Some("/bin/false"), None, ""),
    );
    reject(
        &fixture,
        &xml_plist(LABEL, true, Some(path), None, "<key>KeepAlive</key><true/>"),
    );
    reject(
        &fixture,
        &xml_plist(LABEL, true, Some(path), None, &xml_string("Label", LABEL)),
    );
}

#[test]
fn rejects_extra_arguments_missing_executable_and_malformed_plists() {
    let fixture = Fixture::new();
    let path = fixture.executable.to_str().unwrap();
    reject(&fixture, &xml_plist(LABEL, true, None, None, ""));
    reject(&fixture, &xml_plist(LABEL, true, None, Some(&[]), ""));
    reject(
        &fixture,
        &xml_plist(LABEL, true, None, Some(&[path, "--background"]), ""),
    );
    fixture.write(b"<plist><dict><key>Label</key>");
    assert_eq!(fixture.inspect(), Err(super::super::super::UNAVAILABLE));
}

#[test]
fn rejects_empty_and_oversized_sources() {
    let fixture = Fixture::new();
    fs::write(&fixture.source, b"").unwrap();
    fs::set_permissions(&fixture.source, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(fixture.inspect(), Err(super::super::super::UNAVAILABLE));

    fs::write(&fixture.source, vec![b'x'; 16 * 1024 + 1]).unwrap();
    fs::set_permissions(&fixture.source, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(fixture.inspect(), Err(super::super::super::UNAVAILABLE));
}

#[test]
fn rejects_source_symlink_hardlink_and_group_or_world_writable_file() {
    let fixture = Fixture::new();
    let bytes = xml_plist(
        LABEL,
        true,
        Some(fixture.executable.to_str().unwrap()),
        None,
        "",
    );
    fixture.write(&bytes);
    let alternate = fixture.source.with_extension("alternate");
    symlink(&fixture.source, &alternate).unwrap();
    assert_eq!(
        inspect(&alternate, LABEL, &fixture.executable),
        Err(super::super::super::UNAVAILABLE)
    );
    fs::remove_file(&alternate).unwrap();

    fs::hard_link(&fixture.source, &alternate).unwrap();
    assert_eq!(fixture.inspect(), Err(super::super::super::UNAVAILABLE));
    fs::remove_file(&alternate).unwrap();

    fs::set_permissions(&fixture.source, fs::Permissions::from_mode(0o666)).unwrap();
    assert_eq!(fixture.inspect(), Err(super::super::super::UNAVAILABLE));
}

#[test]
fn rejects_symlink_or_world_writable_parent_and_noncanonical_paths() {
    let fixture = Fixture::new();
    fixture.write(&xml_plist(
        LABEL,
        true,
        Some(fixture.executable.to_str().unwrap()),
        None,
        "",
    ));
    let parent = fixture.source.parent().unwrap();
    let alias = fixture._root.path().join("LaunchAgentsAlias");
    symlink(parent, &alias).unwrap();
    let aliased_source = alias.join(fixture.source.file_name().unwrap());
    assert_eq!(
        inspect(&aliased_source, LABEL, &fixture.executable),
        Err(super::super::super::UNAVAILABLE)
    );
    let dotted_source = parent.join(".").join(fixture.source.file_name().unwrap());
    assert_eq!(
        inspect(&dotted_source, LABEL, &fixture.executable),
        Err(super::super::super::UNAVAILABLE)
    );

    fs::set_permissions(parent, fs::Permissions::from_mode(0o777)).unwrap();
    assert_eq!(fixture.inspect(), Err(super::super::super::UNAVAILABLE));
}

#[test]
fn rejects_non_executable_expected_path() {
    let fixture = Fixture::new();
    let non_executable = fixture._root.path().join("not-executable");
    fs::write(&non_executable, b"file").unwrap();
    fs::set_permissions(&non_executable, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        inspect(&fixture.source, LABEL, &non_executable),
        Err(super::super::super::UNAVAILABLE)
    );
}
