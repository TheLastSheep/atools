use super::{manifest_output, output, staging};
use atools_plugin::source_build::{
    ManifestIdentity, ManifestOutputRewritePlan, ManifestPathField, ManifestPathRewrite,
    ManifestSelection, PublicAssetPin, SourceBuildPlan, ViteBuildBackend,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::atomic::AtomicBool;

struct Fixture {
    work: tempfile::TempDir,
    output: tempfile::TempDir,
    plan: SourceBuildPlan,
    approved: output::ApprovedManifest,
}

fn fixture(source_main: &str) -> Fixture {
    let source = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let output = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    std::fs::create_dir_all(source.path().join("public/preload")).unwrap();
    std::fs::create_dir_all(output.path().join("preload")).unwrap();
    std::fs::write(source.path().join("index.html"), "<main>source</main>").unwrap();
    std::fs::write(output.path().join("index.html"), "<main>built</main>").unwrap();
    std::fs::write(source.path().join("public/logo.png"), b"public-logo").unwrap();
    std::fs::write(output.path().join("logo.png"), b"public-logo").unwrap();
    std::fs::write(source.path().join("public/preload/main.js"), b"preload();").unwrap();
    std::fs::write(output.path().join("preload/main.js"), b"preload();").unwrap();
    let raw = json!({
        "name":"rewrite-fixture", "version":"1.0.0", "title":"Fixture",
        "main":source_main, "logo":"logo.png", "preload":"preload/main.js",
        "permissions":["db"], "tools":{"test":{"title":"Test"}},
        "features":[{"code":"open","explain":"Open","icon":"logo.png","cmds":["open"]}]
    });
    let source_manifest_bytes = serde_json::to_vec(&raw).unwrap();
    std::fs::write(
        source.path().join("public/plugin.json"),
        &source_manifest_bytes,
    )
    .unwrap();
    std::fs::write(
        output.path().join("plugin.json"),
        serde_json::to_vec(&raw).unwrap(),
    )
    .unwrap();
    let typed: atools_core::PluginManifest = serde_json::from_value(raw.clone()).unwrap();
    let identity = ManifestIdentity::from_plugin_manifest(&typed).unwrap();
    let source_root = source.path().to_path_buf();
    let paths = vec![
        rewrite(
            ManifestPathField::Main,
            "index.html",
            source_main,
            "index.html",
        ),
        rewrite(
            ManifestPathField::Logo,
            "public/logo.png",
            "logo.png",
            "logo.png",
        ),
        rewrite(
            ManifestPathField::Preload,
            "public/preload/main.js",
            "preload/main.js",
            "preload/main.js",
        ),
        rewrite(
            ManifestPathField::FeatureIcon(0),
            "public/logo.png",
            "logo.png",
            "logo.png",
        ),
    ];
    Fixture {
        work: source,
        output,
        plan: SourceBuildPlan {
            source_root,
            manifest_relative: "public/plugin.json".into(),
            manifest_selection: ManifestSelection::Public,
            manifest_sha256: format!("{:x}", Sha256::digest(&source_manifest_bytes)),
            manifest_identity: identity,
            plugin_id: "rewrite-fixture".into(),
            version: "1.0.0".into(),
            dependency_root: Path::new("/unused").into(),
            vite_cli: Path::new("/unused/vite").into(),
            vite_backend: ViteBuildBackend::Esbuild {
                binary: Path::new("/unused/esbuild").into(),
            },
            test_esbuild_binary: None,
            manifest_output_rewrite: Some(ManifestOutputRewritePlan {
                paths,
                public_assets: vec![
                    asset_pin("public/logo.png", "logo.png", b"public-logo"),
                    asset_pin("public/preload/main.js", "preload/main.js", b"preload();"),
                ],
            }),
            build_steps: vec![],
        },
        approved: output::ApprovedManifest { typed, raw },
    }
}

fn rewrite(
    field: ManifestPathField,
    source_path: &str,
    source_value: &str,
    output_value: &str,
) -> ManifestPathRewrite {
    ManifestPathRewrite {
        field,
        source_path: source_path.into(),
        source_value: source_value.into(),
        output_value: output_value.into(),
    }
}

fn asset_pin(source: &str, output: &str, bytes: &[u8]) -> PublicAssetPin {
    PublicAssetPin {
        source_path: source.into(),
        output_path: output.into(),
        source_byte_len: Some(bytes.len() as u64),
        source_sha256: Some(format!("{:x}", Sha256::digest(bytes))),
    }
}

fn run(fixture: &Fixture) -> Result<Option<manifest_output::ManifestRewriteReceipt>, String> {
    manifest_output::rewrite_verified_output(
        fixture.output.path(),
        &fixture.plan,
        &fixture.approved,
    )
}

#[test]
fn rewrites_only_authorized_paths_then_passes_existing_ready_validation() {
    let fixture = fixture("../index.html");
    let receipt = run(&fixture).unwrap().unwrap();
    let output_json: Value = serde_json::from_slice(
        &staging::read_regular(&fixture.output.path().join("plugin.json"), 256 * 1024).unwrap(),
    )
    .unwrap();
    assert_eq!(output_json["main"], "index.html");
    assert_eq!(output_json["logo"], "logo.png");
    assert_eq!(output_json["preload"], "preload/main.js");
    assert_eq!(output_json["permissions"], json!(["db"]));
    assert_eq!(output_json["tools"], fixture.approved.raw["tools"]);
    assert_eq!(receipt.mapped_fields, vec!["main"]);
    assert_ne!(receipt.before_sha256, receipt.after_sha256);
    output::validate(fixture.output.path(), &fixture.plan, &fixture.approved).unwrap();
}

#[test]
fn accepts_plugin_hook_canonical_main_without_rewriting_runner_bytes() {
    let fixture = fixture("../index.html");
    let manifest_path = fixture.output.path().join("plugin.json");
    let mut output_json: Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
    output_json["main"] = json!("index.html");
    std::fs::write(&manifest_path, serde_json::to_vec(&output_json).unwrap()).unwrap();
    let before = std::fs::read(&manifest_path).unwrap();
    let receipt = run(&fixture).unwrap().unwrap();
    let after = std::fs::read(&manifest_path).unwrap();
    assert_eq!(before, after);
    assert_eq!(receipt.before_sha256, receipt.after_sha256);
    output::validate(fixture.output.path(), &fixture.plan, &fixture.approved).unwrap();
}

#[test]
fn rejects_changed_nonpath_metadata_and_unknown_runner_path_without_mutation() {
    let fixture = fixture("../index.html");
    let manifest_path = fixture.output.path().join("plugin.json");
    let mut bad: Value = serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
    bad["permissions"] = json!(["filesystem"]);
    std::fs::write(&manifest_path, serde_json::to_vec(&bad).unwrap()).unwrap();
    let before = std::fs::read(&manifest_path).unwrap();
    assert_eq!(
        run(&fixture).unwrap_err(),
        "SourceBuildOutputManifestMetadataMismatch"
    );
    assert_eq!(std::fs::read(&manifest_path).unwrap(), before);

    bad["permissions"] = json!(["db"]);
    bad["main"] = json!("../src/main.ts");
    std::fs::write(&manifest_path, serde_json::to_vec(&bad).unwrap()).unwrap();
    let before = std::fs::read(&manifest_path).unwrap();
    assert_eq!(
        run(&fixture).unwrap_err(),
        "SourceBuildOutputManifestPathMismatch"
    );
    assert_eq!(std::fs::read(&manifest_path).unwrap(), before);
}

#[test]
fn rejects_public_asset_output_that_is_not_the_source_public_copy() {
    let fixture = fixture("../index.html");
    std::fs::write(fixture.output.path().join("logo.png"), b"other logo").unwrap();
    assert_eq!(
        run(&fixture).unwrap_err(),
        "SourceBuildOutputPublicAssetMismatch"
    );
}

#[test]
fn absent_built_html_still_fails_the_existing_package_readiness_gate() {
    let fixture = fixture("../index.html");
    std::fs::remove_file(fixture.output.path().join("index.html")).unwrap();
    let _receipt = run(&fixture).unwrap().unwrap();
    assert_eq!(
        output::validate(fixture.output.path(), &fixture.plan, &fixture.approved).unwrap_err(),
        "SourceBuildInvalidOutput"
    );
}

#[test]
fn output_manifest_read_is_bounded_and_no_follow() {
    let fixture = fixture("../index.html");
    let manifest = fixture.output.path().join("plugin.json");
    std::fs::write(&manifest, vec![b'x'; 256 * 1024 + 1]).unwrap();
    assert_eq!(run(&fixture).unwrap_err(), "SourceBuildFileLimitExceeded");
}

#[test]
fn published_copy_is_bound_to_the_rewrite_receipt_hash() {
    let fixture = fixture("../index.html");
    let receipt = run(&fixture).unwrap().unwrap();
    let published = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let package = published.path().join("package");
    staging::copy_output(fixture.output.path(), &package, &AtomicBool::new(false)).unwrap();
    manifest_output::verify_published_manifest(&package, &receipt, &fixture.plan).unwrap();
    std::fs::write(
        package.join("plugin.json"),
        br#"{"name":"changed","version":"1.0.0"}"#,
    )
    .unwrap();
    assert_eq!(
        manifest_output::verify_published_manifest(&package, &receipt, &fixture.plan).unwrap_err(),
        "SourceBuildOutputManifestCopyChanged"
    );
}

#[test]
fn published_copy_rechecks_pre_run_asset_pin_after_ready_precheck() {
    let fixture = fixture("../index.html");
    let receipt = run(&fixture).unwrap().unwrap();
    output::validate(fixture.output.path(), &fixture.plan, &fixture.approved).unwrap();

    // Model a same-length mutation after the staged readiness check and before import.
    std::fs::write(fixture.output.path().join("logo.png"), b"mutatedlogo").unwrap();
    let published = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let package = published.path().join("package");
    staging::copy_output(fixture.output.path(), &package, &AtomicBool::new(false)).unwrap();
    assert_eq!(
        manifest_output::verify_published_manifest(&package, &receipt, &fixture.plan).unwrap_err(),
        "SourceBuildOutputPublicAssetMismatch"
    );
}

#[test]
fn optional_missing_asset_pin_remains_absent_through_published_validation() {
    let mut fixture = fixture("../index.html");
    fixture.approved.raw["features"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "code":"optional", "explain":"Optional", "icon":"missing-icon.svg", "cmds":["optional"]
        }));
    fixture.approved.typed = serde_json::from_value(fixture.approved.raw.clone()).unwrap();
    let rewrite_plan = fixture.plan.manifest_output_rewrite.as_mut().unwrap();
    rewrite_plan.paths.push(rewrite(
        ManifestPathField::FeatureIcon(1),
        "public/missing-icon.svg",
        "missing-icon.svg",
        "missing-icon.svg",
    ));
    rewrite_plan.public_assets.push(PublicAssetPin {
        source_path: "public/missing-icon.svg".into(),
        output_path: "missing-icon.svg".into(),
        source_byte_len: None,
        source_sha256: None,
    });
    std::fs::write(
        fixture.output.path().join("plugin.json"),
        serde_json::to_vec(&fixture.approved.raw).unwrap(),
    )
    .unwrap();

    let receipt = run(&fixture).unwrap().unwrap();
    let published = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let package = published.path().join("package");
    staging::copy_output(fixture.output.path(), &package, &AtomicBool::new(false)).unwrap();
    manifest_output::verify_published_manifest(&package, &receipt, &fixture.plan).unwrap();
    assert!(!package.join("missing-icon.svg").exists());
}

#[cfg(unix)]
#[test]
fn rejects_manifest_symlink_before_any_replacement() {
    use std::os::unix::fs::symlink;
    let fixture = fixture("../index.html");
    let manifest = fixture.output.path().join("plugin.json");
    let target = fixture.output.path().join("held.json");
    let target_before = std::fs::read(&manifest).unwrap();
    std::fs::rename(&manifest, &target).unwrap();
    symlink(&target, &manifest).unwrap();
    assert_eq!(run(&fixture).unwrap_err(), "SourceBuildExpectedRegularFile");
    assert_eq!(std::fs::read(&target).unwrap(), target_before);
    assert_eq!(std::fs::read_link(&manifest).unwrap(), target);
}

#[test]
fn no_rewrite_plan_keeps_existing_output_behavior() {
    let mut fixture = fixture("../index.html");
    fixture.plan.manifest_output_rewrite = None;
    assert!(run(&fixture).unwrap().is_none());
}

#[test]
fn post_runner_work_asset_mutation_cannot_change_pre_run_asset_authority() {
    let fixture = fixture("../index.html");
    std::fs::write(
        fixture.work.path().join("public/logo.png"),
        b"runner-mutated-source",
    )
    .unwrap();
    run(&fixture).unwrap();
    output::validate(fixture.output.path(), &fixture.plan, &fixture.approved).unwrap();
}

#[test]
fn mutating_work_and_output_to_the_same_new_asset_bytes_does_not_change_pre_run_authority() {
    let fixture = fixture("../index.html");
    let mutated = b"same-mutated-bytes";
    std::fs::write(fixture.work.path().join("public/logo.png"), mutated).unwrap();
    std::fs::write(fixture.output.path().join("logo.png"), mutated).unwrap();
    assert_eq!(
        run(&fixture).unwrap_err(),
        "SourceBuildOutputPublicAssetMismatch"
    );
}

#[cfg(unix)]
#[test]
fn pinned_directory_replace_does_not_follow_a_swapped_parent_symlink() {
    use std::os::unix::fs::symlink;
    use std::{ffi::OsStr, fs};

    let parent = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let stage = parent.path().join("stage");
    let moved = parent.path().join("moved");
    let outside = parent.path().join("outside");
    fs::create_dir(&stage).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(stage.join("plugin.json"), br#"{"main":"../index.html"}"#).unwrap();
    fs::write(outside.join("plugin.json"), b"outside-untouched").unwrap();

    let pinned = staging::Directory::absolute(&stage).unwrap();
    let snapshot = staging::read_relative_regular(&pinned, Path::new("plugin.json"), 256 * 1024)
        .unwrap()
        .unwrap();
    fs::rename(&stage, &moved).unwrap();
    symlink(&outside, &stage).unwrap();

    staging::replace_relative_regular(
        &pinned,
        OsStr::new("plugin.json"),
        &snapshot,
        b"{\"main\":\"index.html\"}\n",
    )
    .unwrap();
    assert_eq!(
        fs::read(moved.join("plugin.json")).unwrap(),
        b"{\"main\":\"index.html\"}\n"
    );
    assert_eq!(
        fs::read(outside.join("plugin.json")).unwrap(),
        b"outside-untouched"
    );
    fs::remove_file(stage).unwrap();
    fs::remove_dir_all(moved).unwrap();
}
