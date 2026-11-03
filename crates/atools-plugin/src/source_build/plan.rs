use std::path::{Path, PathBuf};

use super::vite_backend::{resolve_vite_backend, ResolveBackendError, ViteBuildBackend};
use super::manifest_output::{plan_public_root_rewrite, ManifestOutputRewritePlan};
use super::manifest_selection::{self, ManifestIdentity, ManifestSelection};
use super::ready_package::inspect_ready_package;
use super::metadata::{canonical_directory, read_json};
use super::policy::{stable_installation_id, string, vite_declaration};
use super::script_plan::{compile_scripts, BuildStep};
use super::trusted_dependency_root::TrustedDependencyRoot;
use super::tsx_esbuild_resolver::{resolve_tsx_esbuild, TsxResolveError};
use super::walk::{find_native_sources, WalkError};
use super::{SourceBuildBlocker, SourceBuildInspection, SourceBuildStatus};
use crate::package_resolution::{resolve_plugin_package, PackageReadiness};

#[derive(Clone, Debug)]
pub struct SourceBuildPlan {
    pub source_root: PathBuf,
    pub manifest_relative: PathBuf,
    pub manifest_selection: ManifestSelection,
    pub manifest_sha256: String,
    pub manifest_identity: ManifestIdentity,
    pub plugin_id: String,
    pub version: String,
    pub dependency_root: PathBuf,
    pub vite_cli: PathBuf,
    pub vite_backend: ViteBuildBackend,
    /// Present only when the validated build plan includes a NodeTest step.
    pub test_esbuild_binary: Option<PathBuf>,
    /// Present only for a source-derived, bounded public-manifest output rewrite.
    pub manifest_output_rewrite: Option<ManifestOutputRewritePlan>,
    pub build_steps: Vec<BuildStep>,
}

pub fn prepare_source_build(root: &Path) -> Result<SourceBuildPlan, String> {
    prepare_source_build_with_manifest_selection(root, None)
}

pub fn prepare_source_build_with_manifest_selection(
    root: &Path,
    selection: Option<ManifestSelection>,
) -> Result<SourceBuildPlan, String> {
    inspect_plan(root, selection)?
        .take_plan()
        .ok_or_else(|| "Source project is not eligible for a local Vite build".to_owned())
}

pub(super) fn prepare_with_dependency_root(
    root: &Path,
    trusted_dependency_home: &Path,
    selection: Option<ManifestSelection>,
) -> Result<SourceBuildPlan, String> {
    inspect_plan_with_dependency_root(root, trusted_dependency_home, selection)?
        .take_plan()
        .ok_or_else(|| "Source project is not eligible for a local Vite build".to_owned())
}

pub(super) fn inspect_plan(root: &Path, selection: Option<ManifestSelection>) -> Result<SourceBuildInspection, String> {
    inspect_plan_inner(root, None, selection)
}

pub(super) fn inspect_plan_with_dependency_root(
    root: &Path,
    trusted_dependency_home: &Path,
    selection: Option<ManifestSelection>,
) -> Result<SourceBuildInspection, String> {
    inspect_plan_inner(root, Some(trusted_dependency_home), selection)
}

fn inspect_plan_inner(
    root: &Path,
    trusted_dependency_home: Option<&Path>,
    requested_selection: Option<ManifestSelection>,
) -> Result<SourceBuildInspection, String> {
    let source_root = match root.canonicalize() {
        Ok(path) if path.is_dir() => path,
        _ => return Err("Invalid source project directory".into()),
    };

    let manifest_scan = manifest_selection::scan(&source_root, requested_selection);
    let mut manifest_info = manifest_scan.info.clone();

    if let Ok(package) = resolve_plugin_package(&source_root) {
        if package.readiness == PackageReadiness::Ready {
            if let Some(inspection) = inspect_ready_package(
                &source_root,
                &package.manifest,
                requested_selection,
                manifest_scan.selected.as_ref(),
                &mut manifest_info,
            ) {
                return Ok(inspection);
            }
        }
    }

    let mut blockers = Vec::new();
    let mut manifest_output_rewrite = None;
    let Some(selected_manifest) = manifest_scan.selected else {
        push(&mut blockers, "manifest_missing", "A root or public plugin manifest is required");
        return Ok(blocked(None, None, blockers, manifest_info));
    };
    let manifest_relative = selected_manifest.relative_path.clone();
    let manifest_json = selected_manifest.raw.clone();
    let identity = if selected_manifest.valid { selected_manifest.parsed.clone() } else { None };
    if !selected_manifest.valid {
        if selected_manifest.invalid_plugin_id {
            push(
                &mut blockers,
                "plugin_id_invalid",
                "The plugin name cannot produce a stable installation ID",
            );
        } else {
            let code = selected_manifest.code.unwrap_or("manifest_invalid");
            let message = if code == "manifest_missing" {
                "The selected plugin manifest is missing"
            } else {
                "The selected plugin manifest is unsafe, oversized, or invalid"
            };
            push(&mut blockers, code, message);
        }
    }
    if manifest_json.is_some() && identity.is_none() {
        push(
            &mut blockers,
            "manifest_invalid",
            "The selected plugin manifest must declare a bounded valid identity",
        );
    }
    let plugin_id = identity
        .as_ref()
        .and_then(|manifest| stable_installation_id(&manifest.name));
    let version = identity.as_ref().map(|manifest| manifest.version.clone());
    if identity.is_some() && plugin_id.is_none() {
        push(
            &mut blockers,
            "plugin_id_invalid",
            "The plugin name cannot produce a stable installation ID",
        );
    }
    if let Some(manifest) = identity.as_ref() {
        if manifest.effective_runtime_kind() != atools_core::PluginRuntimeKind::Web {
            push(
                &mut blockers,
                "unsupported_runtime",
                "Only Web plugins can use the Vite source-build plan",
            );
        }
        if manifest
            .effective_runtime_entry()
            .is_some_and(crate::package_resolution::html::is_remote_entry)
        {
            push(
                &mut blockers,
                "remote_entry",
                "Remote plugin entry points cannot be built locally",
            );
        }
        let mut normalized = manifest.clone();
        let candidate_package_root = crate::package_resolution::normalize_candidate_manifest_paths(
            &source_root,
            &manifest_relative,
            &mut normalized,
        )
        .ok();
        let candidate_paths_are_safe = candidate_package_root.is_some();
        let preload_is_safe = normalized.preload.as_deref().is_none_or(|preload| {
            crate::package_resolution::normalize_package_asset_path(preload).is_ok()
        });
        let runtime_entry_is_safe = normalized
            .runtime
            .as_ref()
            .and_then(|runtime| runtime.entry.as_deref())
            .filter(|entry| !crate::package_resolution::html::is_remote_entry(entry))
            .is_none_or(|entry| {
                crate::package_resolution::normalize_package_asset_path(entry).is_ok()
            });
        if !candidate_paths_are_safe || !preload_is_safe || !runtime_entry_is_safe {
            push(
                &mut blockers,
                "entry_path_invalid",
                "Local plugin entry paths must stay inside the project package",
            );
        } else if manifest_relative == Path::new("public/plugin.json")
            && candidate_package_root.as_deref() == Some(source_root.as_path())
        {
            manifest_output_rewrite = manifest_json.as_ref().and_then(|raw| {
                plan_public_root_rewrite(&source_root, &manifest_relative, raw, &normalized)
            });
            if manifest_output_rewrite.is_none() {
                push(
                    &mut blockers,
                    "public_manifest_output_rewrite_required",
                    "This public manifest has no verified Vite output path mapping",
                );
            }
        }
    }
    if let Some(value) = &manifest_json {
        if let Some(entry) = string(value, "main") {
            if crate::package_resolution::html::is_remote_entry(entry) {
                push(
                    &mut blockers,
                    "remote_entry",
                    "Remote plugin entry points cannot be built locally",
                );
            }
        }
        if let Some(entry) = string(value, "preload") {
            if crate::package_resolution::html::is_remote_entry(entry) {
                push(
                    &mut blockers,
                    "remote_entry",
                    "Remote plugin entry points cannot be built locally",
                );
            }
        }
    }

    let package = read_json(&source_root, Path::new("package.json"));
    let package = match package {
        Ok(Some(value)) => Some(value),
        Ok(None) | Err(()) => {
            push(
                &mut blockers,
                "package_missing",
                "A bounded, valid project package.json is required",
            );
            None
        }
    };
    let lock = match read_json(&source_root, Path::new("package-lock.json")) {
        Ok(Some(value)) => Some(value),
        Ok(None) | Err(()) => {
            push(
                &mut blockers,
                "lock_missing",
                "An owned, bounded package-lock.json is required",
            );
            None
        }
    };
    let dependency_home = match trusted_dependency_home {
        Some(path) => match TrustedDependencyRoot::from_host(&source_root, path) {
            Ok(value) => Some(value.home),
            Err(code) => {
                push(
                    &mut blockers,
                    code,
                    "The selected dependency set is not a safe owned directory",
                );
                None
            }
        },
        None => Some(source_root.clone()),
    };
    let dependencies = match dependency_home.as_ref() {
        Some(home) => match canonical_directory(home, Path::new("node_modules")) {
            Ok(Some(path)) => Some(path),
            Ok(None) | Err(()) => {
                push(
                    &mut blockers,
                    "dependencies_missing",
                    "A regular, verified node_modules directory is required",
                );
                None
            }
        },
        None => None,
    };

    let Some(package_value) = package.as_ref() else {
        return Ok(blocked(plugin_id, version, blockers, manifest_info));
    };
    let declaration = vite_declaration(package_value);
    if declaration.is_none() {
        push(
            &mut blockers,
            "vite_missing",
            "The project must declare one unambiguous Vite dependency",
        );
    }

    let mut compiled = None;
    if let (Some(lock_value), Some(dependencies_root)) = (lock.as_ref(), dependencies.as_ref()) {
        match compile_scripts(&source_root, package_value, lock_value, dependencies_root) {
            Ok(value) => compiled = Some(value),
            Err(error) => push(&mut blockers, error.code(), error.message()),
        }
    }
    let vite_cli = compiled.as_ref().map(|value| value.vite_cli.clone());
    let mut vite_backend = None;
    let mut test_esbuild_binary = None;
    if let (Some(dependencies_root), Some(vite_cli)) = (dependencies.as_ref(), vite_cli.as_ref()) {
        match resolve_vite_backend(
            dependency_home.as_ref().expect("validated dependency home"),
            dependencies_root,
            vite_cli,
            package_value,
            lock.as_ref().expect("lock was required above"),
        ) {
            Ok(backend) => vite_backend = Some(backend),
            Err(ResolveBackendError::Missing) => push(
                &mut blockers,
                "build_backend_missing",
                "Vite's locked build backend and its target package must be present inside the project",
            ),
            Err(ResolveBackendError::EsbuildMissing) => push(
                &mut blockers,
                "esbuild_missing",
                "Vite's installed platform esbuild package must be present inside the project",
            ),
            Err(ResolveBackendError::LockMismatch) => push(
                &mut blockers,
                "build_lock_mismatch",
                "Vite's installed build backend packages must match the package lock",
            ),
            Err(ResolveBackendError::Unsafe) => push(
                &mut blockers,
                "build_toolchain_invalid",
                "Vite's build backend must resolve to safe files inside the project",
            ),
            Err(ResolveBackendError::Ambiguous) => push(
                &mut blockers,
                "build_backend_ambiguous",
                "Vite must select exactly one supported build backend",
            ),
        }
    }

    let has_node_tests = compiled.as_ref().is_some_and(|compiled| {
        compiled
            .steps
            .iter()
            .any(|step| matches!(step, BuildStep::NodeTest { .. }))
    });
    if has_node_tests {
        if let (Some(dependencies_root), Some(lock_value)) = (dependencies.as_ref(), lock.as_ref())
        {
            match resolve_tsx_esbuild(
                dependency_home.as_ref().expect("validated dependency home"),
                dependencies_root,
                package_value,
                lock_value,
            ) {
                Ok(path) => test_esbuild_binary = Some(path),
                Err(TsxResolveError::Missing) => push(
                    &mut blockers,
                    "esbuild_missing",
                    concat!(
                        "The Node test runtime's platform esbuild package must be present ",
                        "inside the project"
                    ),
                ),
                Err(TsxResolveError::LockMismatch) => push(
                    &mut blockers,
                    "build_lock_mismatch",
                    "The Node test runtime's esbuild packages must match the package lock",
                ),
                Err(TsxResolveError::Unsupported) => push(
                    &mut blockers,
                    "build_toolchain_unsupported",
                    concat!(
                        "Only the reviewed TSX 4.23.1 layout is supported. Use a locally available, ",
                        "supported toolchain with a matching lockfile, re-inspect, or import an already-built package",
                    ),
                ),
                Err(TsxResolveError::Unsafe) => push(
                    &mut blockers,
                    "build_toolchain_invalid",
                    "The Node test runtime's esbuild packages must resolve to safe project files",
                ),
            }
        }
    }

    match find_native_sources(&source_root) {
        Ok(true) => push(
            &mut blockers,
            "native_addon",
            "Project source contains a native addon or .node file",
        ),
        Ok(false) => {}
        Err(WalkError::BoundsExceeded) => push(
            &mut blockers,
            "source_scan_bounded",
            "Project source metadata exceeds the safe inspection bounds",
        ),
        Err(WalkError::UnsafePathOrSwap) => push(
            &mut blockers,
            "source_scan_unsafe",
            "Project source metadata changed during confined inspection or contains a symlink",
        ),
        Err(WalkError::ReadFailed) => push(
            &mut blockers,
            "source_scan_error",
            "Project source metadata could not be read safely",
        ),
        Err(WalkError::UnsupportedPlatform) => push(
            &mut blockers,
            "source_scan_unsupported",
            "Race-resistant source inspection is unavailable on this platform",
        ),
    }

    if !blockers.is_empty() {
        return Ok(blocked(plugin_id, version, blockers, manifest_info));
    }
    let manifest = identity.expect("identity is required for an eligible source");
    let stable_id = stable_installation_id(&manifest.name).expect("stable ID was validated");
    let selected_sha256 = selected_manifest.sha256.clone().expect("eligible manifest has a hash");
    let selected_identity = selected_manifest.identity.clone().expect("eligible manifest has an identity");
    Ok(SourceBuildInspection::from_parts_with_manifest(
        SourceBuildStatus::Eligible,
        Some(stable_id.clone()),
        Some(manifest.version.clone()),
        Vec::new(),
        Some(SourceBuildPlan {
            source_root: source_root.clone(),
            manifest_relative,
            manifest_selection: selected_manifest.selection,
            manifest_sha256: selected_sha256,
            manifest_identity: selected_identity,
            plugin_id: stable_id,
            version: manifest.version,
            dependency_root: dependencies.expect("dependencies were validated"),
            vite_cli: vite_cli.expect("Vite CLI was validated"),
            vite_backend: vite_backend.expect("Vite build backend was validated"),
            test_esbuild_binary,
            manifest_output_rewrite,
            build_steps: compiled.expect("build steps were validated").steps,
        }),
        manifest_info,
    ))
}

fn push(blockers: &mut Vec<SourceBuildBlocker>, code: &'static str, message: &'static str) {
    if blockers.len() < 8 && !blockers.iter().any(|blocker| blocker.code == code) {
        blockers.push(SourceBuildBlocker::fixed(code, message));
    }
}

fn blocked(
    plugin_id: Option<String>,
    version: Option<String>,
    blockers: Vec<SourceBuildBlocker>,
    manifest_info: super::manifest_selection::ManifestSelectionInfo,
) -> SourceBuildInspection {
    SourceBuildInspection::from_parts_with_manifest(
        SourceBuildStatus::Blocked, plugin_id, version, blockers, None, manifest_info,
    )
}
