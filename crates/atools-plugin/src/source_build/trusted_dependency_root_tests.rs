use super::trusted_dependency_root::TrustedDependencyRoot;
use super::{BuildStep, SourceBuildStatus};
use serde_json::{json, Value};
use std::{fs, path::Path};
use tempfile::tempdir;

#[test]
fn accepts_only_external_canonical_home_with_regular_node_modules() {
    let source = tempdir().unwrap();
    let owned = tempdir().unwrap();
    fs::create_dir(owned.path().join("node_modules")).unwrap();
    let source_root = source.path().canonicalize().unwrap();
    let home = owned.path().canonicalize().unwrap();
    let resolved = TrustedDependencyRoot::from_host(&source_root, &home).unwrap();
    assert_eq!(resolved.node_modules, home.join("node_modules"));
    assert!(TrustedDependencyRoot::from_host(&source_root, &source_root).is_err());
    assert!(TrustedDependencyRoot::from_host(&source_root, Path::new("relative/deps")).is_err());
}

#[cfg(unix)]
#[test]
fn rejects_symlinked_home_and_node_modules() {
    use std::os::unix::fs::symlink;
    let source = tempdir().unwrap();
    let owned = tempdir().unwrap();
    fs::create_dir(owned.path().join("node_modules")).unwrap();
    let link = tempdir().unwrap();
    symlink(owned.path(), link.path().join("linked")).unwrap();
    let source_root = source.path().canonicalize().unwrap();
    assert!(TrustedDependencyRoot::from_host(&source_root, &link.path().join("linked")).is_err());
    let external = tempdir().unwrap();
    symlink(
        owned.path().join("node_modules"),
        external.path().join("node_modules"),
    )
    .unwrap();
    let external_root = external.path().canonicalize().unwrap();
    assert!(TrustedDependencyRoot::from_host(&source_root, &external_root).is_err());
}

#[test]
fn inspects_and_prepares_all_build_tools_from_external_home_but_config_from_source() {
    let source = super::tests::project();
    let dependency_home = tempdir().unwrap();
    let root = source.path();
    fs::rename(
        root.join("node_modules"),
        dependency_home.path().join("node_modules"),
    )
    .unwrap();
    let canonical_dependency_home = dependency_home.path().canonicalize().unwrap();
    install_external_toolchain(root, &canonical_dependency_home);

    assert!(!root.join("node_modules").exists());
    assert!(root.join("tsconfig.json").is_file());
    assert!(!dependency_home.path().join("tsconfig.json").exists());

    let inspection =
        super::inspect_source_build_with_dependency_root(root, &canonical_dependency_home).unwrap();
    assert_eq!(
        inspection.status,
        SourceBuildStatus::Eligible,
        "inspection blockers: {:?}",
        inspection.blockers
    );
    assert_eq!(
        inspection.build_steps,
        Some(vec![
            super::BuildStepSummary::Typecheck,
            super::BuildStepSummary::NodeTests { files: 1 },
            super::BuildStepSummary::ViteBuild,
        ])
    );

    let plan = super::prepare_source_build_with_dependency_root(root, &canonical_dependency_home)
        .expect("the trusted external toolchain should produce a build plan");
    let modules = dependency_home
        .path()
        .join("node_modules")
        .canonicalize()
        .unwrap();
    assert_eq!(plan.dependency_root, modules);
    assert!(plan.vite_cli.starts_with(&modules));
    let super::ViteBuildBackend::Esbuild { binary } = &plan.vite_backend else {
        panic!("expected legacy esbuild backend")
    };
    assert!(binary.starts_with(&modules));
    let tsx_esbuild = plan
        .test_esbuild_binary
        .as_deref()
        .expect("the NodeTest step requires its own TSX esbuild resolution");
    assert!(tsx_esbuild.starts_with(&modules));
    assert!(matches!(
        &plan.build_steps[0],
        BuildStep::Typecheck { cli }
            if cli == "node_modules/vue-tsc/bin/vue-tsc.js"
    ));
    assert!(matches!(
        &plan.build_steps[1],
        BuildStep::NodeTest { files }
            if files.len() == 1 && files[0] == "tests/smoke.test.ts"
    ));
    assert!(matches!(
        &plan.build_steps[2],
        BuildStep::ViteBuild { cli }
            if cli == "node_modules/vite/bin/vite.js"
    ));
    assert!(!root.join("node_modules").exists());
}

fn install_external_toolchain(source: &Path, dependency_home: &Path) {
    let package_path = source.join("package.json");
    let mut package: Value = serde_json::from_slice(&fs::read(&package_path).unwrap()).unwrap();
    package["devDependencies"]["vue-tsc"] = json!("^2.2.0");
    package["devDependencies"]["tsx"] = json!("4.23.1");
    package["scripts"]["build"] =
        json!("vue-tsc && node --import tsx --test tests/*.test.ts && vite build");
    fs::write(&package_path, serde_json::to_vec(&package).unwrap()).unwrap();
    fs::write(
        source.join("tsconfig.json"),
        br#"{"compilerOptions":{"noEmit":true}}"#,
    )
    .unwrap();
    fs::create_dir_all(source.join("tests")).unwrap();
    fs::write(source.join("tests/smoke.test.ts"), "export {};").unwrap();

    let node_modules = dependency_home.join("node_modules");
    fs::create_dir_all(node_modules.join("vue-tsc/bin")).unwrap();
    fs::write(
        node_modules.join("vue-tsc/package.json"),
        r#"{"name":"vue-tsc","version":"2.2.12","bin":{"vue-tsc":"bin/vue-tsc.js"}}"#,
    )
    .unwrap();
    fs::write(
        node_modules.join("vue-tsc/bin/vue-tsc.js"),
        "process.exit(0);",
    )
    .unwrap();
    install_tsx_loader(&node_modules);

    let lock_path = source.join("package-lock.json");
    let mut lock: Value = serde_json::from_slice(&fs::read(&lock_path).unwrap()).unwrap();
    lock["packages"][""]["devDependencies"]["vue-tsc"] = json!("^2.2.0");
    lock["packages"][""]["devDependencies"]["tsx"] = json!("4.23.1");
    lock["packages"]["node_modules/vue-tsc"] = json!({"version":"2.2.12"});
    lock["packages"]["node_modules/tsx"] = json!({
        "version":"4.23.1","dependencies":{"esbuild":"~0.28.0"}
    });
    fs::write(lock_path, serde_json::to_vec(&lock).unwrap()).unwrap();
}

fn install_tsx_loader(node_modules: &Path) {
    let tsx = node_modules.join("tsx");
    fs::create_dir_all(tsx.join("dist/esm")).unwrap();
    fs::create_dir_all(tsx.join("dist/cjs")).unwrap();
    fs::write(
        tsx.join("package.json"),
        r#"{"name":"tsx","version":"4.23.1","exports":{".":"./dist/loader.mjs"},"dependencies":{"esbuild":"~0.28.0"}}"#,
    )
    .unwrap();
    for (relative, contents) in [
        (
            "dist/loader.mjs",
            "import{initialize}from\"./esm/index.mjs\";r(\"./cjs/index.cjs\");",
        ),
        (
            "dist/esm/index.mjs",
            "import\"esbuild\";import\"../index-CQhDiIsg.mjs\";",
        ),
        (
            "dist/cjs/index.cjs",
            "require(\"esbuild\");require(\"../index-BN2t1Mfo.cjs\");",
        ),
        (
            "dist/index-CQhDiIsg.mjs",
            "import{transform}from\"esbuild\";",
        ),
        ("dist/index-BN2t1Mfo.cjs", "require(\"esbuild\");"),
    ] {
        fs::write(tsx.join(relative), contents).unwrap();
    }
}
