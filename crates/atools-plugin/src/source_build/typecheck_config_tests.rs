use std::fs;
use std::path::PathBuf;

use serde_json::{json, Value};
use tempfile::TempDir;

use super::{compile_scripts, BuildStep, CompiledScripts, ScriptPlanError};

const TOOLS: [(&str, &str, &str); 3] = [
    ("vite", "6.4.3", "vite"),
    ("vue-tsc", "2.2.12", "vue-tsc"),
    ("typescript", "5.6.3", "tsc"),
];

fn fixture(build: &str) -> (TempDir, Value, Value, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let dependencies = json!({"vite":"^6.0.0","vue-tsc":"^2.2.0","typescript":"^5.0.0"});
    let package = json!({
        "name":"typecheck-fixture", "version":"1.0.0",
        "scripts":{"build":build,"prebuild":"node scripts/prebuild.mjs","postbuild":"node scripts/postbuild.mjs"},
        "devDependencies":dependencies
    });
    let lock = json!({
        "name":"typecheck-fixture", "version":"1.0.0", "lockfileVersion":3,
        "packages":{
            "":{"name":"typecheck-fixture","version":"1.0.0","devDependencies":dependencies},
            "node_modules/vite":{"version":"6.4.3"},
            "node_modules/vue-tsc":{"version":"2.2.12"},
            "node_modules/typescript":{"version":"5.6.3"}
        }
    });
    fs::create_dir_all(root.join("scripts")).unwrap();
    fs::write(root.join("scripts/prebuild.mjs"), "").unwrap();
    fs::write(root.join("scripts/postbuild.mjs"), "").unwrap();
    for (package_name, version, bin_name) in TOOLS {
        let package_root = root.join("node_modules").join(package_name);
        let bin_root = package_root.join("bin");
        fs::create_dir_all(&bin_root).unwrap();
        let bin_path = format!("bin/{bin_name}.js");
        fs::write(
            package_root.join("package.json"),
            json!({"name":package_name,"version":version,"bin":{bin_name:bin_path}}).to_string(),
        )
        .unwrap();
        fs::write(bin_root.join(format!("{bin_name}.js")), "").unwrap();
    }
    let dependencies_root = root.join("node_modules").canonicalize().unwrap();
    (temp, package, lock, dependencies_root)
}

fn compile_fixture(
    temp: &TempDir,
    package: &Value,
    lock: &Value,
    dependencies: &PathBuf,
) -> Result<CompiledScripts, ScriptPlanError> {
    compile_scripts(
        &temp.path().canonicalize().unwrap(),
        package,
        lock,
        dependencies,
    )
}

fn write_config(temp: &TempDir, text: &str) {
    fs::write(temp.path().join("tsconfig.json"), text).unwrap();
}

#[test]
fn explicit_no_emit_commands_and_bare_no_emit_configs_plan_before_vite() {
    for (command, expected_cli, bare) in [
        (
            "tsc --noEmit && vite build",
            "node_modules/typescript/bin/tsc.js",
            false,
        ),
        (
            "vue-tsc --noEmit && vite build",
            "node_modules/vue-tsc/bin/vue-tsc.js",
            false,
        ),
        (
            "tsc && vite build",
            "node_modules/typescript/bin/tsc.js",
            true,
        ),
        (
            "vue-tsc && vite build",
            "node_modules/vue-tsc/bin/vue-tsc.js",
            true,
        ),
    ] {
        let (temp, package, lock, dependencies) = fixture(command);
        if bare {
            write_config(
                &temp,
                r#"{"compilerOptions":{"noEmit":true,"incremental":false,"composite":false}}"#,
            );
        }
        let compiled = compile_fixture(&temp, &package, &lock, &dependencies).unwrap();
        assert!(matches!(&compiled.steps[1], BuildStep::Typecheck { cli } if cli == expected_cli));
        assert!(matches!(&compiled.steps[2], BuildStep::ViteBuild { .. }));
    }
}

#[test]
fn bare_commands_require_root_strict_json_no_emit_and_no_project_output_state() {
    let cases = [
        None,
        Some(r#"{"compilerOptions":{"noEmit":false}}"#),
        Some("// comments are unsupported JSONC\n{\"compilerOptions\":{\"noEmit\":true}}"),
        Some(r#"{"extends":"./base.json","compilerOptions":{"noEmit":true}}"#),
        Some(r#"{"extends":"../outside.json","compilerOptions":{"noEmit":true}}"#),
        Some(r#"{"references":[],"compilerOptions":{"noEmit":true}}"#),
        Some(r#"{"compilerOptions":{"noEmit":true,"incremental":true}}"#),
        Some(r#"{"compilerOptions":{"noEmit":true,"composite":true}}"#),
        Some(r#"{"compilerOptions":{"noEmit":true,"tsBuildInfoFile":".cache/build.tsbuildinfo"}}"#),
        Some(r#"{"compilerOptions":{"noEmit":false,"noEmit":true}}"#),
        Some(r#"{"compilerOptions":{"noEmit":true},"compilerOptions":{"noEmit":false}}"#),
    ];
    for config in cases {
        let (temp, package, lock, dependencies) = fixture("tsc && vite build");
        if let Some(text) = config {
            write_config(&temp, text);
        }
        assert_eq!(
            compile_fixture(&temp, &package, &lock, &dependencies).unwrap_err(),
            ScriptPlanError::TypecheckConfigUnsupported,
            "config={config:?}"
        );
    }
}

#[test]
fn typescript_tool_requires_direct_lock_installed_version_and_the_tsc_bin_key() {
    let (temp, mut package, lock, dependencies) = fixture("tsc --noEmit && vite build");
    package["devDependencies"]
        .as_object_mut()
        .unwrap()
        .remove("typescript");
    assert_eq!(
        compile_fixture(&temp, &package, &lock, &dependencies).unwrap_err(),
        ScriptPlanError::ToolchainInvalid
    );

    let (temp, package, mut lock, dependencies) = fixture("tsc --noEmit && vite build");
    lock["packages"][""]["devDependencies"]["typescript"] = json!("^5.1.0");
    assert_eq!(
        compile_fixture(&temp, &package, &lock, &dependencies).unwrap_err(),
        ScriptPlanError::LockMismatch
    );

    let (temp, package, lock, dependencies) = fixture("tsc --noEmit && vite build");
    let metadata = temp.path().join("node_modules/typescript/package.json");
    let mut installed: Value = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
    installed["version"] = json!("5.6.2");
    fs::write(&metadata, serde_json::to_vec(&installed).unwrap()).unwrap();
    assert_eq!(
        compile_fixture(&temp, &package, &lock, &dependencies).unwrap_err(),
        ScriptPlanError::LockMismatch
    );

    let (temp, package, lock, dependencies) = fixture("tsc --noEmit && vite build");
    let metadata = temp.path().join("node_modules/typescript/package.json");
    let mut installed: Value = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
    installed["bin"] = json!({"typescript":"bin/tsc.js"});
    fs::write(&metadata, serde_json::to_vec(&installed).unwrap()).unwrap();
    assert_eq!(
        compile_fixture(&temp, &package, &lock, &dependencies).unwrap_err(),
        ScriptPlanError::ToolchainInvalid
    );

    let (temp, package, lock, dependencies) = fixture("tsc --noEmit && vite build");
    let metadata = temp.path().join("node_modules/typescript/package.json");
    let mut installed: Value = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
    installed["name"] = json!("not-typescript");
    fs::write(&metadata, serde_json::to_vec(&installed).unwrap()).unwrap();
    assert_eq!(
        compile_fixture(&temp, &package, &lock, &dependencies).unwrap_err(),
        ScriptPlanError::ToolchainInvalid
    );
}

#[test]
fn vue_tsc_tool_rejects_installed_package_identity_mismatch() {
    let (temp, package, lock, dependencies) = fixture("vue-tsc --noEmit && vite build");
    let metadata = temp.path().join("node_modules/vue-tsc/package.json");
    let mut installed: Value = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
    installed["name"] = json!("not-vue-tsc");
    fs::write(&metadata, serde_json::to_vec(&installed).unwrap()).unwrap();
    assert_eq!(
        compile_fixture(&temp, &package, &lock, &dependencies).unwrap_err(),
        ScriptPlanError::ToolchainInvalid
    );
}

#[test]
fn unsupported_compiler_flags_remain_outside_the_fixed_plan() {
    for command in [
        "tsc --watch && vite build",
        "tsc --noEmit --watch && vite build",
        "vue-tsc --project tsconfig.json && vite build",
    ] {
        let (temp, package, lock, dependencies) = fixture(command);
        assert!(
            compile_fixture(&temp, &package, &lock, &dependencies).is_err(),
            "{command}"
        );
    }
}
