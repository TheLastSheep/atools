use std::{fs, path::Path};

use tauri::{utils::assets::AssetKey, Assets as _};

use super::RendererAssets;

fn load_error(path: &Path) -> String {
    RendererAssets::load(path)
        .err()
        .expect("expected asset load failure")
}

fn fixture_dist(root: &Path) {
    fs::create_dir_all(root.join("assets")).unwrap();
    fs::write(root.join("index.html"), b"<main>fixture</main>").unwrap();
    fs::write(root.join("assets/app.js"), b"window.fixture = true;").unwrap();
    fs::write(root.join("assets/app.css"), b"body { color: red; }").unwrap();
    fs::write(root.join("assets/icon.png"), b"png").unwrap();
    fs::write(root.join("source-manifest.json"), b"not served").unwrap();
    fs::write(root.join("ZTools-LICENSE"), b"not served").unwrap();
}

#[test]
fn loads_only_runtime_assets_with_exact_lookup_and_count_byte_metrics() {
    let temporary = tempfile::tempdir().unwrap();
    fixture_dist(temporary.path());
    let assets = RendererAssets::load(temporary.path()).unwrap();

    assert_eq!(
        assets.get(&AssetKey::from("index.html")).unwrap().as_ref(),
        b"<main>fixture</main>"
    );
    assert_eq!(
        assets
            .get(&AssetKey::from("assets/app.js"))
            .unwrap()
            .as_ref(),
        b"window.fixture = true;"
    );
    assert!(assets
        .get(&AssetKey::from("source-manifest.json"))
        .is_none());
    assert!(assets.get(&AssetKey::from("missing.js")).is_none());
    assert_eq!(assets.iter().count(), 4);
    assert_eq!(assets.csp_hashes(&AssetKey::from("index.html")).count(), 0);

    let metrics = assets.metrics();
    assert_eq!(metrics["runtimeAssetCount"], 4);
    assert_eq!(
        metrics["runtimeAssetBytes"],
        (b"<main>fixture</main>".len()
            + b"window.fixture = true;".len()
            + b"body { color: red; }".len()
            + b"png".len()) as u64
    );
    assert_eq!(metrics["javascriptAssetCount"], 1);
    assert!(metrics.to_string().contains("runtimeAssetBytes"));
    assert!(!metrics.to_string().contains("window.fixture"));
}

#[test]
fn requires_index_and_javascript_and_rejects_relative_or_traversal_dist_paths() {
    let temporary = tempfile::tempdir().unwrap();
    fs::create_dir_all(temporary.path().join("assets")).unwrap();
    fs::write(temporary.path().join("assets/app.js"), b"js").unwrap();
    assert!(RendererAssets::load(temporary.path()).is_err());

    fs::write(temporary.path().join("index.html"), b"index").unwrap();
    fs::remove_file(temporary.path().join("assets/app.js")).unwrap();
    assert!(RendererAssets::load(temporary.path()).is_err());
    assert!(RendererAssets::load(Path::new("relative/dist")).is_err());

    let traversal = temporary.path().join("..").join("unused");
    assert!(RendererAssets::load(&traversal).is_err());
    assert!(super::normalize_relative_asset_path(Path::new("assets/../escape.js")).is_err());
}

#[test]
fn rejects_more_than_sixty_four_runtime_files() {
    let temporary = tempfile::tempdir().unwrap();
    fixture_dist(temporary.path());
    for index in 0..61 {
        fs::write(
            temporary.path().join(format!("assets/extra-{index}.js")),
            b"x",
        )
        .unwrap();
    }
    assert!(load_error(temporary.path()).contains("64 runtime file"));
}

#[test]
fn rejects_single_file_and_total_runtime_size_limits() {
    let oversized_file = tempfile::tempdir().unwrap();
    fs::create_dir_all(oversized_file.path().join("assets")).unwrap();
    fs::write(oversized_file.path().join("index.html"), b"index").unwrap();
    fs::write(
        oversized_file.path().join("assets/app.js"),
        vec![b'x'; 1024 * 1024 + 1],
    )
    .unwrap();
    assert!(load_error(oversized_file.path()).contains("per-file"));

    let oversized_total = tempfile::tempdir().unwrap();
    fs::create_dir_all(oversized_total.path().join("assets")).unwrap();
    fs::write(
        oversized_total.path().join("index.html"),
        vec![b'i'; 800 * 1024],
    )
    .unwrap();
    fs::write(
        oversized_total.path().join("assets/app.js"),
        vec![b'j'; 800 * 1024],
    )
    .unwrap();
    fs::write(
        oversized_total.path().join("assets/app.css"),
        vec![b'c'; 600 * 1024],
    )
    .unwrap();
    assert!(load_error(oversized_total.path()).contains("2 MiB"));
}

#[cfg(unix)]
#[test]
fn rejects_symlinked_dist_roots_and_descendants() {
    use std::os::unix::fs::symlink;

    let temporary = tempfile::tempdir().unwrap();
    let dist = temporary.path().join("dist");
    fixture_dist(&dist);
    let linked_dist = temporary.path().join("linked-dist");
    symlink(&dist, &linked_dist).unwrap();
    assert!(RendererAssets::load(&linked_dist).is_err());

    let external = temporary.path().join("outside.js");
    fs::write(&external, b"outside").unwrap();
    symlink(&external, dist.join("assets/linked.js")).unwrap();
    assert!(load_error(&dist).contains("symlinks"));
}

#[test]
fn ignores_non_runtime_outputs_outside_assets() {
    let temporary = tempfile::tempdir().unwrap();
    fixture_dist(temporary.path());
    fs::create_dir_all(temporary.path().join("generated")).unwrap();
    fs::write(
        temporary.path().join("generated/not-served.js"),
        b"not served",
    )
    .unwrap();

    let assets = RendererAssets::load(temporary.path()).unwrap();
    assert!(assets
        .get(&AssetKey::from("generated/not-served.js"))
        .is_none());
}

#[test]
fn bounds_all_entries_and_scanned_directories_including_non_runtime_content() {
    let many_entries = tempfile::tempdir().unwrap();
    fixture_dist(many_entries.path());
    let notes = many_entries.path().join("notes");
    fs::create_dir(&notes).unwrap();
    for index in 0..300 {
        fs::write(notes.join(format!("note-{index}.txt")), b"ignored").unwrap();
    }
    assert!(load_error(many_entries.path()).contains("256 total entry"));

    let many_directories = tempfile::tempdir().unwrap();
    fixture_dist(many_directories.path());
    let ignored = many_directories.path().join("ignored");
    fs::create_dir(&ignored).unwrap();
    for index in 0..61 {
        fs::create_dir(ignored.join(format!("directory-{index}"))).unwrap();
    }
    assert!(RendererAssets::load(many_directories.path()).is_ok());
    fs::create_dir(ignored.join("directory-61")).unwrap();
    assert!(load_error(many_directories.path()).contains("64 scanned directory"));
}

#[test]
fn rejects_directory_trees_deeper_than_eight_levels() {
    let temporary = tempfile::tempdir().unwrap();
    fixture_dist(temporary.path());
    let mut deep = temporary.path().join("ignored");
    fs::create_dir(&deep).unwrap();
    for _ in 0..7 {
        deep.push("nested");
        fs::create_dir(&deep).unwrap();
    }
    assert!(RendererAssets::load(temporary.path()).is_ok());
    deep.push("nested");
    fs::create_dir(&deep).unwrap();
    assert!(load_error(temporary.path()).contains("8 directory depth"));
}
