use super::{create, create_with_limit};
use std::fs;
use std::os::unix::fs::symlink;
use std::path::Path;
use std::sync::atomic::AtomicBool;

fn fixture() -> tempfile::TempDir {
    let canonical_temp = std::env::temp_dir().canonicalize().unwrap();
    tempfile::tempdir_in(canonical_temp).unwrap()
}

fn make_package(root: &Path, relative: &str, contents: &[u8]) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

#[test]
fn package_and_scope_links_resolve_without_linking_manager_or_cache_roots() {
    let temp = fixture();
    let dependencies = temp.path().join("dependencies");
    let work = temp.path().join("stage/work");
    let view = work.join("node_modules");
    fs::create_dir_all(&dependencies).unwrap();
    fs::create_dir_all(&work).unwrap();

    make_package(
        &dependencies,
        ".pnpm/vite@1/node_modules/vite/bin/vite.js",
        b"vite-cli",
    );
    make_package(
        &dependencies,
        ".pnpm/tool@1/node_modules/tool/index.js",
        b"tool",
    );
    make_package(
        &dependencies,
        ".pnpm/tool@1/node_modules/peer/index.js",
        b"peer-dependency",
    );
    symlink(
        dependencies.join(".pnpm/vite@1/node_modules/vite"),
        dependencies.join("vite"),
    )
    .unwrap();
    symlink(
        dependencies.join(".pnpm/tool@1/node_modules/tool"),
        dependencies.join("tool"),
    )
    .unwrap();
    fs::create_dir_all(dependencies.join(".pnpm/tool@1/node_modules/tool/node_modules")).unwrap();
    symlink(
        dependencies.join(".pnpm/tool@1/node_modules/peer"),
        dependencies.join(".pnpm/tool@1/node_modules/tool/node_modules/peer"),
    )
    .unwrap();
    fs::create_dir_all(dependencies.join("@types/node")).unwrap();
    fs::write(
        dependencies.join("@types/node/index.d.ts"),
        b"declare const process: unknown;",
    )
    .unwrap();
    fs::create_dir_all(dependencies.join(".bin")).unwrap();
    symlink(
        dependencies.join(".pnpm/vite@1/node_modules/vite/bin/vite.js"),
        dependencies.join(".bin/vite"),
    )
    .unwrap();
    fs::write(dependencies.join(".package-lock.json"), b"metadata").unwrap();
    make_package(
        &dependencies,
        ".vue-global-types/vue_3.5_0_0_0.d.ts",
        b"// Volar generated global type declarations",
    );
    let original_vue_types =
        fs::read(dependencies.join(".vue-global-types/vue_3.5_0_0_0.d.ts")).unwrap();
    make_package(&dependencies, ".vite/cache-entry", b"original vite cache");
    make_package(
        &dependencies,
        ".vite-temp/old-entry",
        b"original temp cache",
    );
    let original_cache = fs::read(dependencies.join(".vite/cache-entry")).unwrap();
    let original_temp = fs::read(dependencies.join(".vite-temp/old-entry")).unwrap();
    let cache_digest =
        super::super::staging::source_digest(&dependencies.join(".vite"), &AtomicBool::new(false))
            .unwrap()
            .0;
    let temp_digest = super::super::staging::source_digest(
        &dependencies.join(".vite-temp"),
        &AtomicBool::new(false),
    )
    .unwrap()
    .0;

    create(&dependencies, &view, &AtomicBool::new(false)).unwrap();
    assert!(fs::symlink_metadata(&view).unwrap().is_dir());
    assert!(!fs::symlink_metadata(&view)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        fs::read(view.join("vite/bin/vite.js")).unwrap(),
        b"vite-cli"
    );
    assert_eq!(
        fs::read(view.join("tool/node_modules/peer/index.js")).unwrap(),
        b"peer-dependency"
    );
    assert_eq!(
        fs::read(view.join("@types/node/index.d.ts")).unwrap(),
        b"declare const process: unknown;"
    );
    assert_eq!(fs::read(view.join(".bin/vite")).unwrap(), b"vite-cli");
    assert!(!view.join(".pnpm").exists());
    assert!(!view.join(".package-lock.json").exists());
    assert!(!view.join(".vue-global-types").exists());
    assert!(!view.join(".vite").exists());
    assert!(!view.join(".vite-temp").exists());

    make_package(&view, ".vite-temp/new-cache-entry", b"stage-owned write");
    assert_eq!(
        fs::read(view.join(".vite-temp/new-cache-entry")).unwrap(),
        b"stage-owned write"
    );
    assert_eq!(
        fs::read(dependencies.join(".vite/cache-entry")).unwrap(),
        original_cache
    );
    assert_eq!(
        fs::read(dependencies.join(".vite-temp/old-entry")).unwrap(),
        original_temp
    );
    assert_eq!(
        fs::read(dependencies.join(".vue-global-types/vue_3.5_0_0_0.d.ts")).unwrap(),
        original_vue_types
    );
    assert!(!dependencies.join(".vite-temp/new-cache-entry").exists());
    assert_eq!(
        super::super::staging::source_digest(&dependencies.join(".vite"), &AtomicBool::new(false),)
            .unwrap()
            .0,
        cache_digest
    );
    assert_eq!(
        super::super::staging::source_digest(
            &dependencies.join(".vite-temp"),
            &AtomicBool::new(false),
        )
        .unwrap()
        .0,
        temp_digest
    );
    let scratch = temp.path().to_path_buf();
    drop(temp);
    assert!(!scratch.exists());
}

#[test]
fn dependency_targets_must_remain_inside_reviewed_root() {
    let temp = fixture();
    let root = temp.path().join("dependencies");
    let outside = temp.path().join("outside/package");
    let destination = temp.path().join("stage/node_modules");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("index.js"), b"outside").unwrap();
    symlink(&outside, root.join("escape")).unwrap();
    fs::create_dir_all(destination.parent().unwrap()).unwrap();
    assert_eq!(
        create(&root, &destination, &AtomicBool::new(false)).unwrap_err(),
        "SourceBuildDependencyEscapeRejected"
    );
}

#[test]
fn invalid_entries_and_scan_limits_fail_closed() {
    let temp = fixture();
    let root = temp.path().join("dependencies");
    fs::create_dir_all(&root).unwrap();
    make_package(&root, "good/index.js", b"ok");
    fs::write(root.join("unexpected.txt"), b"not a package").unwrap();
    make_package(
        &root,
        ".unapproved-cache/metadata",
        b"not the known Vue cache",
    );
    let destination = temp.path().join("stage/node_modules");
    fs::create_dir_all(destination.parent().unwrap()).unwrap();
    assert_eq!(
        create(&root, &destination, &AtomicBool::new(false)).unwrap_err(),
        "SourceBuildDependencyEntryInvalid"
    );

    let limited = temp.path().join("stage/limited-node_modules");
    assert_eq!(
        create_with_limit(&root, &limited, &AtomicBool::new(false), 1).unwrap_err(),
        "SourceBuildDependencyViewLimitExceeded"
    );
    let cancelled = temp.path().join("stage/cancelled-node_modules");
    assert_eq!(
        create(&root, &cancelled, &AtomicBool::new(true)).unwrap_err(),
        "SOURCE_BUILD_CANCELLED"
    );
}

#[test]
fn bin_symlink_to_outside_is_rejected() {
    let temp = fixture();
    let root = temp.path().join("dependencies");
    let outside = temp.path().join("outside/tool");
    let destination = temp.path().join("stage/node_modules");
    fs::create_dir_all(root.join(".bin")).unwrap();
    fs::create_dir_all(outside.parent().unwrap()).unwrap();
    fs::write(&outside, b"tool").unwrap();
    symlink(&outside, root.join(".bin/command")).unwrap();
    fs::create_dir_all(destination.parent().unwrap()).unwrap();
    assert_eq!(
        create(&root, &destination, &AtomicBool::new(false)).unwrap_err(),
        "SourceBuildDependencyEscapeRejected"
    );
}
