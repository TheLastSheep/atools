use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use tauri::{utils::assets::AssetKey, Assets as _};

use super::super::{RendererAssets, MAX_RUNTIME_FILES, MAX_RUNTIME_TOTAL_BYTES};
use super::{digest_entries, load, sha256_hex, Entry, Manifest, MANIFEST_NAME, OWNER};

fn resource(path: &str, bytes: &[u8]) -> Entry {
    Entry {
        path: path.to_string(),
        sha256: sha256_hex(bytes),
        bytes: bytes.len() as u64,
    }
}

fn manifest() -> Manifest {
    let sources = vec![Entry {
        path: "src/main.ts".into(),
        sha256: "a".repeat(64),
        bytes: 3,
    }];
    let resources = vec![
        resource("assets/app.js", b"window.fallback = true;"),
        resource(
            "index.html",
            b"<script src=\"/fallback-settings/assets/app.js\"></script>",
        ),
    ];
    Manifest {
        schema_version: 1,
        owner: OWNER.to_string(),
        source_sha256: digest_entries(&sources).unwrap(),
        resource_sha256: digest_entries(&resources).unwrap(),
        resource_bytes: resources.iter().map(|entry| entry.bytes).sum(),
        resource_count: resources.len() as u64,
        sources,
        resources,
    }
}

fn write_bundle(root: &Path, value: &Manifest) {
    fs::create_dir_all(root.join("assets")).unwrap();
    for resource in &value.resources {
        let path = root.join(&resource.path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let bytes = match resource.path.as_str() {
            "assets/app.js" => b"window.fallback = true;".as_slice(),
            "index.html" => {
                b"<script src=\"/fallback-settings/assets/app.js\"></script>".as_slice()
            }
            _ => b"fixture".as_slice(),
        };
        fs::write(path, bytes).unwrap();
    }
    write_manifest(root, value);
}

fn write_manifest(root: &Path, value: &Manifest) {
    fs::write(root.join(MANIFEST_NAME), serde_json::to_vec(value).unwrap()).unwrap();
}

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap()
}

#[test]
fn accepts_exact_manifest_and_returns_namespaced_assets_and_summary() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("bundle");
    let value = manifest();
    write_bundle(&root, &value);

    let loaded = load(&canonical(&root)).unwrap();
    assert!(loaded.files.contains_key("/fallback-settings/index.html"));
    assert!(loaded
        .files
        .contains_key("/fallback-settings/assets/app.js"));
    assert_eq!(loaded.javascript_count, 1);
    assert_eq!(loaded.runtime_bytes, value.resource_bytes);
    assert_eq!(loaded.summary["sourceSha256"], value.source_sha256);
    assert_eq!(loaded.summary["resourceSha256"], value.resource_sha256);
    assert_eq!(loaded.summary["resourceCount"], value.resource_count);
    assert_eq!(loaded.summary["resourceBytes"], value.resource_bytes);
    assert_eq!(loaded.summary["manifestSha256"].as_str().unwrap().len(), 64);
}

#[test]
fn entry_digest_matches_node_json_stringify_field_order() {
    let entry = Entry {
        path: "src/main.ts".into(),
        sha256: "a".repeat(64),
        bytes: 3,
    };
    assert_eq!(
        digest_entries(&[entry]).unwrap(),
        "5f15717cabf01bb43862e7ea8ae7c37f6e1e740b327476cf7055433d53e3d5b1"
    );
}

#[test]
fn rejects_resource_bytes_that_do_not_match_the_manifest() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("bundle");
    let value = manifest();
    write_bundle(&root, &value);
    fs::write(root.join("assets/app.js"), b"tampered").unwrap();

    assert!(load(&canonical(&root)).is_err());
}

#[cfg(unix)]
#[test]
fn rejects_symlinked_roots_and_resources() {
    use std::os::unix::fs::symlink;

    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("bundle");
    write_bundle(&root, &manifest());
    let linked_root = temporary.path().join("linked-bundle");
    symlink(&root, &linked_root).unwrap();
    assert!(load(&linked_root).is_err());

    let external = temporary.path().join("external.js");
    fs::write(&external, b"window.external = true;").unwrap();
    fs::remove_file(root.join("assets/app.js")).unwrap();
    symlink(&external, root.join("assets/app.js")).unwrap();
    assert!(load(&canonical(&root)).is_err());
}

#[test]
fn rejects_traversal_unknown_paths_and_extra_files() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("bundle");
    fs::create_dir_all(&root).unwrap();
    let mut invalid = manifest();
    invalid.resources[0].path = "assets/../escape.js".into();
    invalid.resource_sha256 = digest_entries(&invalid.resources).unwrap();
    write_manifest(&root, &invalid);
    assert!(load(&canonical(&root)).is_err());

    let extra_root = temporary.path().join("extra");
    write_bundle(&extra_root, &manifest());
    fs::write(extra_root.join("unexpected.json"), b"{}").unwrap();
    assert!(load(&canonical(&extra_root)).is_err());
}

#[test]
fn rejects_digest_count_and_byte_total_mismatches() {
    let temporary = tempfile::tempdir().unwrap();
    let mut wrong_digest = manifest();
    wrong_digest.resource_sha256 = "0".repeat(64);
    let digest_root = temporary.path().join("digest");
    write_bundle(&digest_root, &wrong_digest);
    assert!(load(&canonical(&digest_root)).is_err());

    let mut wrong_count = manifest();
    wrong_count.resource_count += 1;
    let count_root = temporary.path().join("count");
    write_bundle(&count_root, &wrong_count);
    assert!(load(&canonical(&count_root)).is_err());

    let mut wrong_total = manifest();
    wrong_total.resource_bytes += 1;
    let total_root = temporary.path().join("total");
    write_bundle(&total_root, &wrong_total);
    assert!(load(&canonical(&total_root)).is_err());
}

fn original_assets() -> RendererAssets {
    let temporary = tempfile::tempdir().unwrap();
    fs::create_dir_all(temporary.path().join("assets")).unwrap();
    fs::write(temporary.path().join("index.html"), b"main").unwrap();
    fs::write(temporary.path().join("assets/main.js"), b"main js").unwrap();
    RendererAssets::load(&canonical(temporary.path())).unwrap()
}

#[test]
fn merges_into_one_namespace_and_updates_runtime_metrics() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("bundle");
    write_bundle(&root, &manifest());
    let mut original = original_assets();
    let summary = original.add_fallback_settings(&canonical(&root)).unwrap();

    assert_eq!(original.files.len(), 4);
    assert_eq!(original.javascript_count, 2);
    assert_eq!(original.runtime_bytes, 4 + 7 + manifest().resource_bytes);
    assert_eq!(summary["resourceCount"], 2);
    assert!(original.files.contains_key("/fallback-settings/index.html"));
    assert!(original
        .files
        .contains_key("/fallback-settings/assets/app.js"));
    assert_eq!(
        original
            .get(&AssetKey::from("fallback-settings/index.html"))
            .unwrap()
            .as_ref(),
        b"<script src=\"/fallback-settings/assets/app.js\"></script>"
    );
}

#[test]
fn rejects_namespace_conflicts_without_partially_merging() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("bundle");
    write_bundle(&root, &manifest());
    let mut files = BTreeMap::new();
    files.insert(
        "/fallback-settings/index.html".to_string(),
        b"existing".to_vec().into_boxed_slice(),
    );
    let mut original = RendererAssets {
        files,
        javascript_count: 1,
        runtime_bytes: 8,
    };

    assert!(original.add_fallback_settings(&canonical(&root)).is_err());
    assert_eq!(original.files.len(), 1);
    assert_eq!(original.runtime_bytes, 8);
    assert_eq!(original.javascript_count, 1);
}

#[test]
fn rejects_combined_file_count_and_byte_budget_overflow_atomically() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("bundle");
    write_bundle(&root, &manifest());

    let mut files = (0..MAX_RUNTIME_FILES - 1)
        .map(|index| (format!("/original-{index}"), vec![b'x'].into_boxed_slice()))
        .collect::<BTreeMap<_, _>>();
    let mut count_limited = RendererAssets {
        runtime_bytes: files.len() as u64,
        files: std::mem::take(&mut files),
        javascript_count: 0,
    };
    assert!(count_limited
        .add_fallback_settings(&canonical(&root))
        .is_err());
    assert_eq!(count_limited.files.len(), MAX_RUNTIME_FILES - 1);
    assert_eq!(count_limited.runtime_bytes, (MAX_RUNTIME_FILES - 1) as u64);

    let mut byte_limited = RendererAssets {
        files: BTreeMap::from([("/original".into(), vec![b'x'].into_boxed_slice())]),
        javascript_count: 0,
        runtime_bytes: MAX_RUNTIME_TOTAL_BYTES - 1,
    };
    assert!(byte_limited
        .add_fallback_settings(&canonical(&root))
        .is_err());
    assert_eq!(byte_limited.files.len(), 1);
    assert_eq!(byte_limited.runtime_bytes, MAX_RUNTIME_TOTAL_BYTES - 1);
}

#[test]
#[ignore = "requires the staged Node fallback fixture and built main renderer dist"]
fn validates_staged_fixture_and_combined_main_renderer_budget() {
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let main_dist = repository.join("packages/ztools-renderer/dist");
    let fallback_dist = repository.join("output/fallback-settings-native-dist");
    let main_dist = main_dist.canonicalize().unwrap();
    let fallback_dist = fallback_dist.canonicalize().unwrap();
    let mut assets = RendererAssets::load(&main_dist).unwrap();
    #[cfg(feature = "ztools-multiwebview")]
    assets.add_multiwebview_probes().unwrap();
    let summary = assets.add_fallback_settings(&fallback_dist).unwrap();
    assert!(summary["manifestSha256"]
        .as_str()
        .is_some_and(|value| value.len() == 64));
    assert!(assets.files.len() <= MAX_RUNTIME_FILES);
    assert!(assets.runtime_bytes <= MAX_RUNTIME_TOTAL_BYTES);
}
