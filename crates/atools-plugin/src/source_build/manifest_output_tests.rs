use super::manifest_output::{
    pin_public_assets_with_limits, plan_public_root_rewrite, ManifestPathField,
};
use crate::package_resolution::normalize_candidate_manifest_paths;
use atools_core::models::PluginManifest;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::Path;

fn fixture(main: &str, asset: &str) -> (tempfile::TempDir, serde_json::Value, PluginManifest) {
    let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    std::fs::create_dir_all(root.path().join("public/preload")).unwrap();
    std::fs::write(
        root.path().join("index.html"),
        "<main>built source entry</main>",
    )
    .unwrap();
    std::fs::write(root.path().join("public/logo.png"), b"logo").unwrap();
    std::fs::write(root.path().join("public/preload/main.js"), b"preload").unwrap();
    let raw = json!({
        "name":"fixture", "version":"1.0.0", "main":main,
        "logo":asset, "preload":"preload/main.js",
        "features":[{"code":"open","explain":"Open","icon":"logo.png","cmds":["open"]}],
        "permissions":["db"], "tools":{"fixture":{"title":"Fixture"}}
    });
    let mut normalized: PluginManifest = serde_json::from_value(raw.clone()).unwrap();
    normalize_candidate_manifest_paths(
        root.path(),
        Path::new("public/plugin.json"),
        &mut normalized,
    )
    .unwrap();
    (root, raw, normalized)
}

#[test]
fn plans_only_public_parent_html_with_public_asset_projection() {
    let (root, raw, normalized) = fixture("../index.html", "logo.png");
    let plan = plan_public_root_rewrite(
        root.path(),
        Path::new("public/plugin.json"),
        &raw,
        &normalized,
    )
    .unwrap();
    assert!(plan.paths.iter().any(|path| {
        path.field == ManifestPathField::Main
            && path.source_value == "../index.html"
            && path.output_value == "index.html"
    }));
    assert!(plan.paths.iter().any(|path| {
        path.field == ManifestPathField::Preload
            && path.source_value == "preload/main.js"
            && path.output_value == "preload/main.js"
    }));
    assert!(plan.paths.iter().any(|path| {
        path.field == ManifestPathField::Logo
            && path.source_path == Path::new("public/logo.png")
            && path.output_value == "logo.png"
    }));
    assert!(plan.paths.iter().any(|path| {
        path.field == ManifestPathField::FeatureIcon(0) && path.output_value == "logo.png"
    }));
    assert_eq!(
        plan.public_assets.len(),
        2,
        "repeated icon/logo bytes are pinned once"
    );
    let logo = plan
        .public_assets
        .iter()
        .find(|asset| asset.source_path == Path::new("public/logo.png"))
        .unwrap();
    assert_eq!(logo.source_byte_len, Some(4));
    assert_eq!(
        logo.source_sha256.as_deref(),
        Some(format!("{:x}", Sha256::digest(b"logo")).as_str())
    );
}

#[test]
fn optional_missing_feature_icon_is_recorded_and_unique_byte_budget_is_enforced() {
    let (root, mut raw, _) = fixture("../index.html", "logo.png");
    raw["logo"] = json!("https://example.test/logo.png");
    raw["features"][0]["icon"] = json!("missing.png");
    let mut normalized: PluginManifest = serde_json::from_value(raw.clone()).unwrap();
    normalize_candidate_manifest_paths(
        root.path(),
        Path::new("public/plugin.json"),
        &mut normalized,
    )
    .unwrap();
    let plan = plan_public_root_rewrite(
        root.path(),
        Path::new("public/plugin.json"),
        &raw,
        &normalized,
    )
    .unwrap();
    let missing_icon = plan
        .public_assets
        .iter()
        .find(|asset| asset.source_path == Path::new("public/missing.png"))
        .unwrap();
    assert!(missing_icon.source_byte_len.is_none());
    assert!(missing_icon.source_sha256.is_none());

    let (root_for_budget, paths, normalized) = fixture("../index.html", "logo.png");
    let budget_plan = plan_public_root_rewrite(
        root_for_budget.path(),
        Path::new("public/plugin.json"),
        &paths,
        &normalized,
    )
    .unwrap();
    assert!(
        pin_public_assets_with_limits(root_for_budget.path(), &budget_plan.paths, 10, 4096)
            .is_none()
    );
    let pins = pin_public_assets_with_limits(root_for_budget.path(), &budget_plan.paths, 11, 4096)
        .unwrap();
    assert_eq!(pins.len(), 2);
    assert!(pins.iter().all(|pin| pin.source_byte_len.is_some()));
}

#[test]
fn source_code_entry_and_non_public_asset_keep_the_blocker() {
    let (root, raw, normalized) = fixture("../src/main.ts", "logo.png");
    assert!(plan_public_root_rewrite(
        root.path(),
        Path::new("public/plugin.json"),
        &raw,
        &normalized,
    )
    .is_none());

    let (root, raw, normalized) = fixture("../index.html", "../root-logo.png");
    assert!(plan_public_root_rewrite(
        root.path(),
        Path::new("public/plugin.json"),
        &raw,
        &normalized,
    )
    .is_none());
}

#[test]
fn runtime_entry_must_be_the_same_html_mapping() {
    let (root, mut raw, _) = fixture("../index.html", "logo.png");
    raw["runtime"] = json!({"kind":"web","entry":"../other.html"});
    let mut normalized: PluginManifest = serde_json::from_value(raw.clone()).unwrap();
    normalize_candidate_manifest_paths(
        root.path(),
        Path::new("public/plugin.json"),
        &mut normalized,
    )
    .unwrap();
    assert!(plan_public_root_rewrite(
        root.path(),
        Path::new("public/plugin.json"),
        &raw,
        &normalized,
    )
    .is_none());
}

#[test]
fn matching_runtime_entry_uses_the_main_output_mapping() {
    let (root, mut raw, _) = fixture("../index.html", "logo.png");
    raw["runtime"] = json!({"kind":"web","entry":"../index.html"});
    let mut normalized: PluginManifest = serde_json::from_value(raw.clone()).unwrap();
    normalize_candidate_manifest_paths(
        root.path(),
        Path::new("public/plugin.json"),
        &mut normalized,
    )
    .unwrap();
    let plan = plan_public_root_rewrite(
        root.path(),
        Path::new("public/plugin.json"),
        &raw,
        &normalized,
    )
    .unwrap();
    assert!(plan.paths.iter().any(|path| {
        path.field == ManifestPathField::RuntimeEntry
            && path.source_value == "../index.html"
            && path.output_value == "index.html"
    }));
}

#[cfg(unix)]
#[test]
fn symlinked_source_html_is_not_authorized_for_output_mapping() {
    use std::os::unix::fs::symlink;
    let (root, raw, normalized) = fixture("../index.html", "logo.png");
    let outside = tempfile::NamedTempFile::new().unwrap();
    std::fs::remove_file(root.path().join("index.html")).unwrap();
    symlink(outside.path(), root.path().join("index.html")).unwrap();
    assert!(plan_public_root_rewrite(
        root.path(),
        Path::new("public/plugin.json"),
        &raw,
        &normalized,
    )
    .is_none());
}
