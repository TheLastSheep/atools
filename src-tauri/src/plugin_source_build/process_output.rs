//! Preserve the approved raw manifest identity separately from its install ID.
use super::staging;
use atools_core::PluginManifest;
#[cfg(test)]
use atools_plugin::source_build::ViteBuildBackend;
use atools_plugin::{
    package_resolution::{resolve_plugin_package, PackageReadiness},
    source_build::{ManifestIdentity, ManifestPathField, ManifestSelection, SourceBuildPlan},
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Component, Path};

pub(super) struct ApprovedManifest {
    pub(super) typed: PluginManifest,
    pub(super) raw: Value,
}

pub(super) fn approved_manifest(
    root: &Path,
    plan: &SourceBuildPlan,
) -> Result<ApprovedManifest, String> {
    let selected_path = match plan.manifest_selection {
        ManifestSelection::Root => Path::new("plugin.json"),
        ManifestSelection::Public => Path::new("public/plugin.json"),
    };
    if plan.manifest_relative.as_os_str().is_empty()
        || plan.manifest_relative != selected_path
        || plan
            .manifest_relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("SourceBuildUnsafeManifestPath".into());
    }
    let bytes = staging::read_regular(&root.join(&plan.manifest_relative), 256 * 1024)?;
    let raw: Value =
        serde_json::from_slice(&bytes).map_err(|_| "SourceBuildInvalidSourceManifest")?;
    let manifest: PluginManifest =
        serde_json::from_value(raw.clone()).map_err(|_| "SourceBuildInvalidSourceManifest")?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let identity = ManifestIdentity::from_plugin_manifest(&manifest)
        .ok_or("SourceBuildSourceIdentityMismatch")?;
    if atools_core::sanitize_id(&manifest.name) != plan.plugin_id
        || manifest.version != plan.version
        || digest != plan.manifest_sha256
        || identity != plan.manifest_identity
    {
        return Err("SourceBuildSourceIdentityMismatch".into());
    }
    Ok(ApprovedManifest {
        typed: manifest,
        raw,
    })
}

pub(super) fn validate(
    root: &Path,
    plan: &SourceBuildPlan,
    approved: &ApprovedManifest,
) -> Result<(), String> {
    let package = resolve_plugin_package(root).map_err(|_| "SourceBuildInvalidOutput")?;
    if package.package_root != root || package.readiness != PackageReadiness::Ready {
        return Err("SourceBuildInvalidOutput".into());
    }
    let actual_identity = ManifestIdentity::from_plugin_manifest(&package.manifest)
        .ok_or("SourceBuildOutputIdentityMismatch")?;
    let expected_identity = ManifestIdentity::from_plugin_manifest(&approved.typed)
        .ok_or("SourceBuildOutputIdentityMismatch")?;
    if package.manifest.name != approved.typed.name
        || package.manifest.version != approved.typed.version
        || atools_core::sanitize_id(&package.manifest.name) != plan.plugin_id
        || package.manifest.version != plan.version
        || actual_identity.runtime != expected_identity.runtime
        || actual_identity.feature_codes != expected_identity.feature_codes
        || !authorized_entry_projection_matches(plan, &actual_identity, &expected_identity)
    {
        return Err("SourceBuildOutputIdentityMismatch".into());
    }
    Ok(())
}

fn authorized_entry_projection_matches(
    plan: &SourceBuildPlan,
    actual: &ManifestIdentity,
    source: &ManifestIdentity,
) -> bool {
    let Some(rewrite) = &plan.manifest_output_rewrite else {
        // Preserve the established root-manifest output-path behavior; the source
        // and packaged layouts are already checked by the existing package verifier.
        return true;
    };
    let mut expected_main = source.main.as_str();
    let mut expected_preload = source.preload.as_deref();
    for path in &rewrite.paths {
        match path.field {
            ManifestPathField::Main => expected_main = &path.output_value,
            ManifestPathField::Preload => expected_preload = Some(&path.output_value),
            _ => {}
        }
    }
    actual.main == expected_main && actual.preload.as_deref() == expected_preload
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(name: &str) -> (tempfile::TempDir, SourceBuildPlan) {
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        std::fs::write(root.path().join("plugin.json"), serde_json::json!({"name":name,"version":"1.0.0","main":"index.html","features":[{"code":"open","explain":"Open","cmds":["fixture"]}]}).to_string()).unwrap();
        std::fs::write(root.path().join("index.html"), "<main>fixture</main>").unwrap();
        let manifest: PluginManifest = serde_json::from_str(
            &std::fs::read_to_string(root.path().join("plugin.json")).unwrap(),
        )
        .unwrap();
        let raw = std::fs::read(root.path().join("plugin.json")).unwrap();
        let plan = SourceBuildPlan {
            source_root: root.path().to_path_buf(),
            manifest_relative: "plugin.json".into(),
            manifest_selection: ManifestSelection::Root,
            manifest_sha256: format!("{:x}", Sha256::digest(raw)),
            manifest_identity: ManifestIdentity::from_plugin_manifest(&manifest).unwrap(),
            plugin_id: atools_core::sanitize_id(name),
            version: "1.0.0".into(),
            dependency_root: "/unused".into(),
            vite_cli: "/unused/vite".into(),
            vite_backend: ViteBuildBackend::Esbuild {
                binary: "/unused/esbuild".into(),
            },
            test_esbuild_binary: None,
            manifest_output_rewrite: None,
            build_steps: vec![],
        };
        (root, plan)
    }
    #[test]
    fn raw_name_and_stable_install_id_are_checked_independently() {
        let (root, plan) = fixture("Fancy.Plugin Name");
        let approved = approved_manifest(root.path(), &plan).unwrap();
        assert_eq!(plan.plugin_id, "Fancy-Plugin-Name");
        validate(root.path(), &plan, &approved).unwrap();
        let (changed, _) = fixture("Fancy Plugin Name");
        assert_eq!(
            atools_core::sanitize_id("Fancy Plugin Name"),
            plan.plugin_id
        );
        assert_eq!(
            validate(changed.path(), &plan, &approved).unwrap_err(),
            "SourceBuildOutputIdentityMismatch"
        );
    }
    #[test]
    fn manifest_path_cannot_read_outside_snapshot() {
        let (root, mut plan) = fixture("fixture");
        for bad in ["../plugin.json", "/plugin.json", ""] {
            plan.manifest_relative = bad.into();
            assert!(approved_manifest(root.path(), &plan).is_err());
        }
    }

    #[test]
    fn source_manifest_bytes_and_selection_are_bound_to_the_plan() {
        let (root, mut plan) = fixture("fixture");
        plan.manifest_selection = ManifestSelection::Public;
        assert!(approved_manifest(root.path(), &plan).is_err());
        plan.manifest_selection = ManifestSelection::Root;
        std::fs::write(
            root.path().join("plugin.json"),
            serde_json::json!({"name":"fixture","version":"1.0.0","main":"index.html","features":[{"code":"changed"}]}).to_string(),
        ).unwrap();
        assert!(approved_manifest(root.path(), &plan).is_err());
    }

    #[test]
    fn output_cannot_change_runtime_or_ordered_feature_identity() {
        let (root, plan) = fixture("fixture");
        let approved = approved_manifest(root.path(), &plan).unwrap();
        for changed in [
            serde_json::json!({"kind":"node","transport":"json_rpc_stdio"}),
            serde_json::json!({"kind":"web","transport":"host_bridge"}),
        ] {
            let mut output = approved.raw.clone();
            if changed.get("kind").and_then(Value::as_str) == Some("node") {
                output["runtime"] = changed.clone();
            } else {
                output["features"][0]["code"] = serde_json::json!("different");
            }
            std::fs::write(
                root.path().join("plugin.json"),
                serde_json::to_vec(&output).unwrap(),
            )
            .unwrap();
            let result = resolve_plugin_package(root.path()).unwrap();
            assert_eq!(result.readiness, PackageReadiness::Ready);
            assert!(validate(root.path(), &plan, &approved).is_err());
            std::fs::write(
                root.path().join("plugin.json"),
                serde_json::to_vec(&approved.raw).unwrap(),
            )
            .unwrap();
        }
    }

    #[test]
    fn root_manifest_entry_projection_keeps_existing_package_path_rules() {
        let (source, mut plan) = fixture("fixture");
        let mut source_raw: Value =
            serde_json::from_slice(&std::fs::read(source.path().join("plugin.json")).unwrap())
                .unwrap();
        source_raw["main"] = serde_json::json!("dist/index.html");
        std::fs::create_dir_all(source.path().join("dist")).unwrap();
        std::fs::write(source.path().join("dist/index.html"), "<main>source</main>").unwrap();
        let source_bytes = serde_json::to_vec(&source_raw).unwrap();
        std::fs::write(source.path().join("plugin.json"), &source_bytes).unwrap();
        let source_manifest: PluginManifest = serde_json::from_slice(&source_bytes).unwrap();
        plan.manifest_sha256 = format!("{:x}", Sha256::digest(&source_bytes));
        plan.manifest_identity = ManifestIdentity::from_plugin_manifest(&source_manifest).unwrap();
        let approved = approved_manifest(source.path(), &plan).unwrap();

        let output = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        std::fs::write(output.path().join("index.html"), "<main>built</main>").unwrap();
        std::fs::write(
            output.path().join("plugin.json"),
            serde_json::json!({"name":"fixture","version":"1.0.0","main":"index.html","features":[{"code":"open","explain":"Open","cmds":["fixture"]}]}).to_string(),
        ).unwrap();
        validate(output.path(), &plan, &approved).unwrap();
    }
}
