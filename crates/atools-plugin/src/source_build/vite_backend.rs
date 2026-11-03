//! The locked Vite package chooses one backend: esbuild or a platform Rolldown binding.
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::esbuild_resolver::{
    dependency_spec, direct_project_spec, lock_entry, resolve_package_directory,
    resolve_vite_esbuild, verify_installed_version, ResolveError,
};
use super::locked_dependency::{current_build_target, BuildTargetV1};
use super::metadata::{canonical_regular_file, read_json};
use super::policy::string;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ViteBuildBackend {
    Esbuild { binary: PathBuf },
    Rolldown { binding: PathBuf },
}

impl ViteBuildBackend {
    pub fn path(&self) -> &Path {
        match self {
            Self::Esbuild { binary } => binary,
            Self::Rolldown { binding } => binding,
        }
    }

    pub fn is_esbuild(&self) -> bool {
        matches!(self, Self::Esbuild { .. })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ResolveBackendError {
    Missing,
    EsbuildMissing,
    LockMismatch,
    Unsafe,
    Ambiguous,
}

pub(super) fn resolve_vite_backend(
    root: &Path,
    dependency_root: &Path,
    vite_cli: &Path,
    project: &Value,
    lock: &Value,
) -> Result<ViteBuildBackend, ResolveBackendError> {
    let target = current_build_target().map_err(|_| ResolveBackendError::Missing)?;
    resolve_vite_backend_for_target(root, dependency_root, vite_cli, project, lock, &target)
}

fn resolve_vite_backend_for_target(
    root: &Path,
    dependency_root: &Path,
    vite_cli: &Path,
    project: &Value,
    lock: &Value,
    target: &BuildTargetV1,
) -> Result<ViteBuildBackend, ResolveBackendError> {
    let vite = read_json(root, Path::new("node_modules/vite/package.json"))
        .map_err(|_| ResolveBackendError::Unsafe)?
        .ok_or(ResolveBackendError::Missing)?;
    if string(&vite, "name") != Some("vite") {
        return Err(ResolveBackendError::LockMismatch);
    }
    let vite_lock = lock_entry(lock, Path::new("node_modules/vite")).map_err(map_esbuild_error)?;
    let vite_version = string(&vite, "version").ok_or(ResolveBackendError::LockMismatch)?;
    verify_installed_version(
        "vite",
        vite_version,
        vite_lock,
        direct_project_spec(project, "vite").ok_or(ResolveBackendError::LockMismatch)?,
    )
    .map_err(map_esbuild_error)?;

    let installed_roles = backend_dependency_roles(&vite)?;
    let locked_roles = backend_dependency_roles(vite_lock)?;
    if installed_roles != locked_roles {
        return Err(ResolveBackendError::LockMismatch);
    }
    match installed_roles {
        (Some(_), Some(_)) => Err(ResolveBackendError::Ambiguous),
        (Some(_), None) => resolve_vite_esbuild(root, dependency_root, vite_cli, project, lock)
            .map(|binary| ViteBuildBackend::Esbuild { binary })
            .map_err(map_esbuild_backend_error),
        (None, Some(spec)) => resolve_rolldown(root, dependency_root, project, lock, &vite, spec, target)
            .map(|binding| ViteBuildBackend::Rolldown { binding }),
        (None, None) => Err(ResolveBackendError::Missing),
    }
}

fn resolve_rolldown(
    root: &Path,
    dependency_root: &Path,
    project: &Value,
    lock: &Value,
    vite: &Value,
    vite_spec: &str,
    target: &BuildTargetV1,
) -> Result<PathBuf, ResolveBackendError> {
    let project_vite = direct_project_spec(project, "vite").ok_or(ResolveBackendError::LockMismatch)?;
    let vite_lock = lock_entry(lock, Path::new("node_modules/vite")).map_err(map_esbuild_error)?;
    let vite_version = string(vite, "version").ok_or(ResolveBackendError::LockMismatch)?;
    verify_installed_version("vite", vite_version, vite_lock, project_vite).map_err(map_esbuild_error)?;
    if dependency_spec(vite_lock, "rolldown") != Some(vite_spec) {
        return Err(ResolveBackendError::LockMismatch);
    }

    let rolldown_relative = resolve_package_directory(
        root,
        dependency_root,
        Path::new("node_modules/vite/dist/node"),
        Path::new("rolldown"),
    )
    .map_err(map_esbuild_error)?;
    let rolldown = read_json(root, &rolldown_relative.join("package.json"))
        .map_err(|_| ResolveBackendError::Unsafe)?
        .ok_or(ResolveBackendError::Missing)?;
    if string(&rolldown, "name") != Some("rolldown") {
        return Err(ResolveBackendError::LockMismatch);
    }
    let rolldown_version = string(&rolldown, "version").ok_or(ResolveBackendError::LockMismatch)?;
    let rolldown_lock = lock_entry(lock, &rolldown_relative).map_err(map_esbuild_error)?;
    verify_installed_version("rolldown", rolldown_version, rolldown_lock, vite_spec)
        .map_err(map_esbuild_error)?;

    let binding_name = format!("@rolldown/binding-{}-{}", target.os, target.cpu);
    let binding_spec = optional_dependency(&rolldown, &binding_name)?
        .ok_or(ResolveBackendError::Missing)?;
    if optional_dependency(rolldown_lock, &binding_name)? != Some(binding_spec) {
        return Err(ResolveBackendError::LockMismatch);
    }
    let binding_relative = resolve_package_directory(
        root,
        dependency_root,
        &rolldown_relative.join("dist"),
        Path::new(&binding_name),
    )
    .map_err(map_esbuild_error)?;
    let binding = read_json(root, &binding_relative.join("package.json"))
        .map_err(|_| ResolveBackendError::Unsafe)?
        .ok_or(ResolveBackendError::Missing)?;
    if string(&binding, "name") != Some(binding_name.as_str()) {
        return Err(ResolveBackendError::LockMismatch);
    }
    let binding_version = string(&binding, "version").ok_or(ResolveBackendError::LockMismatch)?;
    let binding_lock = lock_entry(lock, &binding_relative).map_err(map_esbuild_error)?;
    verify_installed_version(&binding_name, binding_version, binding_lock, binding_spec)
        .map_err(map_esbuild_error)?;
    validate_platform(&binding, &target)?;
    validate_platform(binding_lock, &target)?;
    if binding_lock.get("optional").and_then(Value::as_bool) != Some(true)
        || binding.get("exports").is_some_and(|exports| !exports.is_null())
    {
        return Err(ResolveBackendError::LockMismatch);
    }
    let main = string(&binding, "main").ok_or(ResolveBackendError::LockMismatch)?;
    let main_path = Path::new(main);
    if main_path.components().count() != 1
        || main_path.components().any(|part| !matches!(part, std::path::Component::Normal(_)))
        || !main.ends_with(".node")
        || main.chars().any(char::is_control)
    {
        return Err(ResolveBackendError::LockMismatch);
    }
    let native_binding = canonical_regular_file(root, &binding_relative.join(main_path))
        .map_err(|_| ResolveBackendError::Unsafe)?
        .ok_or(ResolveBackendError::Missing)?;
    if !native_binding.starts_with(dependency_root) {
        return Err(ResolveBackendError::Unsafe);
    }
    Ok(native_binding)
}

fn backend_dependency_roles<'a>(
    package: &'a Value,
) -> Result<(Option<&'a str>, Option<&'a str>), ResolveBackendError> {
    let dependencies = dependency_map(package, "dependencies")?;
    let optional = dependency_map(package, "optionalDependencies")?;
    for name in ["esbuild", "rolldown"] {
        if optional.is_some_and(|items| items.contains_key(name)) {
            return Err(ResolveBackendError::LockMismatch);
        }
    }
    Ok((
        declared_dependency(dependencies, "esbuild")?,
        declared_dependency(dependencies, "rolldown")?,
    ))
}

fn dependency_map<'a>(
    package: &'a Value,
    field: &str,
) -> Result<Option<&'a serde_json::Map<String, Value>>, ResolveBackendError> {
    match package.get(field) {
        None => Ok(None),
        Some(value) => value
            .as_object()
            .map(Some)
            .ok_or(ResolveBackendError::LockMismatch),
    }
}

fn declared_dependency<'a>(
    dependencies: Option<&'a serde_json::Map<String, Value>>,
    name: &str,
) -> Result<Option<&'a str>, ResolveBackendError> {
    match dependencies.and_then(|items| items.get(name)) {
        None => Ok(None),
        Some(Value::String(spec)) if !spec.trim().is_empty() => Ok(Some(spec)),
        Some(_) => Err(ResolveBackendError::LockMismatch),
    }
}

fn optional_dependency<'a>(
    package: &'a Value,
    name: &str,
) -> Result<Option<&'a str>, ResolveBackendError> {
    let dependencies = dependency_map(package, "dependencies")?;
    let optional = dependency_map(package, "optionalDependencies")?;
    if dependencies.is_some_and(|items| items.contains_key(name)) {
        return Err(ResolveBackendError::LockMismatch);
    }
    declared_dependency(optional, name)
}

fn validate_platform(package: &Value, target: &BuildTargetV1) -> Result<(), ResolveBackendError> {
    let exact = |key: &str, expected: &str| {
        package.get(key).and_then(Value::as_array).is_some_and(|values| {
            values.len() == 1 && values[0].as_str() == Some(expected)
        })
    };
    if exact("os", &target.os) && exact("cpu", &target.cpu) {
        Ok(())
    } else {
        Err(ResolveBackendError::LockMismatch)
    }
}

fn map_esbuild_backend_error(error: ResolveError) -> ResolveBackendError {
    match error {
        ResolveError::Missing => ResolveBackendError::EsbuildMissing,
        other => map_esbuild_error(other),
    }
}

fn map_esbuild_error(error: ResolveError) -> ResolveBackendError {
    match error {
        ResolveError::Missing => ResolveBackendError::Missing,
        ResolveError::LockMismatch => ResolveBackendError::LockMismatch,
        ResolveError::Unsafe => ResolveBackendError::Unsafe,
        ResolveError::AmbiguousImporters => ResolveBackendError::Unsafe,
    }
}

#[cfg(test)]
#[path = "vite_backend_tests.rs"]
mod tests;
