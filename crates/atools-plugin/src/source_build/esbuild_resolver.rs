//! Resolves the esbuild executable that the installed Vite package will load.
//!
//! Resolution is metadata-only. For the reviewed Vite 6 layout, it checks
//! Node's nearest `node_modules` search from `dist/node` and `dist/node/chunks`
//! (when present), plus esbuild's `lib` directory. Arbitrary importer layouts
//! are not claimed; disagreement between Vite importer locations fails closed.
//! Every selected package, lock entry, and executable stays within the reviewed
//! dependency root.
use std::path::{Component, Path, PathBuf};

use semver::Version;
use serde_json::Value;

use super::metadata::{canonical_directory, canonical_regular_file, read_json};
use super::policy::string;
use super::toolchain::npm_spec_matches;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ResolveError {
    Missing,
    LockMismatch,
    /// Safe in-root importer directories selected different validated packages.
    AmbiguousImporters,
    Unsafe,
}

const MAX_SEARCH_CANDIDATES: usize = 24;

pub(super) fn resolve_vite_esbuild(
    root: &Path,
    dependency_root: &Path,
    vite_cli: &Path,
    package: &Value,
    lock: &Value,
) -> Result<PathBuf, ResolveError> {
    let dependency_relative = dependency_root
        .strip_prefix(root)
        .map_err(|_| ResolveError::Unsafe)?;
    if dependency_relative != Path::new("node_modules") {
        return Err(ResolveError::Unsafe);
    }

    let vite_relative = PathBuf::from("node_modules/vite");
    let vite_directory = canonical_directory(root, &vite_relative)
        .map_err(|_| ResolveError::Unsafe)?
        .ok_or(ResolveError::Missing)?;
    if !vite_directory.starts_with(dependency_root) {
        return Err(ResolveError::Unsafe);
    }
    let vite_cli_relative = vite_cli
        .strip_prefix(root)
        .map_err(|_| ResolveError::Unsafe)?;
    let vite_cli = canonical_regular_file(root, vite_cli_relative)
        .map_err(|_| ResolveError::Unsafe)?
        .ok_or(ResolveError::Missing)?;
    if !vite_cli.starts_with(&vite_directory) {
        return Err(ResolveError::Unsafe);
    }
    let vite_package = read_json(root, &vite_relative.join("package.json"))
        .map_err(|_| ResolveError::Unsafe)?
        .ok_or(ResolveError::Missing)?;
    if string(&vite_package, "name") != Some("vite") {
        return Err(ResolveError::LockMismatch);
    }
    let vite_version = string(&vite_package, "version").ok_or(ResolveError::LockMismatch)?;
    let locked_vite = lock_entry(lock, &vite_relative)?;
    verify_installed_version(
        "vite",
        vite_version,
        locked_vite,
        &direct_project_spec(package, "vite").ok_or(ResolveError::LockMismatch)?,
    )?;

    let vite_esbuild_spec =
        dependency_spec(&vite_package, "esbuild").ok_or(ResolveError::Missing)?;
    if dependency_spec(locked_vite, "esbuild") != Some(vite_esbuild_spec) {
        return Err(ResolveError::LockMismatch);
    }

    let vite_importer = vite_relative.join("dist/node");
    let vite_importer_path = canonical_directory(root, &vite_importer)
        .map_err(|_| ResolveError::Unsafe)?
        .ok_or(ResolveError::Missing)?;
    if !vite_importer_path.starts_with(&vite_directory) {
        return Err(ResolveError::Unsafe);
    }
    // Vite's supported runtime imports esbuild from both dist/node and its
    // dist/node/chunks/dep*.js modules. Check each observed importer directory;
    // if either layout would select a different package, fail closed instead
    // of approximating arbitrary Node resolution for unreviewed layouts.
    let mut vite_importers = vec![vite_importer.clone()];
    let chunks_relative = vite_importer.join("chunks");
    match canonical_directory(root, &chunks_relative) {
        Ok(Some(chunks_directory)) if chunks_directory.starts_with(&vite_directory) => {
            vite_importers.push(chunks_relative);
        }
        Ok(Some(_)) => return Err(ResolveError::Unsafe),
        Ok(None) => {}
        Err(()) => return Err(ResolveError::Unsafe),
    }
    resolve_esbuild_binary_for_importers(
        root,
        dependency_root,
        &vite_importers,
        package,
        lock,
        vite_esbuild_spec,
    )
}

/// Resolve and validate the esbuild package selected from every importer
/// directory used by a reviewed consumer. Safe disagreements are reported
/// separately from path violations so each caller can preserve its own policy.
/// Callers must supply the actual bare-import locations for that consumer.
pub(super) fn resolve_esbuild_binary_for_importers(
    root: &Path,
    dependency_root: &Path,
    importers: &[PathBuf],
    package: &Value,
    lock: &Value,
    declared_spec: &str,
) -> Result<PathBuf, ResolveError> {
    resolve_esbuild_binary_for_importers_mode(
        root,
        dependency_root,
        importers,
        package,
        lock,
        declared_spec,
        false,
    )
}

/// TSX's reviewed resolver validates every safe selected package before it
/// classifies differing importer results as an unsupported layout. Vite keeps
/// its historical fail-closed classification at the disagreement boundary.
pub(super) fn resolve_esbuild_binary_for_importers_checked(
    root: &Path,
    dependency_root: &Path,
    importers: &[PathBuf],
    package: &Value,
    lock: &Value,
    declared_spec: &str,
) -> Result<PathBuf, ResolveError> {
    resolve_esbuild_binary_for_importers_mode(
        root,
        dependency_root,
        importers,
        package,
        lock,
        declared_spec,
        true,
    )
}

fn resolve_esbuild_binary_for_importers_mode(
    root: &Path,
    dependency_root: &Path,
    importers: &[PathBuf],
    package: &Value,
    lock: &Value,
    declared_spec: &str,
    validate_before_ambiguity: bool,
) -> Result<PathBuf, ResolveError> {
    if importers.is_empty() || importers.len() > 8 {
        return Err(ResolveError::Unsafe);
    }

    let mut selected_packages = Vec::with_capacity(importers.len());
    for importer in importers {
        let selected =
            resolve_package_directory(root, dependency_root, importer, Path::new("esbuild"))?;
        if !selected_packages.contains(&selected) {
            selected_packages.push(selected);
        }
    }

    // Keep Vite's old fail-closed result for a safe disagreement. TSX opts in
    // to checking all candidates first so an actual lock/missing failure is
    // not mislabeled as an unreviewed layout.
    if selected_packages.len() > 1 && !validate_before_ambiguity {
        return Err(ResolveError::AmbiguousImporters);
    }
    let mut binaries = Vec::with_capacity(selected_packages.len());
    for selected in &selected_packages {
        binaries.push(validate_esbuild_package_binary(
            root,
            dependency_root,
            selected,
            package,
            lock,
            declared_spec,
        )?);
    }
    if binaries.len() != 1 {
        return Err(ResolveError::AmbiguousImporters);
    }
    binaries.into_iter().next().ok_or(ResolveError::Missing)
}

fn validate_esbuild_package_binary(
    root: &Path,
    dependency_root: &Path,
    esbuild_relative: &Path,
    package: &Value,
    lock: &Value,
    declared_spec: &str,
) -> Result<PathBuf, ResolveError> {
    let esbuild_package = read_json(root, &esbuild_relative.join("package.json"))
        .map_err(|_| ResolveError::Unsafe)?
        .ok_or(ResolveError::Missing)?;
    if string(&esbuild_package, "name") != Some("esbuild") {
        return Err(ResolveError::LockMismatch);
    }
    let esbuild_version = string(&esbuild_package, "version").ok_or(ResolveError::LockMismatch)?;
    let esbuild_lock = lock_entry(lock, esbuild_relative)?;
    verify_installed_version("esbuild", esbuild_version, esbuild_lock, declared_spec)?;
    if esbuild_relative == Path::new("node_modules/esbuild") {
        let project_declares_esbuild = package
            .get("dependencies")
            .and_then(|value| value.get("esbuild"))
            .is_some()
            || package
                .get("devDependencies")
                .and_then(|value| value.get("esbuild"))
                .is_some();
        if project_declares_esbuild {
            let root_lock = lock
                .get("packages")
                .and_then(|packages| packages.get(""))
                .ok_or(ResolveError::LockMismatch)?;
            let project_spec =
                direct_project_spec(package, "esbuild").ok_or(ResolveError::LockMismatch)?;
            if direct_project_spec(root_lock, "esbuild") != Some(project_spec)
                || !npm_spec_matches(project_spec, esbuild_version)
                    .map_err(|_| ResolveError::LockMismatch)?
            {
                return Err(ResolveError::LockMismatch);
            }
        }
    }

    let platform = host_platform().ok_or(ResolveError::Missing)?;
    let platform_package_name = format!("@esbuild/{platform}");
    let platform_spec =
        dependency_spec(&esbuild_package, &platform_package_name).ok_or(ResolveError::Missing)?;
    if dependency_spec(esbuild_lock, &platform_package_name) != Some(platform_spec) {
        return Err(ResolveError::LockMismatch);
    }
    let esbuild_importer = esbuild_relative.join("lib");
    let platform_relative = resolve_package_directory(
        root,
        dependency_root,
        &esbuild_importer,
        Path::new(&platform_package_name),
    )?;
    let platform_package = read_json(root, &platform_relative.join("package.json"))
        .map_err(|_| ResolveError::Unsafe)?
        .ok_or(ResolveError::Missing)?;
    if string(&platform_package, "name") != Some(platform_package_name.as_str()) {
        return Err(ResolveError::LockMismatch);
    }
    let platform_version =
        string(&platform_package, "version").ok_or(ResolveError::LockMismatch)?;
    let platform_lock = lock_entry(lock, &platform_relative)?;
    verify_installed_version(
        &platform_package_name,
        platform_version,
        platform_lock,
        platform_spec,
    )?;
    if Version::parse(platform_version).ok() != Version::parse(esbuild_version).ok() {
        return Err(ResolveError::LockMismatch);
    }

    let platform_binary = canonical_regular_file(
        root,
        &platform_relative.join("bin").join(binary_file_name()),
    )
    .map_err(|_| ResolveError::Unsafe)?
    .ok_or(ResolveError::Missing)?;
    if !platform_binary.starts_with(dependency_root) {
        return Err(ResolveError::Unsafe);
    }

    Ok(platform_binary)
}

pub(super) fn resolve_package_directory(
    root: &Path,
    dependency_root: &Path,
    importer: &Path,
    package: &Path,
) -> Result<PathBuf, ResolveError> {
    let mut cursor = importer.to_path_buf();
    let mut attempts = 0;
    loop {
        // Node does not search `node_modules/node_modules` while ascending
        // through the project root's node_modules directory.
        let skip_nested_node_modules =
            cursor.file_name() == Some(std::ffi::OsStr::new("node_modules"));
        let candidate = cursor.join("node_modules").join(package);
        if !skip_nested_node_modules && candidate.starts_with(Path::new("node_modules")) {
            attempts += 1;
            if attempts > MAX_SEARCH_CANDIDATES {
                return Err(ResolveError::Unsafe);
            }
            match canonical_directory(root, &candidate) {
                Ok(Some(canonical)) if canonical.starts_with(dependency_root) => {
                    return Ok(candidate);
                }
                Ok(Some(_)) => return Err(ResolveError::Unsafe),
                Ok(None) => {}
                Err(()) => return Err(ResolveError::Unsafe),
            }
        }
        if cursor.as_path() == Path::new("node_modules") {
            cursor.pop();
            continue;
        }
        if cursor.as_os_str().is_empty() {
            return Err(ResolveError::Missing);
        }
        if !cursor.pop() {
            return Err(ResolveError::Missing);
        }
        if cursor == Path::new(".") {
            cursor.clear();
        }
    }
}

pub(super) fn lock_entry<'a>(lock: &'a Value, relative: &Path) -> Result<&'a Value, ResolveError> {
    let key = lock_key(relative)?;
    lock.get("packages")
        .and_then(|packages| packages.get(key.as_str()))
        .ok_or(ResolveError::LockMismatch)
}

fn lock_key(relative: &Path) -> Result<String, ResolveError> {
    let mut parts = Vec::new();
    for component in relative.components() {
        let Component::Normal(value) = component else {
            return Err(ResolveError::Unsafe);
        };
        parts.push(value.to_str().ok_or(ResolveError::Unsafe)?);
    }
    if parts.is_empty() {
        return Err(ResolveError::Unsafe);
    }
    Ok(parts.join("/"))
}

pub(super) fn direct_project_spec<'a>(package: &'a Value, name: &str) -> Option<&'a str> {
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

pub(super) fn dependency_spec<'a>(package: &'a Value, name: &str) -> Option<&'a str> {
    package
        .get("dependencies")
        .and_then(|value| value.get(name))
        .or_else(|| {
            package
                .get("optionalDependencies")
                .and_then(|value| value.get(name))
        })
        .and_then(Value::as_str)
}

pub(super) fn verify_installed_version(
    name: &str,
    installed: &str,
    locked_package: &Value,
    declared: &str,
) -> Result<(), ResolveError> {
    if string(locked_package, "name").is_some_and(|lock_name| lock_name != name) {
        return Err(ResolveError::LockMismatch);
    }
    let locked = string(locked_package, "version").ok_or(ResolveError::LockMismatch)?;
    let installed_version = Version::parse(installed).map_err(|_| ResolveError::LockMismatch)?;
    let locked_version = Version::parse(locked).map_err(|_| ResolveError::LockMismatch)?;
    if installed_version != locked_version
        || !npm_spec_matches(declared, installed).map_err(|_| ResolveError::LockMismatch)?
    {
        return Err(ResolveError::LockMismatch);
    }
    Ok(())
}

fn host_platform() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("windows", "aarch64") => Some("win32-arm64"),
        ("windows", "x86_64") => Some("win32-x64"),
        _ => None,
    }
}

fn binary_file_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "esbuild.exe"
    } else {
        "esbuild"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npm_esbuild_requirement_rejects_mismatched_installed_version() {
        let lock = serde_json::json!({"version":"0.28.1"});
        assert_eq!(
            verify_installed_version("esbuild", "0.25.12", &lock, "^0.25.0"),
            Err(ResolveError::LockMismatch)
        );
    }

    #[test]
    fn npm_esbuild_requirement_uses_declared_exact_and_range_semantics() {
        assert!(npm_spec_matches("^0.25.0", "0.25.12").unwrap());
        assert!(!npm_spec_matches("^0.25.0", "0.26.0").unwrap());
        assert!(npm_spec_matches("0.25.12", "0.25.12").unwrap());
        assert!(!npm_spec_matches("0.25.12", "0.25.13").unwrap());
        assert!(npm_spec_matches("~0.25.10", "0.25.12").unwrap());
        assert!(!npm_spec_matches("~0.25.10", "0.26.0").unwrap());
    }
}
