use super::*;
use std::path::Path;

fn view_path(dependencies: &Path, binary: &Path) -> String {
    let relative = binary.strip_prefix(dependencies).unwrap();
    format!(
        "node_modules/{}",
        relative
            .components()
            .map(|part| part.as_os_str().to_str().unwrap())
            .collect::<Vec<_>>()
            .join("/")
    )
}

#[tokio::test]
#[ignore = "explicit private macOS two-esbuild sandbox gate; cached dependencies only"]
async fn node_test_and_vite_use_only_the_two_selected_esbuild_files() {
    let tools = tools();
    let test_esbuild = std::env::var_os("ATOOLS_SOURCE_BUILD_TEST_TEST_ESBUILD")
        .map(PathBuf::from)
        .expect("set exact local TSX test esbuild executable")
        .canonicalize()
        .unwrap();
    let third_esbuild = std::env::var_os("ATOOLS_SOURCE_BUILD_TEST_THIRD_ESBUILD")
        .map(PathBuf::from)
        .expect("set exact third executable that must remain denied")
        .canonicalize()
        .unwrap();
    assert!(test_esbuild.starts_with(&tools.dependencies));
    assert!(third_esbuild.starts_with(&tools.dependencies));
    assert!(
        test_esbuild != tools.esbuild
            && third_esbuild != tools.esbuild
            && third_esbuild != test_esbuild
    );
    let vite_view = view_path(&tools.dependencies, &tools.esbuild);
    let test_view = view_path(&tools.dependencies, &test_esbuild);

    let vite_config = format!(
        "import path from 'node:path';\nif (process.env.ESBUILD_BINARY_PATH !== path.resolve(process.cwd(), {vite_view:?})) throw new Error('Vite esbuild selection mismatch');\nexport default {{}};\n"
    );
    let (source, mut plan) = fixture(&tools, &vite_config);
    fs::write(
        source.path().join("index.html"),
        b"<main>fixture</main><script type=\"module\" src=\"/source.ts\"></script>",
    )
    .unwrap();
    fs::write(
        source.path().join("source.ts"),
        b"const fixtureValue: string = 'built fixture'; document.querySelector('main')!.textContent = fixtureValue;",
    )
    .unwrap();
    let test_dir = source.path().join("tests");
    fs::create_dir(&test_dir).unwrap();
    // The denied executable is a per-run fixture copy under the staged source,
    // never a write into the reviewed dependency tree.
    fs::copy(&third_esbuild, test_dir.join("unapproved-esbuild")).unwrap();
    fs::write(
        test_dir.join("toolchain.test.ts"),
        format!(
            "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {{ spawnSync }} from 'node:child_process';\nimport {{ chmodSync, statSync }} from 'node:fs';\nimport {{ fileURLToPath }} from 'node:url';\nimport path from 'node:path';\ntest('TSX selected esbuild and third executable is denied', () => {{\n  assert.equal(process.env.ESBUILD_BINARY_PATH, path.resolve(process.cwd(), {test_view:?}));\n  const third = fileURLToPath(new URL('./unapproved-esbuild', import.meta.url));\n  chmodSync(third, 0o755);\n  const thirdStat = statSync(third);\n  assert.equal(thirdStat.isFile(), true);\n  assert.equal(thirdStat.mode & 0o777, 0o755);\n  const result = spawnSync(third, [], {{ shell: false, encoding: 'utf8' }});\n  assert.equal(result.status, null);\n  assert.ok(result.error && ['EACCES', 'EPERM'].includes(result.error.code));\n  console.log('thirdExecutableDeniedErrno=' + result.error.code);\n}});\n"
        ),
    )
    .unwrap();
    plan.test_esbuild_binary = Some(test_esbuild);
    plan.build_steps = vec![
        atools_plugin::source_build::BuildStep::NodeTest {
            files: vec!["tests/toolchain.test.ts".into()],
        },
        atools_plugin::source_build::BuildStep::ViteBuild {
            cli: "node_modules/vite/bin/vite.js".into(),
        },
    ];
    let revision = staging::source_digest(source.path(), &AtomicBool::new(false))
        .unwrap()
        .0;
    let prepared = build(
        plan,
        tools.node,
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicBool::new(false)),
        revision,
    )
    .await
    .unwrap();
    assert!(prepared.output_dir.join("plugin.json").is_file());
    assert!(prepared.output_dir.join("index.html").is_file());
    assert!(prepared.diagnostics.root_reaped && prepared.diagnostics.original_group_closed);
}
