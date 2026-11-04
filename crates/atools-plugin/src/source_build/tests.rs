use std::fs;
use std::path::Path;

use serde_json::{json, Value};
use tempfile::tempdir;

use super::{inspect_source_build, prepare_source_build, SourceBuildStatus};

pub(super) fn project() -> tempfile::TempDir {
    let temp = tempdir().unwrap();
    let root = temp.path();
    fs::write(
        root.join("plugin.json"),
        r#"{"name":"sample-plugin","version":"1.2.3","main":"src/main.ts"}"#,
    )
    .unwrap();
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("src/main.ts"), "export {}").unwrap();
    fs::write(
        root.join("package.json"),
        r#"{"name":"sample-project","version":"2.0.0","scripts":{"build":"vite build"},"devDependencies":{"vite":"1.2.3","esbuild":"0.28.1"}}"#,
    )
    .unwrap();
    write_lock(root, "1.2.3");
    fs::create_dir_all(root.join("node_modules/vite/bin")).unwrap();
    fs::create_dir_all(root.join("node_modules/vite/dist/node")).unwrap();
    fs::write(
        root.join("node_modules/vite/package.json"),
        r#"{"name":"vite","version":"1.2.3","bin":{"vite":"bin/vite.js"},"dependencies":{"esbuild":"^0.25.0"}}"#,
    )
    .unwrap();
    fs::write(
        root.join("node_modules/vite/bin/vite.js"),
        "process.exit(0)",
    )
    .unwrap();
    install_esbuild(root, Path::new("node_modules/vite/node_modules"), "0.25.12");
    install_esbuild(root, Path::new("node_modules"), "0.28.1");
    temp
}

fn write_lock(root: &std::path::Path, version: &str) {
    let platform = platform_name();
    let lock = json!({
        "name": "sample-project",
        "version": "2.0.0",
        "lockfileVersion": 3,
        "packages": {
            "": {"name":"sample-project","version":"2.0.0","devDependencies":{"vite":"1.2.3","esbuild":"0.28.1"}},
            "node_modules/vite": {"version":version,"dependencies":{"esbuild":"^0.25.0"}},
            "node_modules/vite/node_modules/esbuild": {"version":"0.25.12","optionalDependencies":{(format!("@esbuild/{platform}")):"0.25.12"}},
            (format!("node_modules/vite/node_modules/@esbuild/{platform}")): {"version":"0.25.12","optional":true},
            "node_modules/esbuild": {"version":"0.28.1","optionalDependencies":{(format!("@esbuild/{platform}")):"0.28.1"}},
            (format!("node_modules/@esbuild/{platform}")): {"version":"0.28.1","optional":true}
        }
    });
    fs::write(
        root.join("package-lock.json"),
        serde_json::to_vec(&lock).unwrap(),
    )
    .unwrap();
}

fn write_hoisted_lock(root: &std::path::Path, version: &str) {
    let platform = platform_name();
    let package_path = root.join("package.json");
    let mut package: Value = serde_json::from_slice(&fs::read(&package_path).unwrap()).unwrap();
    package["devDependencies"]["esbuild"] = json!("0.25.12");
    fs::write(&package_path, serde_json::to_vec(&package).unwrap()).unwrap();
    let lock = json!({
        "name": "sample-project",
        "version": "2.0.0",
        "lockfileVersion": 3,
        "packages": {
            "": {"name":"sample-project","version":"2.0.0","devDependencies":{"vite":"1.2.3","esbuild":"0.25.12"}},
            "node_modules/vite": {"version":version,"dependencies":{"esbuild":"^0.25.0"}},
            "node_modules/esbuild": {"version":"0.25.12","optionalDependencies":{(format!("@esbuild/{platform}")):"0.25.12"}},
            (format!("node_modules/@esbuild/{platform}")): {"version":"0.25.12","optional":true}
        }
    });
    fs::write(
        root.join("package-lock.json"),
        serde_json::to_vec(&lock).unwrap(),
    )
    .unwrap();
}

fn esbuild_relative() -> std::path::PathBuf {
    std::path::PathBuf::from(format!(
        "node_modules/vite/node_modules/@esbuild/{}/bin/{}",
        platform_name(),
        platform_binary_name()
    ))
}

fn platform_binary_name() -> &'static str {
    if cfg!(windows) {
        "esbuild.exe"
    } else {
        "esbuild"
    }
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

fn install_esbuild(root: &std::path::Path, parent: &std::path::Path, version: &str) {
    let package = parent.join("esbuild");
    let platform = platform_name();
    fs::create_dir_all(root.join(&package).join("bin")).unwrap();
    fs::create_dir_all(root.join(&package).join("lib")).unwrap();
    fs::write(
        root.join(&package).join("package.json"),
        serde_json::to_vec(&json!({
            "name":"esbuild", "version":version,
            "optionalDependencies":{format!("@esbuild/{platform}"):version},
            "bin":{"esbuild":"bin/esbuild"}
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        root.join(&package).join("bin/esbuild"),
        b"JS wrapper fixture",
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

fn has_code(inspection: &super::SourceBuildInspection, code: &str) -> bool {
    inspection
        .blockers
        .iter()
        .any(|blocker| blocker.code == code)
}

#[test]
fn eligible_plan_is_path_bearing_but_inspection_json_is_not() {
    let temp = project();
    let inspection = inspect_source_build(temp.path()).unwrap();
    assert_eq!(inspection.status, SourceBuildStatus::Eligible);
    assert_eq!(inspection.plugin_id.as_deref(), Some("sample-plugin"));
    assert_eq!(inspection.version.as_deref(), Some("1.2.3"));
    let encoded = serde_json::to_value(&inspection).unwrap();
    assert_eq!(encoded["status"], "eligible");
    assert_eq!(encoded["pluginId"], "sample-plugin");
    assert!(encoded.get("plan").is_none());
    assert!(serde_json::to_string(&encoded)
        .unwrap()
        .find(temp.path().to_str().unwrap())
        .is_none());

    let plan = prepare_source_build(temp.path()).unwrap();
    assert_eq!(plan.manifest_relative, std::path::Path::new("plugin.json"));
    assert_eq!(plan.plugin_id, "sample-plugin");
    assert!(plan.vite_cli.starts_with(&plan.dependency_root));
    let super::ViteBuildBackend::Esbuild { binary } = &plan.vite_backend else {
        panic!("expected legacy esbuild backend")
    };
    assert!(binary.starts_with(&plan.dependency_root));
    assert!(plan.test_esbuild_binary.is_none());
    assert_eq!(plan.build_steps.len(), 1);
    assert_eq!(encoded["buildSteps"], json!([{"kind":"viteBuild"}]));
}

#[test]
fn selects_vites_nested_esbuild_and_ignores_newer_unrelated_root_copy() {
    let temp = project();
    let plan = prepare_source_build(temp.path()).unwrap();
    let super::ViteBuildBackend::Esbuild { binary } = &plan.vite_backend else {
        panic!("expected legacy esbuild backend")
    };
    let dependency_root = temp.path().join("node_modules").canonicalize().unwrap();
    let vite_cli = temp
        .path()
        .join("node_modules/vite/bin/vite.js")
        .canonicalize()
        .unwrap();
    assert_eq!(
        binary.clone(),
        temp.path().join(esbuild_relative()).canonicalize().unwrap()
    );
    assert_eq!(
        super::resolve_build_esbuild_binary(temp.path(), &dependency_root, &vite_cli)
            .unwrap()
            .as_path(),
        binary.as_path()
    );
    assert!(binary.ends_with(format!(
        "@esbuild/{}/bin/{}",
        platform_name(),
        platform_binary_name()
    )));
}

#[test]
fn skips_node_modules_node_modules_decoy_when_resolving_hoisted_esbuild() {
    let temp = project();
    fs::remove_dir_all(temp.path().join("node_modules/vite/node_modules")).unwrap();
    fs::remove_dir_all(temp.path().join("node_modules/esbuild")).unwrap();
    fs::remove_dir_all(temp.path().join("node_modules/@esbuild")).unwrap();
    install_esbuild(temp.path(), Path::new("node_modules"), "0.25.12");
    write_hoisted_lock(temp.path(), "1.2.3");
    install_esbuild(
        temp.path(),
        Path::new("node_modules/node_modules"),
        "0.99.0",
    );

    let dependency_root = temp.path().join("node_modules").canonicalize().unwrap();
    let vite_cli = temp
        .path()
        .join("node_modules/vite/bin/vite.js")
        .canonicalize()
        .unwrap();
    let resolved = super::resolve_build_esbuild_binary(temp.path(), &dependency_root, &vite_cli)
        .expect("Node skips node_modules/node_modules and finds the valid hoisted package");
    assert_eq!(
        resolved,
        temp.path()
            .join(format!(
                "node_modules/@esbuild/{}/bin/{}",
                platform_name(),
                platform_binary_name()
            ))
            .canonicalize()
            .unwrap()
    );
}

#[test]
fn rejects_different_esbuild_selected_from_vite_chunks_importer() {
    let temp = project();
    install_esbuild(
        temp.path(),
        Path::new("node_modules/vite/dist/node/chunks/node_modules"),
        "0.25.12",
    );
    let dependency_root = temp.path().join("node_modules").canonicalize().unwrap();
    let vite_cli = temp
        .path()
        .join("node_modules/vite/bin/vite.js")
        .canonicalize()
        .unwrap();

    assert!(super::resolve_build_esbuild_binary(temp.path(), &dependency_root, &vite_cli).is_err());
}

#[test]
fn resolves_hoisted_esbuild_using_vites_declared_range_and_lock_location() {
    let temp = project();
    fs::remove_dir_all(temp.path().join("node_modules/vite/node_modules")).unwrap();
    fs::remove_dir_all(temp.path().join("node_modules/esbuild")).unwrap();
    fs::remove_dir_all(temp.path().join("node_modules/@esbuild")).unwrap();
    install_esbuild(temp.path(), Path::new("node_modules"), "0.25.12");
    write_hoisted_lock(temp.path(), "1.2.3");

    let plan = prepare_source_build(temp.path()).unwrap();
    assert_eq!(
        match &plan.vite_backend {
            super::ViteBuildBackend::Esbuild { binary } => binary.clone(),
            _ => panic!("expected esbuild"),
        },
        temp.path()
            .join(format!(
                "node_modules/@esbuild/{}/bin/{}",
                platform_name(),
                platform_binary_name()
            ))
            .canonicalize()
            .unwrap()
    );
}

#[test]
fn rejects_hoisted_copy_that_conflicts_with_the_project_lock() {
    let temp = project();
    fs::remove_dir_all(temp.path().join("node_modules/vite/node_modules")).unwrap();
    fs::remove_dir_all(temp.path().join("node_modules/esbuild")).unwrap();
    fs::remove_dir_all(temp.path().join("node_modules/@esbuild")).unwrap();
    install_esbuild(temp.path(), Path::new("node_modules"), "0.25.12");
    write_hoisted_lock(temp.path(), "1.2.3");
    let package_path = temp.path().join("package.json");
    let mut package: Value = serde_json::from_slice(&fs::read(&package_path).unwrap()).unwrap();
    package["devDependencies"]["esbuild"] = json!("0.28.1");
    fs::write(&package_path, serde_json::to_vec(&package).unwrap()).unwrap();

    let inspection = inspect_source_build(temp.path()).unwrap();
    assert_eq!(inspection.status, SourceBuildStatus::Blocked);
    assert!(has_code(&inspection, "build_lock_mismatch"));
}

#[test]
fn rejects_nested_esbuild_version_disagreement_with_lock() {
    let temp = project();
    let package_path = temp
        .path()
        .join("node_modules/vite/node_modules/esbuild/package.json");
    let mut package: Value = serde_json::from_slice(&fs::read(&package_path).unwrap()).unwrap();
    package["version"] = json!("0.26.0");
    package["optionalDependencies"][format!("@esbuild/{}", platform_name())] = json!("0.26.0");
    fs::write(&package_path, serde_json::to_vec(&package).unwrap()).unwrap();

    let inspection = inspect_source_build(temp.path()).unwrap();
    assert_eq!(inspection.status, SourceBuildStatus::Blocked);
    assert!(has_code(&inspection, "build_lock_mismatch"));
}

#[test]
fn rejects_vite_esbuild_dependency_that_disagrees_with_lock() {
    let temp = project();
    let lock_path = temp.path().join("package-lock.json");
    let mut lock: Value = serde_json::from_slice(&fs::read(&lock_path).unwrap()).unwrap();
    lock["packages"]["node_modules/vite"]["dependencies"]["esbuild"] = json!("^0.28.0");
    fs::write(&lock_path, serde_json::to_vec(&lock).unwrap()).unwrap();

    let inspection = inspect_source_build(temp.path()).unwrap();
    assert_eq!(inspection.status, SourceBuildStatus::Blocked);
    assert!(has_code(&inspection, "build_lock_mismatch"));
}

#[test]
fn rejects_platform_binary_when_optional_lock_version_disagrees() {
    let temp = project();
    let package_path = temp.path().join(format!(
        "node_modules/vite/node_modules/@esbuild/{}/package.json",
        platform_name()
    ));
    let mut package: Value = serde_json::from_slice(&fs::read(&package_path).unwrap()).unwrap();
    package["version"] = json!("0.28.1");
    fs::write(&package_path, serde_json::to_vec(&package).unwrap()).unwrap();

    let inspection = inspect_source_build(temp.path()).unwrap();
    assert_eq!(inspection.status, SourceBuildStatus::Blocked);
    assert!(has_code(&inspection, "build_lock_mismatch"));
}

#[test]
fn plugin_identity_uses_the_installation_id_normalizer() {
    let temp = project();
    fs::write(
        temp.path().join("plugin.json"),
        r#"{"name":"Fancy.Plugin Name","version":"1.2.3","main":"src/main.ts"}"#,
    )
    .unwrap();
    let inspection = inspect_source_build(temp.path()).unwrap();
    assert_eq!(inspection.plugin_id.as_deref(), Some("Fancy-Plugin-Name"));
    assert_eq!(
        prepare_source_build(temp.path()).unwrap().plugin_id,
        "Fancy-Plugin-Name"
    );

    fs::write(
        temp.path().join("plugin.json"),
        r#"{"name":"...   ...","version":"1.2.3","main":"src/main.ts"}"#,
    )
    .unwrap();
    let inspection = inspect_source_build(temp.path()).unwrap();
    assert_eq!(inspection.status, SourceBuildStatus::Blocked);
    assert!(has_code(&inspection, "plugin_id_invalid"));
}

#[test]
fn actual_package_resolver_readiness_wins_and_requires_build_does_not() {
    let ready = tempdir().unwrap();
    fs::write(
        ready.path().join("plugin.json"),
        r#"{"name":"ready","version":"1","main":"index.html"}"#,
    )
    .unwrap();
    fs::write(ready.path().join("index.html"), "<html></html>").unwrap();
    let inspection = inspect_source_build(ready.path()).unwrap();
    assert_eq!(inspection.status, SourceBuildStatus::AlreadyReady);

    let source = project();
    fs::write(
        source.path().join("plugin.json"),
        r#"{"name":"source","version":"1","main":"src/main.ts"}"#,
    )
    .unwrap();
    fs::create_dir_all(source.path().join("src")).unwrap();
    fs::write(source.path().join("src/main.ts"), "export {}").unwrap();
    let inspection = inspect_source_build(source.path()).unwrap();
    assert_eq!(inspection.status, SourceBuildStatus::Eligible);
}

#[test]
fn lock_version_script_and_missing_owned_dependencies_block() {
    let temp = project();
    write_lock(temp.path(), "9.9.9");
    let inspection = inspect_source_build(temp.path()).unwrap();
    assert_eq!(inspection.status, SourceBuildStatus::Blocked);
    assert!(has_code(&inspection, "build_lock_mismatch"));

    let temp = project();
    let mut package: Value =
        serde_json::from_slice(&fs::read(temp.path().join("package.json")).unwrap()).unwrap();
    package["scripts"]["build"] = json!("bun run build");
    fs::write(
        temp.path().join("package.json"),
        serde_json::to_vec(&package).unwrap(),
    )
    .unwrap();
    let inspection = inspect_source_build(temp.path()).unwrap();
    assert!(has_code(&inspection, "unsupported_build"));

    let temp = project();
    fs::remove_dir_all(temp.path().join("node_modules")).unwrap();
    let inspection = inspect_source_build(temp.path()).unwrap();
    assert!(has_code(&inspection, "dependencies_missing"));
    assert_eq!(inspection.blockers.len(), 1);
}

#[cfg(unix)]
#[test]
fn symlinked_dependencies_and_escaping_source_symlinks_block() {
    use std::os::unix::fs::symlink;
    let temp = project();
    let outside = tempdir().unwrap();
    fs::rename(
        temp.path().join("node_modules"),
        temp.path().join("node_modules_owned"),
    )
    .unwrap();
    symlink(outside.path(), temp.path().join("node_modules")).unwrap();
    let inspection = inspect_source_build(temp.path()).unwrap();
    assert!(has_code(&inspection, "dependencies_missing"));

    let temp = project();
    symlink(outside.path(), temp.path().join("linked-source")).unwrap();
    let inspection = inspect_source_build(temp.path()).unwrap();
    assert!(has_code(&inspection, "source_scan_unsafe"));
}

#[cfg(unix)]
#[test]
fn unsafe_nearest_esbuild_does_not_fall_back_to_a_root_copy() {
    use std::os::unix::fs::symlink;
    let temp = project();
    let outside = tempdir().unwrap();
    let nested = temp.path().join("node_modules/vite/node_modules/esbuild");
    fs::remove_dir_all(&nested).unwrap();
    symlink(outside.path(), nested).unwrap();

    let inspection = inspect_source_build(temp.path()).unwrap();
    assert_eq!(inspection.status, SourceBuildStatus::Blocked);
    assert!(has_code(&inspection, "build_toolchain_invalid"));
}

#[test]
fn native_and_remote_entries_are_explicit_blockers() {
    let temp = project();
    fs::write(temp.path().join("addon.native"), "native").unwrap();
    let inspection = inspect_source_build(temp.path()).unwrap();
    assert!(has_code(&inspection, "native_addon"));

    let temp = project();
    fs::write(
        temp.path().join("plugin.json"),
        r#"{"name":"sample-plugin","version":"1.2.3","main":"https://example.invalid/app.html"}"#,
    )
    .unwrap();
    let inspection = inspect_source_build(temp.path()).unwrap();
    assert!(has_code(&inspection, "remote_entry"));
}

#[test]
fn npm_cache_is_ignored_by_source_eligibility_and_revision_walk() {
    let temp = project();
    fs::create_dir_all(temp.path().join(".npm-cache/nested")).unwrap();
    fs::write(
        temp.path().join(".npm-cache/nested/ignored.node"),
        b"not package input",
    )
    .unwrap();
    let inspection = inspect_source_build(temp.path()).unwrap();
    assert_eq!(inspection.status, SourceBuildStatus::Eligible);
    assert!(!has_code(&inspection, "native_addon"));
}
