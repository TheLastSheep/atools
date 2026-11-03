//! Lock and installed-package checks for the fixed local build toolchain.
use std::path::{Path, PathBuf};

use semver::{Version, VersionReq};
use serde_json::Value;

use super::metadata::read_json;
#[path = "npm_bin_path.rs"]
mod npm_bin_path;
use super::policy::string;
use super::script_plan::ScriptPlanError;

#[cfg(test)]
pub(super) fn validate_tool(
    _root: &Path,
    package: &Value,
    lock: &Value,
    dependency_root: &Path,
    name: &str,
) -> Result<Option<PathBuf>, ScriptPlanError> {
    validate_tool_bin(package, lock, dependency_root, name, name)
}

pub(super) fn validate_tool_bin(
    package: &Value,
    lock: &Value,
    dependency_root: &Path,
    package_name: &str,
    bin_name: &str,
) -> Result<Option<PathBuf>, ScriptPlanError> {
    let declared = direct_spec(package, package_name).ok_or(ScriptPlanError::ToolchainInvalid)?;
    let lock_root = lock
        .get("packages")
        .and_then(|packages| packages.get(""))
        .ok_or(ScriptPlanError::LockMismatch)?;
    if direct_spec(lock_root, package_name) != Some(declared) {
        return Err(ScriptPlanError::LockMismatch);
    }
    let requirement = npm_requirement(declared)?;
    let lock_key = format!("node_modules/{package_name}");
    let lock_entry = lock
        .get("packages")
        .and_then(|packages| packages.get(lock_key.as_str()))
        .ok_or(ScriptPlanError::LockMismatch)?;
    let locked = string(lock_entry, "version").ok_or(ScriptPlanError::LockMismatch)?;
    let installed_path = PathBuf::from("node_modules")
        .join(package_name)
        .join("package.json");
    let dependency_home = dependency_root
        .parent()
        .ok_or(ScriptPlanError::ToolchainInvalid)?;
    let installed = read_json(dependency_home, &installed_path)
        .map_err(|_| ScriptPlanError::ToolchainInvalid)?
        .ok_or(ScriptPlanError::ToolchainInvalid)?;
    if matches!(package_name, "typescript" | "vue-tsc")
        && string(&installed, "name") != Some(package_name)
    {
        return Err(ScriptPlanError::ToolchainInvalid);
    }
    let installed_version =
        string(&installed, "version").ok_or(ScriptPlanError::ToolchainInvalid)?;
    let locked_version = Version::parse(locked).map_err(|_| ScriptPlanError::LockMismatch)?;
    let installed_version =
        Version::parse(installed_version).map_err(|_| ScriptPlanError::ToolchainInvalid)?;
    let declaration_matches = match requirement {
        NpmVersionSpec::Exact(version) => version == locked_version,
        NpmVersionSpec::Range(requirement) => requirement.matches(&locked_version),
    };
    if locked_version != installed_version || !declaration_matches {
        return Err(ScriptPlanError::LockMismatch);
    }
    if package_name == "tsx" {
        return Ok(None);
    }
    let bin = command_bin(&installed, package_name, bin_name)?;
    let canonical =
        npm_bin_path::resolve_package_bin(dependency_home, dependency_root, package_name, bin)
            .map_err(|_| ScriptPlanError::ToolchainInvalid)?;
    Ok(Some(canonical))
}

pub(super) enum NpmVersionSpec {
    Exact(Version),
    Range(VersionReq),
}

pub(super) fn npm_spec_matches(declared: &str, candidate: &str) -> Result<bool, ScriptPlanError> {
    let candidate = Version::parse(candidate).map_err(|_| ScriptPlanError::ToolchainInvalid)?;
    Ok(match npm_requirement(declared)? {
        NpmVersionSpec::Exact(version) => version == candidate,
        NpmVersionSpec::Range(requirement) => requirement.matches(&candidate),
    })
}

/// Support npm's common full-version, caret, and tilde forms without inheriting
/// Rust semver's caret default for an unadorned npm exact version. Other npm
/// range syntax is rejected until it has explicit compatibility tests.
fn npm_requirement(value: &str) -> Result<NpmVersionSpec, ScriptPlanError> {
    if let Some(version) = stable_full_version(value) {
        return Ok(NpmVersionSpec::Exact(version));
    }
    let version = value
        .strip_prefix('^')
        .or_else(|| value.strip_prefix('~'))
        .ok_or(ScriptPlanError::ToolchainInvalid)?;
    if stable_full_version(version).is_none() {
        return Err(ScriptPlanError::ToolchainInvalid);
    }
    VersionReq::parse(value)
        .map(NpmVersionSpec::Range)
        .map_err(|_| ScriptPlanError::ToolchainInvalid)
}

fn stable_full_version(value: &str) -> Option<Version> {
    let version = Version::parse(value).ok()?;
    if !version.pre.is_empty()
        || !version.build.is_empty()
        || format!("{}.{}.{}", version.major, version.minor, version.patch) != value
    {
        return None;
    }
    Some(version)
}

fn direct_spec<'a>(package: &'a Value, name: &str) -> Option<&'a str> {
    let runtime = package
        .get("dependencies")
        .and_then(|value| value.get(name))
        .and_then(Value::as_str);
    let development = package
        .get("devDependencies")
        .and_then(|value| value.get(name))
        .and_then(Value::as_str);
    match (runtime, development) {
        (Some(left), Some(right)) if left != right => None,
        (Some(value), _) | (_, Some(value)) => Some(value),
        _ => None,
    }
}
fn command_bin<'a>(
    package: &'a Value,
    package_name: &str,
    bin_name: &str,
) -> Result<&'a str, ScriptPlanError> {
    let value = package
        .get("bin")
        .ok_or(ScriptPlanError::ToolchainInvalid)?;
    let path = match value {
        Value::String(value) if package_name == bin_name => Some(value.as_str()),
        Value::Object(bins) => bins.get(bin_name).and_then(Value::as_str),
        _ => None,
    }
    .ok_or(ScriptPlanError::ToolchainInvalid)?;
    Ok(path)
}
