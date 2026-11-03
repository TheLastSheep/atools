//! Bounded metadata planning for a local, already-installed source build pipeline.
//!
//! This module never runs scripts, resolves packages from the network, or treats
//! source readiness as runtime readiness. A plan is only an input contract for a
//! separate, permission-gated process executor.

mod esbuild_resolver;
mod locked_dependency;
mod locked_dependency_integrity;
#[cfg(test)]
mod locked_dependency_tests;
mod manifest_output;
#[cfg(test)]
mod manifest_output_tests;
mod manifest_selection;
mod metadata;
mod plan;
mod policy;
mod ready_package;
mod script_plan;
#[cfg(test)]
mod tests;
mod toolchain;
mod trusted_dependency_root;
#[cfg(test)]
mod trusted_dependency_root_tests;
mod tsx_esbuild_resolver;
#[cfg(test)]
mod tsx_esbuild_tests;
#[cfg(test)]
mod tsx_plan_integration_tests;
mod vite_backend;
mod walk;

use std::path::{Path, PathBuf};

use serde::Serialize;

pub use locked_dependency::{
    build_locked_dependency_plan, current_build_target, dependency_set_id_sha256,
    verify_archive_integrity, verify_dependency_receipt, verify_plan_checksum, BuildTargetV1,
    DependencySetReceiptV1, LockedDependencyError, LockedDependencyPlanV1, LockedPackageV1,
    OwnedDependencyRootHandle, PackageIntegrityV1, SkippedOptionalPackageV1, MAX_PLAN_JSON_BYTES,
};
pub use manifest_output::{
    ManifestOutputRewritePlan, ManifestPathField, ManifestPathRewrite, PublicAssetPin,
};
pub use manifest_selection::{ManifestIdentity, ManifestSelection, ManifestSelectionInfo};
use plan::inspect_plan;
pub use plan::{
    prepare_source_build, prepare_source_build_with_manifest_selection, SourceBuildPlan,
};
pub use vite_backend::ViteBuildBackend;
pub use script_plan::BuildStep;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BuildStepSummary {
    Typecheck,
    NodeTests { files: usize },
    ViteBuild,
    PackageScript,
}

pub fn summarize_build_steps(steps: &[BuildStep]) -> Vec<BuildStepSummary> {
    steps
        .iter()
        .map(|step| match step {
            BuildStep::Typecheck { .. } => BuildStepSummary::Typecheck,
            BuildStep::NodeTest { files } => BuildStepSummary::NodeTests { files: files.len() },
            BuildStep::ViteBuild { .. } => BuildStepSummary::ViteBuild,
            BuildStep::NodeScript { .. } => BuildStepSummary::PackageScript,
        })
        .collect()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceBuildBlocker {
    pub code: String,
    pub message: String,
}

/// UI-safe inspection. The private plan is deliberately omitted from JSON: it
/// contains filesystem paths and must be requested separately by the host.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceBuildInspection {
    #[serde(flatten)]
    pub manifest_selection: ManifestSelectionInfo,
    pub status: SourceBuildStatus,
    pub plugin_id: Option<String>,
    pub version: Option<String>,
    pub blockers: Vec<SourceBuildBlocker>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build_steps: Option<Vec<BuildStepSummary>>,
    #[serde(skip)]
    plan: Option<SourceBuildPlan>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceBuildStatus {
    Eligible,
    AlreadyReady,
    Blocked,
}

/// Inspect a project using bounded, no-follow metadata reads only.
pub fn inspect_source_build(root: &Path) -> Result<SourceBuildInspection, String> {
    inspect_plan(root, None)
}

/// Inspect with an explicit root/public manifest choice. A missing or invalid explicit
/// choice is reported as blocked; it never falls back to the other candidate.
pub fn inspect_source_build_with_manifest_selection(
    root: &Path,
    selection: Option<ManifestSelection>,
) -> Result<SourceBuildInspection, String> {
    inspect_plan(root, selection)
}

/// Inspect a source package against an already-materialized, host-owned
/// dependency home containing `node_modules/`. This path is for the trusted
/// desktop host only; never expose its path through plugin or MCP arguments.
#[doc(hidden)]
pub fn inspect_source_build_with_dependency_root(
    root: &Path,
    trusted_dependency_home: &Path,
) -> Result<SourceBuildInspection, String> {
    plan::inspect_plan_with_dependency_root(root, trusted_dependency_home, None)
}

#[doc(hidden)]
pub fn inspect_source_build_with_dependency_root_and_manifest_selection(
    root: &Path,
    trusted_dependency_home: &Path,
    selection: Option<ManifestSelection>,
) -> Result<SourceBuildInspection, String> {
    plan::inspect_plan_with_dependency_root(root, trusted_dependency_home, selection)
}

/// Prepare a build plan against the same host-owned dependency set used by the
/// inspection that authorized it. The host must bind both calls to one receipt.
#[doc(hidden)]
pub fn prepare_source_build_with_dependency_root(
    root: &Path,
    trusted_dependency_home: &Path,
) -> Result<SourceBuildPlan, String> {
    plan::prepare_with_dependency_root(root, trusted_dependency_home, None)
}

#[doc(hidden)]
pub fn prepare_source_build_with_dependency_root_and_manifest_selection(
    root: &Path,
    trusted_dependency_home: &Path,
    selection: Option<ManifestSelection>,
) -> Result<SourceBuildPlan, String> {
    plan::prepare_with_dependency_root(root, trusted_dependency_home, selection)
}

/// Resolve the host's existing Node.js binary without launching it. Callers use
/// this only after explicit build authorization, never during source inspection.
pub fn resolve_build_node() -> Result<PathBuf, String> {
    crate::sidecar::resolve_node_binary().map_err(|error| error.to_string())
}

/// Resolve the installed platform binary used by the selected Vite package.
///
/// This metadata-only helper is shared with the host's explicit native build
/// tests so they exercise the same nested package resolution as inspection.
#[doc(hidden)]
pub fn resolve_build_esbuild_binary(
    source_root: &Path,
    dependency_root: &Path,
    vite_cli: &Path,
) -> Result<PathBuf, String> {
    let root = source_root
        .canonicalize()
        .map_err(|_| "Unable to resolve the local build toolchain".to_owned())?;
    let dependency_home = dependency_root
        .parent()
        .ok_or_else(|| "Unable to resolve the local build toolchain".to_owned())?;
    let dependencies = metadata::canonical_directory(dependency_home, Path::new("node_modules"))
        .map_err(|_| "Unable to resolve the local build toolchain".to_owned())?
        .ok_or_else(|| "Unable to resolve the local build toolchain".to_owned())?;
    let requested = dependency_root
        .canonicalize()
        .map_err(|_| "Unable to resolve the local build toolchain".to_owned())?;
    if dependencies != requested {
        return Err("Unable to resolve the local build toolchain".to_owned());
    }
    let package = metadata::read_json(&root, Path::new("package.json"))
        .map_err(|_| "Unable to resolve the local build toolchain".to_owned())?
        .ok_or_else(|| "Unable to resolve the local build toolchain".to_owned())?;
    let lock = metadata::read_json(&root, Path::new("package-lock.json"))
        .map_err(|_| "Unable to resolve the local build toolchain".to_owned())?
        .ok_or_else(|| "Unable to resolve the local build toolchain".to_owned())?;
    esbuild_resolver::resolve_vite_esbuild(
        dependency_home,
        &dependencies,
        vite_cli,
        &package,
        &lock,
    )
    .map_err(|_| "Unable to resolve the local build toolchain".to_owned())
}

impl SourceBuildInspection {
    pub(crate) fn from_parts(
        status: SourceBuildStatus,
        plugin_id: Option<String>,
        version: Option<String>,
        blockers: Vec<SourceBuildBlocker>,
        plan: Option<SourceBuildPlan>,
    ) -> Self {
        Self::from_parts_with_manifest(
            status, plugin_id, version, blockers, plan,
            manifest_selection::ManifestSelectionInfo::empty(),
        )
    }

    pub(crate) fn from_parts_with_manifest(
        status: SourceBuildStatus,
        plugin_id: Option<String>,
        version: Option<String>,
        blockers: Vec<SourceBuildBlocker>,
        plan: Option<SourceBuildPlan>,
        manifest_selection: ManifestSelectionInfo,
    ) -> Self {
        let build_steps = plan.as_ref().map(|plan| summarize_build_steps(&plan.build_steps));
        Self { manifest_selection, status, plugin_id, version, blockers, build_steps, plan }
    }

    pub(crate) fn take_plan(self) -> Option<SourceBuildPlan> {
        self.plan
    }
}

impl SourceBuildBlocker {
    pub(crate) fn fixed(code: &'static str, message: &'static str) -> Self {
        Self {
            code: code.to_owned(),
            message: message.to_owned(),
        }
    }
}
