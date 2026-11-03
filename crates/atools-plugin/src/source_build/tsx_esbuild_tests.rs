use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tempfile::tempdir_in;

use super::esbuild_resolver::{resolve_vite_esbuild, ResolveError};
use super::tsx_esbuild_resolver::{resolve_tsx_esbuild, TsxResolveError};

const TSX_VERSION: &str = "4.23.1";
const TSX_ESBUILD_VERSION: &str = "0.28.1";
const VITE_ESBUILD_VERSION: &str = "0.25.12";

struct Fixture {
    directory: tempfile::TempDir,
    package: Value,
    lock: Value,
}

impl Fixture {
    fn new(vite_esbuild_spec: &str, with_nested_tsx_esbuild: bool) -> Self {
        Self::new_with_options(vite_esbuild_spec, with_nested_tsx_esbuild, true)
    }

    fn new_with_options(
        vite_esbuild_spec: &str,
        with_nested_tsx_esbuild: bool,
        with_nested_vite_esbuild: bool,
    ) -> Self {
        let temp_root = std::env::temp_dir().canonicalize().unwrap();
        let directory = tempdir_in(temp_root).unwrap();
        let root = directory.path();
        let platform = platform_name();
        let package = json!({
            "name":"fixture-project",
            "devDependencies":{"vite":"6.4.3","tsx":TSX_VERSION}
        });
        fs::write(
            root.join("package.json"),
            serde_json::to_vec(&package).unwrap(),
        )
        .unwrap();

        fs::create_dir_all(root.join("node_modules/vite/bin")).unwrap();
        fs::create_dir_all(root.join("node_modules/vite/dist/node/chunks")).unwrap();
        fs::write(root.join("node_modules/vite/bin/vite.js"), "").unwrap();
        fs::write(
            root.join("node_modules/vite/package.json"),
            serde_json::to_vec(&json!({
                "name":"vite","version":"6.4.3","bin":{"vite":"bin/vite.js"},
                "dependencies":{"esbuild":vite_esbuild_spec}
            }))
            .unwrap(),
        )
        .unwrap();

        let tsx_root = Path::new("node_modules/tsx");
        fs::create_dir_all(root.join(tsx_root).join("dist/esm")).unwrap();
        fs::create_dir_all(root.join(tsx_root).join("dist/cjs")).unwrap();
        fs::write(
            root.join(tsx_root).join("package.json"),
            serde_json::to_vec(&json!({
                "name":"tsx","version":TSX_VERSION,
                "exports":{".":"./dist/loader.mjs"},
                "dependencies":{"esbuild":"~0.28.0"}
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            root.join(tsx_root).join("dist/loader.mjs"),
            "import{initialize}from\"./esm/index.mjs\";r(\"./cjs/index.cjs\");",
        )
        .unwrap();
        fs::write(
            root.join(tsx_root).join("dist/cjs/index.cjs"),
            "require(\"esbuild\");require(\"../index-BN2t1Mfo.cjs\");",
        )
        .unwrap();
        fs::write(
            root.join(tsx_root).join("dist/esm/index.mjs"),
            "import\"esbuild\";import\"../index-CQhDiIsg.mjs\";",
        )
        .unwrap();
        fs::write(
            root.join(tsx_root).join("dist/index-CQhDiIsg.mjs"),
            "import{transform}from\"esbuild\";",
        )
        .unwrap();
        fs::write(
            root.join(tsx_root).join("dist/index-BN2t1Mfo.cjs"),
            "require(\"esbuild\");",
        )
        .unwrap();

        if with_nested_vite_esbuild {
            install_esbuild(
                root,
                Path::new("node_modules/vite/node_modules"),
                VITE_ESBUILD_VERSION,
            );
        }
        install_esbuild(root, Path::new("node_modules"), TSX_ESBUILD_VERSION);
        if with_nested_tsx_esbuild {
            install_esbuild(
                root,
                Path::new("node_modules/tsx/dist/esm/node_modules"),
                TSX_ESBUILD_VERSION,
            );
        }

        let mut packages = serde_json::Map::new();
        packages.insert(
            "".into(),
            json!({"name":"fixture-project","devDependencies":{"vite":"6.4.3","tsx":TSX_VERSION}}),
        );
        packages.insert(
            "node_modules/vite".into(),
            json!({"version":"6.4.3","dependencies":{"esbuild":vite_esbuild_spec}}),
        );
        packages.insert(
            "node_modules/tsx".into(),
            json!({"version":TSX_VERSION,"dependencies":{"esbuild":"~0.28.0"}}),
        );
        if with_nested_vite_esbuild {
            add_esbuild_lock(
                &mut packages,
                "node_modules/vite/node_modules",
                VITE_ESBUILD_VERSION,
                platform,
            );
        }
        add_esbuild_lock(&mut packages, "node_modules", TSX_ESBUILD_VERSION, platform);
        if with_nested_tsx_esbuild {
            add_esbuild_lock(
                &mut packages,
                "node_modules/tsx/dist/esm/node_modules",
                TSX_ESBUILD_VERSION,
                platform,
            );
        }
        let lock = json!({"lockfileVersion":3,"packages":packages});
        fs::write(
            root.join("package-lock.json"),
            serde_json::to_vec(&lock).unwrap(),
        )
        .unwrap();
        Self {
            directory,
            package,
            lock,
        }
    }

    fn root(&self) -> &Path {
        self.directory.path()
    }

    fn dependencies(&self) -> PathBuf {
        self.root().join("node_modules").canonicalize().unwrap()
    }

    fn resolve_tsx(&self) -> Result<PathBuf, TsxResolveError> {
        resolve_tsx_esbuild(self.root(), &self.dependencies(), &self.package, &self.lock)
    }

    fn resolve_vite(&self) -> Result<PathBuf, ResolveError> {
        resolve_vite_esbuild(
            self.root(),
            &self.dependencies(),
            &self.root().join("node_modules/vite/bin/vite.js"),
            &self.package,
            &self.lock,
        )
    }
}

#[test]
fn vite_and_tsx_can_use_distinct_locked_esbuild_versions() {
    let fixture = Fixture::new("^0.25.0", false);
    let vite = fixture.resolve_vite().unwrap();
    let tsx = fixture.resolve_tsx().unwrap();
    let expected_suffix = format!(
        "@esbuild/{}/bin/{}",
        platform_name(),
        platform_binary_name()
    );
    assert!(vite.to_string_lossy().ends_with(expected_suffix.as_str()));
    assert!(vite.to_string_lossy().contains("vite/node_modules"));
    let expected_tsx = fixture
        .root()
        .join(format!(
            "node_modules/@esbuild/{}/bin/{}",
            platform_name(),
            platform_binary_name()
        ))
        .canonicalize()
        .unwrap();
    assert_eq!(tsx, expected_tsx);
    assert_ne!(vite, tsx);
}

#[test]
fn vite_and_tsx_may_share_one_matching_binary() {
    // There is no nearer Vite package or lock entry: both importers resolve
    // the same root esbuild package under Node's nearest-package lookup.
    let fixture = Fixture::new_with_options("^0.28.0", false, false);
    let root_esbuild = fixture
        .root()
        .join(format!(
            "node_modules/@esbuild/{}/bin/{}",
            platform_name(),
            platform_binary_name()
        ))
        .canonicalize()
        .unwrap();
    assert_eq!(fixture.resolve_vite().unwrap(), root_esbuild);
    assert_eq!(fixture.resolve_tsx().unwrap(), root_esbuild);
    assert!(!fixture
        .root()
        .join("node_modules/vite/node_modules/esbuild")
        .exists());
}

#[test]
fn missing_or_lock_mismatched_tsx_esbuild_fails_closed() {
    let missing = Fixture::new("^0.25.0", false);
    fs::remove_dir_all(missing.root().join("node_modules/@esbuild")).unwrap();
    assert_eq!(missing.resolve_tsx(), Err(TsxResolveError::Missing));

    let mismatch = Fixture::new("^0.25.0", false);
    let wrong_lock = mismatch.root().join("package-lock.json");
    let mut lock: Value = serde_json::from_slice(&fs::read(&wrong_lock).unwrap()).unwrap();
    lock["packages"]["node_modules/esbuild"]["version"] = json!("0.27.9");
    fs::write(wrong_lock, serde_json::to_vec(&lock).unwrap()).unwrap();
    assert_eq!(
        resolve_tsx_esbuild(
            mismatch.root(),
            &mismatch.dependencies(),
            &mismatch.package,
            &lock,
        ),
        Err(TsxResolveError::LockMismatch)
    );
}

#[test]
fn nearest_tsx_importer_shadow_is_an_unreviewed_layout() {
    let fixture = Fixture::new("^0.25.0", true);
    assert_eq!(fixture.resolve_tsx(), Err(TsxResolveError::Unsupported));
}

#[test]
fn safe_importer_disagreement_validates_each_selected_lock_before_unsupported() {
    let mut fixture = Fixture::new("^0.25.0", true);
    let lock_path = fixture.root().join("package-lock.json");
    let mut lock: Value = serde_json::from_slice(&fs::read(&lock_path).unwrap()).unwrap();
    lock["packages"]["node_modules/tsx/dist/esm/node_modules/esbuild"]["version"] = json!("0.29.0");
    fs::write(lock_path, serde_json::to_vec(&lock).unwrap()).unwrap();
    fixture.lock = lock;
    assert_eq!(fixture.resolve_tsx(), Err(TsxResolveError::LockMismatch));
}

#[test]
fn nearest_mismatched_tsx_esbuild_is_rejected_instead_of_falling_back() {
    let mut fixture = Fixture::new("^0.25.0", false);
    install_esbuild(
        fixture.root(),
        Path::new("node_modules/tsx/dist/node_modules"),
        "0.99.0",
    );
    let lock_path = fixture.root().join("package-lock.json");
    let mut lock: Value = serde_json::from_slice(&fs::read(&lock_path).unwrap()).unwrap();
    add_esbuild_lock(
        lock["packages"].as_object_mut().unwrap(),
        "node_modules/tsx/dist/node_modules",
        "0.99.0",
        platform_name(),
    );
    fs::write(lock_path, serde_json::to_vec(&lock).unwrap()).unwrap();
    fixture.lock = lock;
    assert_eq!(fixture.resolve_tsx(), Err(TsxResolveError::LockMismatch));
}

#[test]
fn cjs_importer_shadow_is_an_unreviewed_layout() {
    let mut fixture = Fixture::new("^0.25.0", false);
    install_esbuild(
        fixture.root(),
        Path::new("node_modules/tsx/dist/cjs/node_modules"),
        TSX_ESBUILD_VERSION,
    );
    let lock_path = fixture.root().join("package-lock.json");
    let mut lock: Value = serde_json::from_slice(&fs::read(&lock_path).unwrap()).unwrap();
    add_esbuild_lock(
        lock["packages"].as_object_mut().unwrap(),
        "node_modules/tsx/dist/cjs/node_modules",
        TSX_ESBUILD_VERSION,
        platform_name(),
    );
    fs::write(lock_path, serde_json::to_vec(&lock).unwrap()).unwrap();
    fixture.lock = lock;
    assert_eq!(fixture.resolve_tsx(), Err(TsxResolveError::Unsupported));
}

#[test]
fn unreviewed_tsx_export_layout_is_unsupported() {
    let fixture = Fixture::new("^0.25.0", false);
    let package_path = fixture.root().join("node_modules/tsx/package.json");
    let mut package: Value = serde_json::from_slice(&fs::read(&package_path).unwrap()).unwrap();
    package["exports"]["."] = json!("./dist/cjs/index.cjs");
    fs::write(package_path, serde_json::to_vec(&package).unwrap()).unwrap();
    assert_eq!(fixture.resolve_tsx(), Err(TsxResolveError::Unsupported));
}

#[test]
fn unreviewed_tsx_version_is_unsupported_when_package_and_lock_agree() {
    let mut fixture = Fixture::new("^0.25.0", false);
    set_tsx_version(&mut fixture, "4.24.0");
    assert_eq!(fixture.resolve_tsx(), Err(TsxResolveError::Unsupported));
}

#[test]
fn unreviewed_tsx_import_graph_shape_is_unsupported() {
    let fixture = Fixture::new("^0.25.0", false);
    let importer = fixture.root().join("node_modules/tsx/dist/esm/index.mjs");
    fs::write(
        importer,
        "import \"esbuild\"; export const reviewed = false;",
    )
    .unwrap();
    assert_eq!(fixture.resolve_tsx(), Err(TsxResolveError::Unsupported));
}

#[test]
fn unsupported_version_accepts_a_different_but_consistent_dependency_declaration() {
    let mut fixture = Fixture::new("^0.25.0", false);
    set_tsx_version(&mut fixture, "4.24.0");
    set_tsx_esbuild_dependency(&mut fixture, "^0.29.0", "^0.29.0");
    assert_eq!(fixture.resolve_tsx(), Err(TsxResolveError::Unsupported));
}

#[test]
fn unsupported_version_preserves_tsx_dependency_lock_mismatch() {
    let mut fixture = Fixture::new("^0.25.0", false);
    set_tsx_version(&mut fixture, "4.24.0");
    set_tsx_esbuild_dependency(&mut fixture, "^0.29.0", "~0.28.0");
    assert_eq!(fixture.resolve_tsx(), Err(TsxResolveError::LockMismatch));
}

#[test]
fn unsupported_tsx_with_lock_mismatch_keeps_lock_mismatch_classification() {
    let mut fixture = Fixture::new("^0.25.0", false);
    set_tsx_version(&mut fixture, "4.24.0");
    let lock_path = fixture.root().join("package-lock.json");
    fixture.lock["packages"]["node_modules/tsx"]["version"] = json!("4.23.1");
    fs::write(lock_path, serde_json::to_vec(&fixture.lock).unwrap()).unwrap();
    assert_eq!(fixture.resolve_tsx(), Err(TsxResolveError::LockMismatch));
}

#[cfg(unix)]
#[test]
fn symlinked_tsx_importer_dependency_is_rejected() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new("^0.25.0", false);
    let parent = fixture
        .root()
        .join("node_modules/tsx/dist/esm/node_modules");
    fs::create_dir_all(&parent).unwrap();
    symlink(
        fixture.root().join("node_modules/esbuild"),
        parent.join("esbuild"),
    )
    .unwrap();
    assert_eq!(fixture.resolve_tsx(), Err(TsxResolveError::Unsafe));
}

fn set_tsx_esbuild_dependency(fixture: &mut Fixture, installed_spec: &str, locked_spec: &str) {
    let installed_path = fixture.root().join("node_modules/tsx/package.json");
    let mut installed: Value = serde_json::from_slice(&fs::read(&installed_path).unwrap()).unwrap();
    installed["dependencies"]["esbuild"] = json!(installed_spec);
    fs::write(installed_path, serde_json::to_vec(&installed).unwrap()).unwrap();

    fixture.lock["packages"]["node_modules/tsx"]["dependencies"]["esbuild"] = json!(locked_spec);
    fs::write(
        fixture.root().join("package-lock.json"),
        serde_json::to_vec(&fixture.lock).unwrap(),
    )
    .unwrap();
}

fn set_tsx_version(fixture: &mut Fixture, version: &str) {
    fixture.package["devDependencies"]["tsx"] = json!(version);
    fixture.lock["packages"][""]["devDependencies"]["tsx"] = json!(version);
    fixture.lock["packages"]["node_modules/tsx"]["version"] = json!(version);
    let package_path = fixture.root().join("package.json");
    let mut package: Value = serde_json::from_slice(&fs::read(&package_path).unwrap()).unwrap();
    package["devDependencies"]["tsx"] = json!(version);
    fs::write(&package_path, serde_json::to_vec(&package).unwrap()).unwrap();

    let installed_path = fixture.root().join("node_modules/tsx/package.json");
    let mut installed: Value = serde_json::from_slice(&fs::read(&installed_path).unwrap()).unwrap();
    installed["version"] = json!(version);
    fs::write(installed_path, serde_json::to_vec(&installed).unwrap()).unwrap();

    let lock_path = fixture.root().join("package-lock.json");
    let mut lock: Value = serde_json::from_slice(&fs::read(&lock_path).unwrap()).unwrap();
    lock["packages"][""]["devDependencies"]["tsx"] = json!(version);
    lock["packages"]["node_modules/tsx"]["version"] = json!(version);
    fs::write(lock_path, serde_json::to_vec(&lock).unwrap()).unwrap();
}

fn install_esbuild(root: &Path, parent: &Path, version: &str) {
    let platform = platform_name();
    let package = parent.join("esbuild");
    fs::create_dir_all(root.join(&package).join("lib")).unwrap();
    fs::write(
        root.join(&package).join("package.json"),
        serde_json::to_vec(&json!({
            "name":"esbuild","version":version,
            "optionalDependencies":{format!("@esbuild/{platform}"):version}
        }))
        .unwrap(),
    )
    .unwrap();
    let platform_package = parent.join(format!("@esbuild/{platform}"));
    fs::create_dir_all(root.join(&platform_package).join("bin")).unwrap();
    fs::write(
        root.join(&platform_package).join("package.json"),
        serde_json::to_vec(&json!({"name":format!("@esbuild/{platform}"),"version":version}))
            .unwrap(),
    )
    .unwrap();
    fs::write(
        root.join(&platform_package)
            .join("bin")
            .join(platform_binary_name()),
        b"fixture",
    )
    .unwrap();
}

fn add_esbuild_lock(
    packages: &mut serde_json::Map<String, Value>,
    parent: &str,
    version: &str,
    platform: &str,
) {
    let package = if parent.is_empty() {
        "node_modules/esbuild".to_owned()
    } else {
        format!("{parent}/esbuild")
    };
    let platform_package = if parent.is_empty() {
        format!("node_modules/@esbuild/{platform}")
    } else {
        format!("{parent}/@esbuild/{platform}")
    };
    packages.insert(
        package,
        json!({"version":version,"optionalDependencies":{format!("@esbuild/{platform}"):version}}),
    );
    packages.insert(platform_package, json!({"version":version,"optional":true}));
}

fn platform_name() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-arm64",
        ("macos", "x86_64") => "darwin-x64",
        ("linux", "aarch64") => "linux-arm64",
        ("linux", "x86_64") => "linux-x64",
        ("windows", "aarch64") => "win32-arm64",
        ("windows", "x86_64") => "win32-x64",
        _ => panic!("fixture requires a supported esbuild platform"),
    }
}

fn platform_binary_name() -> &'static str {
    if cfg!(windows) {
        "esbuild.exe"
    } else {
        "esbuild"
    }
}
