use std::path::PathBuf;

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DependencyKind {
    Builtin,
    ElectronShim,
    LocalPreload,
    ExternalNodeModule,
    NativeAddon,
    DynamicUnknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DependencyStatus {
    Resolved,
    Missing,
    Unknown,
    HostProvided,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RuntimeDependencyFinding {
    pub specifier: String,
    pub source_path: PathBuf,
    pub resolved_path: Option<PathBuf>,
    pub kind: DependencyKind,
    pub status: DependencyStatus,
    pub reason_code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RuntimeDependencyBudget {
    pub files_read: usize,
    pub bytes_read: usize,
    pub edges_seen: usize,
    pub max_depth_reached: usize,
    pub resolver_probes: usize,
    pub file_limit: usize,
    pub byte_limit: usize,
    pub edge_limit: usize,
    pub depth_limit: usize,
    pub probe_limit: usize,
    pub ancestor_depth_limit: usize,
    pub path_limit: usize,
    pub per_file_byte_limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RuntimeDependencyReport {
    pub selected_preload: Option<PathBuf>,
    pub findings: Vec<RuntimeDependencyFinding>,
    pub budget: RuntimeDependencyBudget,
    /// True only when the bounded supported-syntax graph walk ended without uncertainty.
    pub complete: bool,
    /// Static inspection never starts Node or loads plugin code.
    pub runtime_verified: bool,
}
