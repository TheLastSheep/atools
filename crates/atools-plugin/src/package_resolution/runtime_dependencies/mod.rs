//! Bounded, non-executing inspection of the selected CommonJS preload dependency graph.
mod builtins;
mod lexer;
mod model;
mod module_resolution;
mod resolver;
#[cfg(test)]
mod tests;

pub use model::{
    DependencyKind, DependencyStatus, RuntimeDependencyBudget, RuntimeDependencyFinding,
    RuntimeDependencyReport,
};

use crate::package_resolution::ResolvedPluginPackage;

/// Inspects only the selected package preload and its statically resolvable CommonJS graph.
/// Unknown syntax and unsafe reads are represented in the report rather than rejected here.
pub fn inspect_runtime_dependencies(package: &ResolvedPluginPackage) -> RuntimeDependencyReport {
    resolver::inspect(package)
}
