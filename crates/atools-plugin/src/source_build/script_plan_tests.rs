use std::fs;
use std::path::PathBuf;

use serde_json::{json, Value};
use tempfile::TempDir;

use super::{compile_scripts, BuildStep, CompiledScripts, ScriptPlanError};

const VERSIONS: [(&str, &str); 3] = [("vite", "6.4.3"), ("vue-tsc", "2.2.12"), ("tsx", "4.23.1")];

fn compile_fixture(
    temp: &TempDir,
    package: &Value,
    lock: &Value,
    dependency_root: &PathBuf,
) -> Result<CompiledScripts, ScriptPlanError> {
    let canonical_root = temp.path().canonicalize().unwrap();
    compile_scripts(&canonical_root, package, lock, dependency_root)
}

fn fixture(build: &str) -> (TempDir, Value, Value, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let scripts = json!({
        "prebuild": "node scripts/prebuild.mjs",
        "pretypecheck": "node scripts/pre-typecheck.mjs",
        "typecheck": "vue-tsc --noEmit",
        "posttypecheck": "node scripts/post-typecheck.mjs",
        "pretest": "node scripts/pretest.mjs",
        "test": "node --import tsx --test tests/*.test.ts",
        "posttest": "node scripts/posttest.mjs",
        "build": build,
        "postbuild": "node scripts/verify-dist.mjs",
    });
    let dependencies = json!({
        "vite":"^6.0.11", "vue-tsc":"^2.2.0", "tsx":"^4.20.3"
    });
    let package = json!({
        "name":"fixture", "version":"1.0.0", "scripts":scripts,
        "devDependencies":dependencies
    });
    let lock = json!({
        "name":"fixture", "version":"1.0.0", "lockfileVersion":3,
        "packages": {
            "": {"name":"fixture", "version":"1.0.0", "devDependencies":dependencies},
            "node_modules/vite":{"version":"6.4.3"},
            "node_modules/vue-tsc":{"version":"2.2.12"},
            "node_modules/tsx":{"version":"4.23.1"}
        }
    });
    fs::create_dir_all(root.join("tests")).unwrap();
    fs::create_dir_all(root.join("scripts")).unwrap();
    fs::write(root.join("tests/a.test.ts"), "export {};").unwrap();
    fs::write(root.join("scripts/prepare.mjs"), "").unwrap();
    for name in [
        "prebuild",
        "pre-typecheck",
        "post-typecheck",
        "pretest",
        "posttest",
        "verify-dist",
    ] {
        fs::write(root.join(format!("scripts/{name}.mjs")), "").unwrap();
    }
    let node_modules = root.join("node_modules");
    let dep_root = fs::canonicalize(&node_modules).unwrap_or_else(|_| {
        fs::create_dir_all(&node_modules).unwrap();
        fs::canonicalize(&node_modules).unwrap()
    });
    for (name, version) in VERSIONS {
        let dir = root.join("node_modules").join(name);
        fs::create_dir_all(dir.join("bin")).unwrap();
        let bin = if name == "vite" {
            "vite"
        } else if name == "vue-tsc" {
            "vue-tsc"
        } else {
            "tsx"
        };
        let package_json =
            json!({"name":name,"version":version,"bin":{bin:format!("bin/{bin}.js")} });
        fs::write(
            dir.join("package.json"),
            serde_json::to_vec(&package_json).unwrap(),
        )
        .unwrap();
        fs::write(dir.join(format!("bin/{bin}.js")), "").unwrap();
    }
    (temp, package, lock, dep_root)
}

#[test]
fn expands_realistic_lifecycle_and_nested_build_order() {
    let (temp, package, lock, dependency_root) =
        fixture("npm run typecheck && npm test && vite build && node scripts/prepare.mjs");
    let result = compile_fixture(&temp, &package, &lock, &dependency_root).unwrap();
    let steps = &result.steps;
    assert_eq!(steps.len(), 10);
    assert!(
        matches!(&steps[0], BuildStep::NodeScript { script } if script == "scripts/prebuild.mjs")
    );
    assert!(
        matches!(&steps[1], BuildStep::NodeScript { script } if script == "scripts/pre-typecheck.mjs")
    );
    assert!(matches!(&steps[2], BuildStep::Typecheck { .. }));
    assert!(
        matches!(&steps[3], BuildStep::NodeScript { script } if script == "scripts/post-typecheck.mjs")
    );
    assert!(
        matches!(&steps[4], BuildStep::NodeScript { script } if script == "scripts/pretest.mjs")
    );
    assert!(
        matches!(&steps[5], BuildStep::NodeTest { files } if files.iter().map(String::as_str).collect::<Vec<_>>() == ["tests/a.test.ts"])
    );
    assert!(
        matches!(&steps[6], BuildStep::NodeScript { script } if script == "scripts/posttest.mjs")
    );
    assert!(matches!(&steps[7], BuildStep::ViteBuild { .. }));
    assert!(
        matches!(&steps[8], BuildStep::NodeScript { script } if script == "scripts/prepare.mjs")
    );
    assert!(
        matches!(&steps[9], BuildStep::NodeScript { script } if script == "scripts/verify-dist.mjs")
    );
}

#[test]
fn explicit_test_paths_use_the_same_canonical_shape_as_glob_results() {
    for alias in ["tests/./a.test.ts", "tests//a.test.ts"] {
        let command = format!("node --import tsx --test {alias} && vite build");
        let (temp, package, lock, dependency_root) = fixture(&command);
        let result = compile_fixture(&temp, &package, &lock, &dependency_root).unwrap();
        assert!(matches!(
            result.steps.as_slice(),
            [
                BuildStep::NodeScript { script: pre },
                BuildStep::NodeTest { files },
                BuildStep::ViteBuild { .. },
                BuildStep::NodeScript { script: post }
            ] if pre == "scripts/prebuild.mjs"
                && files.iter().map(String::as_str).collect::<Vec<_>>() == ["tests/a.test.ts"]
                && post == "scripts/verify-dist.mjs"
        ));
    }
}

#[test]
fn explicit_test_path_aliases_are_deduplicated_across_the_full_plan() {
    let command = "node --import tsx --test tests/./a.test.ts && node --import tsx --test tests//a.test.ts && vite build";
    let (temp, package, lock, dependency_root) = fixture(command);
    assert_eq!(
        compile_fixture(&temp, &package, &lock, &dependency_root).unwrap_err(),
        ScriptPlanError::UnsupportedCommand
    );
}

#[test]
fn preserves_supported_steps_after_vite_in_source_order() {
    let (temp, package, lock, dependency_root) = fixture("vite build && npm run typecheck");
    let result = compile_fixture(&temp, &package, &lock, &dependency_root).unwrap();
    assert!(matches!(
        result.steps.as_slice(),
        [
            BuildStep::NodeScript { script: pre_build },
            BuildStep::ViteBuild { .. },
            BuildStep::NodeScript { script: pre_typecheck },
            BuildStep::Typecheck { .. },
            BuildStep::NodeScript { script: post_typecheck },
            BuildStep::NodeScript { script: post_build }
        ] if pre_build == "scripts/prebuild.mjs"
            && pre_typecheck == "scripts/pre-typecheck.mjs"
            && post_typecheck == "scripts/post-typecheck.mjs"
            && post_build == "scripts/verify-dist.mjs"
    ));
}

#[test]
fn rejects_shell_features_unknown_commands_and_vite_omissions() {
    for command in [
        "vite build | cat",
        "vite build > output.log",
        "vite build && node scripts/prepare.mjs --force",
        "npm run typecheck && npm test && node scripts/prepare.mjs",
        "vite build && vite build",
    ] {
        let (temp, package, lock, dependency_root) = fixture(command);
        assert!(
            compile_fixture(&temp, &package, &lock, &dependency_root).is_err(),
            "{command}"
        );
    }
}

#[test]
fn rejects_cycles_excess_steps_missing_glob_and_escaping_script_paths() {
    let (temp, mut package, lock, dependency_root) =
        fixture("npm run typecheck && npm test && vite build");
    package["scripts"]["typecheck"] = json!("npm run build");
    assert_eq!(
        compile_fixture(&temp, &package, &lock, &dependency_root).unwrap_err(),
        ScriptPlanError::RecursiveScript
    );

    let too_many = std::iter::once("vite build".to_owned())
        .chain((0..12).map(|_| "node scripts/prebuild.mjs".to_owned()))
        .collect::<Vec<_>>()
        .join(" && ");
    let (temp, package, lock, dependency_root) = fixture(&too_many);
    assert_eq!(
        compile_fixture(&temp, &package, &lock, &dependency_root).unwrap_err(),
        ScriptPlanError::ScriptLimit
    );

    let (temp, package, lock, dependency_root) = fixture("vite build && node scripts/missing.mjs");
    assert_eq!(
        compile_fixture(&temp, &package, &lock, &dependency_root).unwrap_err(),
        ScriptPlanError::UnsafeScriptPath
    );

    let (temp, package, lock, dependency_root) =
        fixture("node scripts/../escape.mjs && vite build");
    assert_eq!(
        compile_fixture(&temp, &package, &lock, &dependency_root).unwrap_err(),
        ScriptPlanError::UnsupportedCommand
    );

    let (temp, package, lock, dependency_root) = fixture("node scripts/*.test.ts && vite build");
    assert!(compile_fixture(&temp, &package, &lock, &dependency_root).is_err());

    let (temp, package, lock, dependency_root) =
        fixture("node node_modules/tsx/bin/tsx.mjs && vite build");
    assert_eq!(
        compile_fixture(&temp, &package, &lock, &dependency_root).unwrap_err(),
        ScriptPlanError::UnsafeScriptPath
    );
}

#[cfg(unix)]
#[test]
fn rejects_symlinked_local_script_and_lock_install_mismatch() {
    use std::os::unix::fs::symlink;
    let (temp, package, lock, dependency_root) = fixture("node scripts/prepare.mjs && vite build");
    let outside = tempfile::NamedTempFile::new().unwrap();
    fs::remove_file(temp.path().join("scripts/prepare.mjs")).unwrap();
    symlink(outside.path(), temp.path().join("scripts/prepare.mjs")).unwrap();
    assert_eq!(
        compile_fixture(&temp, &package, &lock, &dependency_root).unwrap_err(),
        ScriptPlanError::UnsafeScriptPath
    );

    let (temp, package, mut lock, dependency_root) = fixture("vite build");
    lock["packages"]["node_modules/vite"]["version"] = json!("7.0.0");
    assert_eq!(
        compile_fixture(&temp, &package, &lock, &dependency_root).unwrap_err(),
        ScriptPlanError::LockMismatch
    );
}

#[test]
fn package_build_range_is_checked_with_semver_against_lock_and_install() {
    let (temp, package, lock, dependency_root) = fixture("vite build");
    let result = compile_fixture(&temp, &package, &lock, &dependency_root).unwrap();
    assert_eq!(result.steps.len(), 3);
    assert!(matches!(
        result.steps.as_slice(),
        [
            BuildStep::NodeScript { script: pre },
            BuildStep::ViteBuild { cli },
            BuildStep::NodeScript { script: post }
        ] if pre == "scripts/prebuild.mjs"
            && cli.starts_with("node_modules/vite/")
            && post == "scripts/verify-dist.mjs"
    ));
    assert!(result.vite_cli.starts_with(dependency_root));
}

#[test]
fn npm_full_versions_are_exact_and_supported_ranges_keep_npm_semantics() {
    let (temp, mut package, mut lock, dependency_root) = fixture("vite build");
    package["devDependencies"]["vite"] = json!("6.0.0");
    lock["packages"][""]["devDependencies"]["vite"] = json!("6.0.0");
    assert_eq!(
        compile_fixture(&temp, &package, &lock, &dependency_root).unwrap_err(),
        ScriptPlanError::LockMismatch
    );

    let (temp, mut package, mut lock, dependency_root) = fixture("vite build");
    package["devDependencies"]["vite"] = json!("^6.0.0");
    lock["packages"][""]["devDependencies"]["vite"] = json!("^6.0.0");
    assert!(compile_fixture(&temp, &package, &lock, &dependency_root).is_ok());

    let (temp, mut package, mut lock, dependency_root) = fixture("vite build");
    package["devDependencies"]["vite"] = json!("~6.0.0");
    lock["packages"][""]["devDependencies"]["vite"] = json!("~6.0.0");
    assert_eq!(
        compile_fixture(&temp, &package, &lock, &dependency_root).unwrap_err(),
        ScriptPlanError::LockMismatch
    );

    for unsupported in ["6", "6.x", ">=6.0.0", "6.0.0 || 7.0.0", "^6.0"] {
        let (temp, mut package, mut lock, dependency_root) = fixture("vite build");
        package["devDependencies"]["vite"] = json!(unsupported);
        lock["packages"][""]["devDependencies"]["vite"] = json!(unsupported);
        assert_eq!(
            compile_fixture(&temp, &package, &lock, &dependency_root).unwrap_err(),
            ScriptPlanError::ToolchainInvalid,
            "{unsupported}"
        );
    }
}

#[test]
fn rejects_node_option_paths_and_caps_test_files_across_the_whole_plan() {
    let commands = [
        "node --require=evil.mjs && vite build".to_owned(),
        format!("node scripts/bad{}name.mjs && vite build", '\n'),
        "node --import tsx --test --require=evil.test.ts && vite build".to_owned(),
        "node scripts/-prepare.mjs && vite build".to_owned(),
    ];
    for command in commands {
        let (temp, package, lock, dependency_root) = fixture(&command);
        assert!(compile_fixture(&temp, &package, &lock, &dependency_root).is_err());
    }

    let (temp, package, lock, dependency_root) =
        fixture("node --import tsx --test tests/*.test.ts && vite build");
    fs::write(temp.path().join("tests/-flagged.test.ts"), "export {}; ").unwrap();
    assert_eq!(
        compile_fixture(&temp, &package, &lock, &dependency_root).unwrap_err(),
        ScriptPlanError::UnsafeScriptPath
    );

    let (temp, mut package, lock, dependency_root) =
        fixture("npm test && npm run test-secondary && vite build");
    let first = temp.path().join("tests/first");
    let second = temp.path().join("tests/second");
    fs::create_dir_all(&first).unwrap();
    fs::create_dir_all(&second).unwrap();
    for index in 0..65 {
        fs::write(first.join(format!("case-{index}.test.ts")), "export {};").unwrap();
    }
    for index in 0..64 {
        fs::write(second.join(format!("case-{index}.test.ts")), "export {};").unwrap();
    }
    package["scripts"]["test"] = json!("node --import tsx --test tests/first/*.test.ts");
    package["scripts"]["test-secondary"] = json!("node --import tsx --test tests/second/*.test.ts");
    assert_eq!(
        compile_fixture(&temp, &package, &lock, &dependency_root).unwrap_err(),
        ScriptPlanError::ScriptLimit
    );
}

#[cfg(unix)]
#[test]
fn rejects_glob_discovered_posix_filename_with_literal_backslash() {
    let (temp, package, lock, dependency_root) =
        fixture("node --import tsx --test tests/*.test.ts && vite build");
    fs::write(
        temp.path().join("tests").join(r"bad\name.test.ts"),
        "export {};",
    )
    .unwrap();
    assert_eq!(
        compile_fixture(&temp, &package, &lock, &dependency_root).unwrap_err(),
        ScriptPlanError::UnsafeScriptPath
    );
}

#[cfg(unix)]
#[test]
fn rejects_tool_bin_path_with_literal_backslash_in_a_posix_component() {
    let (temp, package, lock, dependency_root) = fixture("vite build");
    let vite = temp.path().join("node_modules/vite");
    let package_path = vite.join("package.json");
    let mut installed: Value = serde_json::from_slice(&fs::read(&package_path).unwrap()).unwrap();
    installed["bin"]["vite"] = json!(r"bin/vite\shim.js");
    fs::write(&package_path, serde_json::to_vec(&installed).unwrap()).unwrap();
    fs::write(vite.join("bin").join(r"vite\shim.js"), "").unwrap();
    assert_eq!(
        compile_fixture(&temp, &package, &lock, &dependency_root).unwrap_err(),
        ScriptPlanError::ToolchainInvalid
    );
}
