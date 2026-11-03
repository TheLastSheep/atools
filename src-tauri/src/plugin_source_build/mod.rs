//! Explicit source conversion: discovery is read-only; execution uses the shared tool pipeline.
pub(crate) mod api;
pub(crate) mod bootstrap;
pub(crate) mod converted_source_registry;
#[path = "../plugin_source_dependency_service/mod.rs"]
mod dependency_service;
pub(crate) mod failure;
mod inspection;
mod install_report;
mod manager;
mod process;
mod profile;
pub(crate) mod registry;
mod service;
mod staging;

pub(crate) use dependency_service::ConvertedPackageTree;
use dependency_service::{allows_conversion_fallback, prepared_for_conversion};
pub(crate) use dependency_service::{
    definitions as dependency_tool_definitions, execute as execute_dependency_tool,
    is_dependency_tool, is_mutating_tool as is_mutating_tool_name,
    is_tool as is_dependency_tool_name, request_cancel as request_dependency_cancel,
    state as dependency_state,
};
pub(crate) use failure::{RunnerFailure, SourceBuildFailure};
pub(crate) use service::{execute, inspect_tool, request_cancel};
pub(crate) fn calculate_converted_package_tree(
    path: &std::path::Path,
) -> Result<ConvertedPackageTree, String> {
    dependency_service::calculate_converted_package_tree(path)
}
pub(crate) fn read_converted_handoff(root: &std::path::Path) -> Result<Vec<u8>, String> {
    dependency_service::read_converted_handoff(root)
}
pub(crate) fn read_converted_source_evidence(root: &std::path::Path) -> Result<Vec<u8>, String> {
    dependency_service::read_converted_source_evidence(root)
}
pub(crate) fn read_converted_package_manifest(root: &std::path::Path) -> Result<Vec<u8>, String> {
    dependency_service::read_converted_package_manifest(root)
}
#[cfg(all(feature = "source-dependency-smoke", target_os = "macos"))]
pub(crate) use dependency_service::native_smoke::run as run_source_dependency_pipeline_smoke;

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;
