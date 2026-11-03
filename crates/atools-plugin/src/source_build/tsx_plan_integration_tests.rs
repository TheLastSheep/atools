use std::fs;
use std::path::Path;

use serde_json::{json, Value};

use super::prepare_source_build;

#[test]
fn prepared_node_test_plan_contains_the_reviewed_tsx_esbuild_binary() {
    let fixture = super::tests::project();
    let root = fixture.path();
    enable_node_test_step(root);

    let plan = prepare_source_build(root).expect("the reviewed NodeTest plan should be eligible");
    assert_eq!(plan.build_steps.len(), 2);
    assert!(matches!(
        &plan.build_steps[0],
        super::BuildStep::ViteBuild { .. }
    ));
    assert!(matches!(
        &plan.build_steps[1],
        super::BuildStep::NodeTest { files }
            if files.len() == 1 && files[0] == "tests/smoke.test.ts"
    ));
    let expected = root
        .join(format!(
            "node_modules/@esbuild/{}/bin/{}",
            platform_name(),
            binary_name()
        ))
        .canonicalize()
        .unwrap();
    assert_eq!(
        plan.test_esbuild_binary.as_deref(),
        Some(expected.as_path())
    );
    assert_ne!(plan.vite_backend.path(), expected.as_path());
}

fn enable_node_test_step(root: &Path) {
    let package_path = root.join("package.json");
    let mut package: Value = serde_json::from_slice(&fs::read(&package_path).unwrap()).unwrap();
    package["devDependencies"]["tsx"] = json!("4.23.1");
    package["scripts"]["build"] = json!("vite build && node --import tsx --test tests/*.test.ts");
    fs::write(&package_path, serde_json::to_vec(&package).unwrap()).unwrap();
    fs::create_dir_all(root.join("tests")).unwrap();
    fs::write(root.join("tests/smoke.test.ts"), "export {};").unwrap();

    let package_path = root.join("node_modules/tsx/package.json");
    fs::create_dir_all(root.join("node_modules/tsx/dist/esm")).unwrap();
    fs::create_dir_all(root.join("node_modules/tsx/dist/cjs")).unwrap();
    fs::write(
        package_path,
        serde_json::to_vec(&json!({
            "name":"tsx","version":"4.23.1",
            "exports":{".":"./dist/loader.mjs"},
            "dependencies":{"esbuild":"~0.28.0"}
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        root.join("node_modules/tsx/dist/loader.mjs"),
        "import{initialize}from\"./esm/index.mjs\";r(\"./cjs/index.cjs\");",
    )
    .unwrap();
    fs::write(
        root.join("node_modules/tsx/dist/esm/index.mjs"),
        "import\"esbuild\";import\"../index-CQhDiIsg.mjs\";",
    )
    .unwrap();
    fs::write(
        root.join("node_modules/tsx/dist/cjs/index.cjs"),
        "require(\"esbuild\");require(\"../index-BN2t1Mfo.cjs\");",
    )
    .unwrap();
    fs::write(
        root.join("node_modules/tsx/dist/index-CQhDiIsg.mjs"),
        "import{transform}from\"esbuild\";",
    )
    .unwrap();
    fs::write(
        root.join("node_modules/tsx/dist/index-BN2t1Mfo.cjs"),
        "require(\"esbuild\");",
    )
    .unwrap();

    let lock_path = root.join("package-lock.json");
    let mut lock: Value = serde_json::from_slice(&fs::read(&lock_path).unwrap()).unwrap();
    lock["packages"][""]["devDependencies"]["tsx"] = json!("4.23.1");
    lock["packages"]["node_modules/tsx"] = json!({
        "version":"4.23.1","dependencies":{"esbuild":"~0.28.0"}
    });
    fs::write(lock_path, serde_json::to_vec(&lock).unwrap()).unwrap();
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

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "esbuild.exe"
    } else {
        "esbuild"
    }
}

#[test]
fn inspection_keeps_safe_vite_importer_disagreement_invalid() {
    let fixture = super::tests::project();
    install_vite_chunks_esbuild_shadow(fixture.path());

    let inspection = super::inspect_source_build(fixture.path()).unwrap();
    assert_eq!(inspection.status, super::SourceBuildStatus::Blocked);
    assert!(inspection
        .blockers
        .iter()
        .any(|blocker| blocker.code == "build_toolchain_invalid"));
    assert!(!inspection
        .blockers
        .iter()
        .any(|blocker| blocker.code == "build_toolchain_unsupported"));
    assert!(!inspection
        .blockers
        .iter()
        .any(|blocker| blocker.code == "build_lock_mismatch"));
}

#[test]
fn vite_safe_importer_disagreement_keeps_its_existing_invalid_classification() {
    let fixture = super::tests::project();
    install_vite_chunks_esbuild_shadow(fixture.path());
    let lock_path = fixture.path().join("package-lock.json");
    let mut lock: Value = serde_json::from_slice(&fs::read(&lock_path).unwrap()).unwrap();
    lock["packages"]["node_modules/vite/dist/node/chunks/node_modules/esbuild"]["version"] =
        json!("0.29.0");
    fs::write(lock_path, serde_json::to_vec(&lock).unwrap()).unwrap();

    let inspection = super::inspect_source_build(fixture.path()).unwrap();
    assert!(inspection
        .blockers
        .iter()
        .any(|blocker| blocker.code == "build_toolchain_invalid"));
    assert!(!inspection
        .blockers
        .iter()
        .any(|blocker| blocker.code == "build_lock_mismatch"));
}

#[test]
fn public_parent_html_keeps_source_requires_build_and_gets_verified_output_plan() {
    let fixture = public_source_project("../index.html");
    let root = fixture.path();

    let package = crate::package_resolution::resolve_plugin_package(root).unwrap();
    assert_eq!(package.package_root, root.canonicalize().unwrap());
    assert_eq!(
        package.readiness,
        crate::package_resolution::PackageReadiness::RequiresBuild
    );
    assert_eq!(package.manifest.main.as_deref(), Some("index.html"));
    assert_eq!(package.raw_manifest["main"], "../index.html");

    let inspection = super::inspect_source_build(root).unwrap();
    assert_eq!(inspection.status, super::SourceBuildStatus::Eligible);
    assert!(!inspection
        .blockers
        .iter()
        .any(|blocker| blocker.code == "public_manifest_output_rewrite_required"));
    let plan = inspection
        .plan
        .expect("eligible public HTML needs a rewrite plan");
    let rewrite = plan
        .manifest_output_rewrite
        .expect("the source-derived output rewrite must accompany eligibility");
    assert!(rewrite.paths.iter().any(|path| {
        path.field == super::ManifestPathField::Main
            && path.source_value == "../index.html"
            && path.output_value == "index.html"
    }));
}

#[test]
fn public_parent_source_code_remains_blocked_without_output_rewrite() {
    let fixture = public_source_project("../src/main.ts");
    let inspection = super::inspect_source_build(fixture.path()).unwrap();

    assert_eq!(inspection.status, super::SourceBuildStatus::Blocked);
    assert!(inspection
        .blockers
        .iter()
        .any(|blocker| blocker.code == "public_manifest_output_rewrite_required"));
    assert!(inspection.plan.is_none());
}

fn public_source_project(main: &str) -> tempfile::TempDir {
    let fixture = super::tests::project();
    let root = fixture.path();
    fs::remove_file(root.join("plugin.json")).unwrap();
    fs::create_dir_all(root.join("public")).unwrap();
    fs::write(
        root.join("public/plugin.json"),
        serde_json::to_vec(&json!({
            "name":"public-source",
            "version":"1.0.0",
            "main":main
        }))
        .unwrap(),
    )
    .unwrap();
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("src/main.ts"), "export {}").unwrap();
    fs::write(
        root.join("index.html"),
        "<script type=\"module\" src=\"/src/main.ts\"></script>",
    )
    .unwrap();
    fixture
}

fn install_vite_chunks_esbuild_shadow(root: &Path) {
    let version = "0.25.12";
    let platform = platform_name();
    let parent = Path::new("node_modules/vite/dist/node/chunks/node_modules");
    let package = root.join(parent).join("esbuild");
    fs::create_dir_all(package.join("lib")).unwrap();
    fs::write(
        package.join("package.json"),
        serde_json::to_vec(&json!({
            "name":"esbuild","version":version,
            "optionalDependencies":{format!("@esbuild/{platform}"):version}
        }))
        .unwrap(),
    )
    .unwrap();
    let platform_package = root.join(parent).join(format!("@esbuild/{platform}"));
    fs::create_dir_all(platform_package.join("bin")).unwrap();
    fs::write(
        platform_package.join("package.json"),
        serde_json::to_vec(&json!({"name":format!("@esbuild/{platform}"),"version":version}))
            .unwrap(),
    )
    .unwrap();
    fs::write(platform_package.join("bin").join(binary_name()), b"fixture").unwrap();

    let lock_path = root.join("package-lock.json");
    let mut lock: Value = serde_json::from_slice(&fs::read(&lock_path).unwrap()).unwrap();
    let packages = lock["packages"].as_object_mut().unwrap();
    packages.insert(
        "node_modules/vite/dist/node/chunks/node_modules/esbuild".into(),
        json!({"version":version,"optionalDependencies":{format!("@esbuild/{platform}"):version}}),
    );
    packages.insert(
        format!("node_modules/vite/dist/node/chunks/node_modules/@esbuild/{platform}"),
        json!({"version":version,"optional":true}),
    );
    fs::write(lock_path, serde_json::to_vec(&lock).unwrap()).unwrap();
}

#[test]
fn inspect_and_prepare_report_fixed_unsupported_tsx_guidance() {
    let unsupported = super::tests::project();
    enable_node_test_step(unsupported.path());
    set_tsx_version(unsupported.path(), "4.24.0");

    let inspection = super::inspect_source_build(unsupported.path()).unwrap();
    assert_eq!(inspection.status, super::SourceBuildStatus::Blocked);
    let blocker = inspection
        .blockers
        .iter()
        .find(|blocker| blocker.code == "build_toolchain_unsupported")
        .expect("a lock-consistent unreviewed TSX version has a fixed unsupported blocker");
    assert_eq!(
        blocker.message,
        "Only the reviewed TSX 4.23.1 layout is supported. Use a locally available, supported toolchain with a matching lockfile, re-inspect, or import an already-built package"
    );
    assert!(prepare_source_build(unsupported.path()).is_err());
}

#[cfg(unix)]
#[test]
fn inspect_keeps_symlinked_tsx_dependency_as_invalid_not_unsupported() {
    use std::os::unix::fs::symlink;

    let unsafe_project = super::tests::project();
    enable_node_test_step(unsafe_project.path());
    let outside = tempfile::tempdir().unwrap();
    let parent = unsafe_project
        .path()
        .join("node_modules/tsx/dist/esm/node_modules");
    fs::create_dir_all(&parent).unwrap();
    symlink(outside.path(), parent.join("esbuild")).unwrap();

    let inspection = super::inspect_source_build(unsafe_project.path()).unwrap();
    assert_eq!(inspection.status, super::SourceBuildStatus::Blocked);
    assert!(inspection
        .blockers
        .iter()
        .any(|blocker| blocker.code == "build_toolchain_invalid"));
    assert!(!inspection
        .blockers
        .iter()
        .any(|blocker| blocker.code == "build_toolchain_unsupported"));
}

fn set_tsx_version(root: &Path, version: &str) {
    let package_path = root.join("package.json");
    let mut package: Value = serde_json::from_slice(&fs::read(&package_path).unwrap()).unwrap();
    package["devDependencies"]["tsx"] = json!(version);
    fs::write(&package_path, serde_json::to_vec(&package).unwrap()).unwrap();

    let installed_path = root.join("node_modules/tsx/package.json");
    let mut installed: Value = serde_json::from_slice(&fs::read(&installed_path).unwrap()).unwrap();
    installed["version"] = json!(version);
    fs::write(installed_path, serde_json::to_vec(&installed).unwrap()).unwrap();

    let lock_path = root.join("package-lock.json");
    let mut lock: Value = serde_json::from_slice(&fs::read(&lock_path).unwrap()).unwrap();
    lock["packages"][""]["devDependencies"]["tsx"] = json!(version);
    lock["packages"]["node_modules/tsx"]["version"] = json!(version);
    fs::write(lock_path, serde_json::to_vec(&lock).unwrap()).unwrap();
}
