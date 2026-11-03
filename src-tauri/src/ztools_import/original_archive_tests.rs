//! Real, unchanged upstream archive import coverage; no plugin JavaScript is executed.
//!
//! Enable `local-original-archive-fixtures` explicitly: ZTools-plugins is an optional local
//! reference directory, so default workspace tests must not depend on its presence.
//! Once selected, a missing archive or changed pin is a failure, never a skipped test.
use super::{import_ztools_plugins, read_archive_bytes, scan_ztools_plugin_candidates};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs, io::Write, path::Path};

const ARCHIVE_SHA256: &str = "af29034f61199203a4e3161b3e119cd9bca4d544ae7e23127b4e04e7e407b1cd";
// Witnesses were read directly from the pinned original Brotli/ASAR, independently of import.
const FILES: &[(&str, usize, &str)] = &[
    (
        "assets/index-D5L8xNXa.css",
        3600,
        "f40d0e57084a7060423d84bd32101acae160287926f2e14c7b7eb38ed56dd324",
    ),
    (
        "assets/index-DTinetUR.js",
        200437,
        "987d1a7646dd34158a00e2414dec1e71b9c22f24aef1758c80c052b67a15952a",
    ),
    (
        "index.html",
        378,
        "4ecc0edd540133cc79a3692bba761647922dd08d991a15e86963a7c028a4df48",
    ),
    (
        "logo.png",
        27912,
        "353973a52fb415c0c14aeae996e1a2ac4ce1ac6913b1e8559b793870fb37d2e2",
    ),
    (
        "logo.svg",
        4565,
        "2728e5531ed84865f6cef104e641aa5218ec41f1e563f7d692dc44ce26df7376",
    ),
    (
        "plugin.json",
        580,
        "4d15ef10b4b61b94a32c4edc716166570e644eefd676c9dccd4a23cb077f3900",
    ),
    (
        "preload/package.json",
        28,
        "58b55392b5778941e1e96892a70edc12e2d7bb8541289b237fbddc9926ed51bd",
    ),
    (
        "preload/services.js",
        913,
        "a31df2f3c6c9c40cf0056cb2f896f60a11486d34c0c154164f5993da08a8bb3c",
    ),
];

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn installed_files(root: &Path, directory: &Path) -> BTreeSet<String> {
    let mut files = BTreeSet::new();
    for entry in fs::read_dir(directory).expect("Read installed package directory") {
        let path = entry.expect("Read installed entry").path();
        let kind = fs::symlink_metadata(&path).expect("Read installed metadata");
        assert!(
            !kind.is_symlink(),
            "Installed package must not contain links"
        );
        if kind.is_dir() {
            files.extend(installed_files(root, &path));
        } else {
            assert!(kind.is_file(), "Installed entry must be a regular file");
            files.insert(
                path.strip_prefix(root)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .replace('\\', "/"),
            );
        }
    }
    files
}

#[test]
fn scans_original_calculator_source_directory_and_direct_zpx_as_separate_candidates() {
    let root =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../ZTools-plugins/plugins/my-calculator");
    let original = root.join("my-calculator.zpx");
    assert_eq!(
        sha256(&read_archive_bytes(&original).expect("Required original archive; never skip")),
        ARCHIVE_SHA256
    );
    let candidates = scan_ztools_plugin_candidates(&root)
        .expect("Scan unchanged original directory and direct ZPX");
    assert_eq!(candidates.len(), 2);
    assert!(candidates
        .iter()
        .all(|candidate| candidate.name == "my-calculator"
            && candidate.version == "1.0.1"
            && candidate.installation_id.as_deref() == Some("my-calculator")
            && candidate.installation_key.as_deref() == Some("my-calculator")));
    let directory = candidates
        .iter()
        .find(|candidate| candidate.source_type == "directory")
        .unwrap();
    assert_eq!(directory.entry_readiness.as_deref(), Some("requires_build"));
    assert!(!directory.errors.is_empty());
    let archive = candidates
        .iter()
        .find(|candidate| candidate.source_type == "zpx")
        .unwrap();
    assert_eq!(archive.entry_readiness.as_deref(), Some("ready"));
    assert!(archive.errors.is_empty());
    assert_eq!(
        sha256(&read_archive_bytes(&original).unwrap()),
        ARCHIVE_SHA256
    );
}

#[test]
fn imports_hash_pinned_original_calculator_brotli_zpx_without_execution() {
    let original = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../ZTools-plugins/plugins/my-calculator/my-calculator.zpx");
    let bytes = read_archive_bytes(&original).expect(
        "Required original my-calculator.zpx must exist as a bounded regular file; never skip",
    );
    assert_eq!(bytes.len(), 83_406);
    assert_eq!(
        sha256(&bytes),
        ARCHIVE_SHA256,
        "Original archive pin changed"
    );

    let scratch = tempfile::tempdir().expect("Create private archive import fixture");
    let scratch_path = scratch.path().to_path_buf();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&scratch_path, fs::Permissions::from_mode(0o700))
            .expect("Confine the empty fixture root before copying original package bytes");
        assert_eq!(
            fs::metadata(&scratch_path).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    let source = scratch_path.join("my-calculator.zpx");
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut copy = options
        .open(&source)
        .expect("Create private original-byte copy");
    copy.write_all(&bytes)
        .expect("Copy original archive without transformation");
    drop(copy);
    assert_eq!(
        sha256(&read_archive_bytes(&source).unwrap()),
        ARCHIVE_SHA256
    );

    let candidates = scan_ztools_plugin_candidates(&source).expect("Scan the actual original ZPX");
    assert_eq!(candidates.len(), 1);
    let candidate = &candidates[0];
    assert_eq!(candidate.path, source.to_string_lossy());
    assert_eq!(candidate.source_type, "zpx");
    assert_eq!(candidate.name, "my-calculator");
    assert_eq!(candidate.version, "1.0.1");
    assert_eq!(candidate.entry_readiness.as_deref(), Some("ready"));
    assert!(candidate.main_exists && candidate.preload_exists && candidate.logo_exists);
    assert!(candidate.platform_supported && !candidate.headless);
    assert_eq!(candidate.features_count, 1);
    assert!(candidate.errors.is_empty(), "{:?}", candidate.errors);

    let db = atools_core::Database::in_memory().unwrap();
    let install_root = scratch_path.join("installed");
    let report =
        import_ztools_plugins(&db, &install_root, &[source.to_string_lossy().into()], true)
            .expect("Import the real Brotli ZPX through the production importer");
    assert_eq!(report.imported, ["my-calculator"]);
    assert!(report.failed.is_empty() && report.skipped.is_empty());
    let installed = install_root.join("my-calculator");
    let plugin = db
        .get_plugin("my-calculator")
        .expect("Original plugin persisted in SQLite");
    assert_eq!(db.list_plugins().unwrap().len(), 1);
    assert_eq!(plugin.id, "my-calculator");
    assert_eq!(plugin.version, "1.0.1");
    assert!(
        plugin.enabled,
        "A first production import is enabled by default"
    );
    assert_eq!(Path::new(&plugin.path), installed);
    assert_eq!(plugin.manifest.main.as_deref(), Some("index.html"));
    assert_eq!(
        plugin.manifest.preload.as_deref(),
        Some("preload/services.js")
    );
    assert_eq!(plugin.manifest.features.len(), 1);
    assert_eq!(plugin.manifest.features[0].code, "calculator");
    let features = db.features_by_plugin("my-calculator").unwrap();
    assert_eq!(features.len(), 1);
    assert_eq!(features[0].plugin_id, "my-calculator");
    assert_eq!(features[0].code, "calculator");
    assert_eq!(
        serde_json::to_value(&features[0].cmds).unwrap(),
        serde_json::json!(["计算器", "calc", "calculator"])
    );

    let expected = FILES
        .iter()
        .map(|(path, _, _)| (*path).to_string())
        .collect();
    assert_eq!(installed_files(&installed, &installed), expected);
    for &(path, size, digest) in FILES {
        let actual =
            fs::read(installed.join(path)).expect("Read installed original file as bytes only");
        assert_eq!(actual.len(), size, "Installed size changed: {path}");
        assert_eq!(
            sha256(&actual),
            digest,
            "Installed original bytes changed: {path}"
        );
    }
    let html = fs::read_to_string(installed.join("index.html")).unwrap();
    assert!(html.contains("./assets/index-DTinetUR.js"));
    assert!(html.contains("./assets/index-D5L8xNXa.css"));
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(installed.join("plugin.json")).unwrap()).unwrap();
    assert_eq!(manifest["name"], "my-calculator");
    assert_eq!(manifest["version"], "1.0.1");
    assert_eq!(manifest["features"][0]["code"], "calculator");
    assert_eq!(
        sha256(&read_archive_bytes(&source).unwrap()),
        ARCHIVE_SHA256
    );
    assert_eq!(
        sha256(&read_archive_bytes(&original).unwrap()),
        ARCHIVE_SHA256
    );
    drop(db);
    scratch
        .close()
        .expect("Remove all owned copied/archive/install fixture files");
    assert!(
        !scratch_path.exists(),
        "Private import fixture must be removed"
    );
}
