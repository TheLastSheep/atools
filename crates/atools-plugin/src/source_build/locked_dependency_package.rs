//! Package path, platform, and npm lock graph validation.
use super::locked_dependency_range;
use super::{
    BuildTargetV1, LockedDependencyError, LockedPackageV1, PackageIntegrityV1,
    SkippedOptionalPackageV1,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

const MAX_PATH_BYTES: usize = 1024;
const MAX_PATH_DEPTH: usize = 32;

pub(super) fn validate_direct_dependencies(
    package: &Value,
    lock: &Value,
) -> Result<(), LockedDependencyError> {
    let packages = lock
        .get("packages")
        .and_then(Value::as_object)
        .ok_or(LockedDependencyError::InvalidJson)?;
    let root = packages.get("").ok_or(LockedDependencyError::InvalidJson)?;
    let mut direct = BTreeMap::new();
    for section in ["dependencies", "devDependencies", "optionalDependencies"] {
        let project_specs = dependency_map(package.get(section))?;
        let lock_specs = dependency_map(root.get(section))?;
        if project_specs != lock_specs {
            return Err(LockedDependencyError::DirectDependencyMismatch);
        }
        for (name, spec) in project_specs {
            validate_package_name(&name)?;
            if direct.insert(name.clone(), spec.clone()).is_some() {
                return Err(LockedDependencyError::DirectDependencyMismatch);
            }
        }
    }
    for (name, spec) in direct {
        let package_path = format!("node_modules/{name}");
        validate_package_path(&package_path)?;
        let entry = packages
            .get(&package_path)
            .ok_or(LockedDependencyError::LockMismatch)?;
        let version = entry
            .get("version")
            .and_then(Value::as_str)
            .ok_or(LockedDependencyError::LockMismatch)?;
        check_range(&spec, version)?;
    }
    Ok(())
}

pub(super) fn validate_dependency_edges(
    lock_packages: &serde_json::Map<String, Value>,
    included: &[LockedPackageV1],
    skipped: &[SkippedOptionalPackageV1],
) -> Result<(), LockedDependencyError> {
    let included_paths = included
        .iter()
        .map(|item| item.package_path.as_str())
        .collect::<BTreeSet<_>>();
    let skipped_paths = skipped
        .iter()
        .map(|item| item.package_path.as_str())
        .collect::<BTreeSet<_>>();
    for (importer, entry) in lock_packages {
        if !importer.is_empty() && skipped_paths.contains(importer.as_str()) {
            continue;
        }
        if !importer.is_empty() {
            validate_package_path(importer)?;
        }
        validate_peer_metadata(entry)?;
        let mut required = dependency_map(entry.get("dependencies"))?;
        let optional = dependency_map(entry.get("optionalDependencies"))?;
        let peers = dependency_map(entry.get("peerDependencies"))?;
        required.retain(|name, _| !optional.contains_key(name));
        for (name, spec, optional_edge) in required
            .iter()
            .map(|(n, s)| (n, s, false))
            .chain(optional.iter().map(|(n, s)| (n, s, true)))
            .chain(
                peers
                    .iter()
                    .map(|(n, s)| (n, s, peer_is_optional(entry, n))),
            )
        {
            validate_package_name(name)?;
            let resolved = nearest_locked_package(importer, name, lock_packages)?;
            let Some(path) = resolved else {
                if optional_edge {
                    continue;
                }
                return Err(LockedDependencyError::LockMismatch);
            };
            if skipped_paths.contains(path.as_str()) {
                if optional_edge {
                    continue;
                }
                return Err(LockedDependencyError::LockMismatch);
            }
            if !included_paths.contains(path.as_str()) {
                if optional_edge {
                    continue;
                }
                return Err(LockedDependencyError::LockMismatch);
            }
            let version = lock_packages
                .get(&path)
                .and_then(|value| value.get("version"))
                .and_then(Value::as_str)
                .ok_or(LockedDependencyError::LockMismatch)?;
            check_range(spec, version)?;
        }
    }
    Ok(())
}

fn peer_is_optional(entry: &Value, name: &str) -> bool {
    entry
        .get("peerDependenciesMeta")
        .and_then(|meta| meta.get(name))
        .and_then(|meta| meta.get("optional"))
        .and_then(Value::as_bool)
        == Some(true)
}

fn validate_peer_metadata(entry: &Value) -> Result<(), LockedDependencyError> {
    let Some(metadata) = entry.get("peerDependenciesMeta") else {
        return Ok(());
    };
    let metadata = metadata
        .as_object()
        .ok_or(LockedDependencyError::UnsupportedPackage)?;
    for (name, value) in metadata {
        validate_package_name(name)?;
        let object = value
            .as_object()
            .ok_or(LockedDependencyError::UnsupportedPackage)?;
        if object.len() != 1 || object.get("optional").and_then(Value::as_bool).is_none() {
            return Err(LockedDependencyError::UnsupportedPackage);
        }
    }
    Ok(())
}

fn check_range(spec: &str, version: &str) -> Result<(), LockedDependencyError> {
    match locked_dependency_range::matches(spec, version) {
        Ok(true) => Ok(()),
        Ok(false) => Err(LockedDependencyError::LockMismatch),
        Err(()) => Err(LockedDependencyError::UnsupportedRange),
    }
}

fn dependency_map(
    value: Option<&Value>,
) -> Result<BTreeMap<String, String>, LockedDependencyError> {
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };
    let object = value
        .as_object()
        .ok_or(LockedDependencyError::InvalidJson)?;
    let mut output = BTreeMap::new();
    for (name, spec) in object {
        let spec = spec
            .as_str()
            .filter(|value| {
                !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
            })
            .ok_or(LockedDependencyError::UnsupportedPackage)?;
        output.insert(name.clone(), spec.to_owned());
    }
    Ok(output)
}

fn nearest_locked_package(
    importer_package: &str,
    dependency_name: &str,
    packages: &serde_json::Map<String, Value>,
) -> Result<Option<String>, LockedDependencyError> {
    if importer_package.is_empty() {
        let root_candidate = format!("node_modules/{dependency_name}");
        return Ok(packages
            .contains_key(&root_candidate)
            .then_some(root_candidate));
    }
    validate_package_path(importer_package)?;
    validate_package_name(dependency_name)?;
    let parts = importer_package.split('/').collect::<Vec<_>>();
    let mut prefixes = Vec::new();
    let mut index = 1;
    while index < parts.len() {
        let start = index;
        if parts[index].starts_with('@') {
            index += 2
        } else {
            index += 1
        }
        prefixes.push(parts[..index].join("/"));
        if index < parts.len() {
            if parts[index] != "node_modules" {
                return Err(LockedDependencyError::InvalidPackagePath);
            }
            index += 1;
            if index <= start {
                return Err(LockedDependencyError::InvalidPackagePath);
            }
        }
    }
    for prefix in prefixes.into_iter().rev() {
        let candidate = format!("{prefix}/node_modules/{dependency_name}");
        if packages.contains_key(&candidate) {
            return Ok(Some(candidate));
        }
    }
    let root_candidate = format!("node_modules/{dependency_name}");
    Ok(packages
        .contains_key(&root_candidate)
        .then_some(root_candidate))
}

pub(super) fn target_skip_reason(
    entry: &Value,
    target: &BuildTargetV1,
) -> Result<Option<&'static str>, LockedDependencyError> {
    let os_match = platform_match(entry.get("os"), &target.os)?;
    let cpu_match = platform_match(entry.get("cpu"), &target.cpu)?;
    if !os_match {
        return Ok(Some("target_os_mismatch"));
    }
    if !cpu_match {
        return Ok(Some("target_cpu_mismatch"));
    }
    Ok(None)
}

fn platform_match(value: Option<&Value>, selected: &str) -> Result<bool, LockedDependencyError> {
    let Some(value) = value else { return Ok(true) };
    let values = value
        .as_array()
        .ok_or(LockedDependencyError::UnsupportedPackage)?;
    if values.is_empty() {
        return Ok(true);
    }
    let mut positives = Vec::new();
    let mut negatives = Vec::new();
    for value in values {
        let text = value
            .as_str()
            .ok_or(LockedDependencyError::UnsupportedPackage)?;
        if text.len() > 32 || text.is_empty() || text.chars().any(char::is_control) {
            return Err(LockedDependencyError::UnsupportedPackage);
        }
        if let Some(excluded) = text.strip_prefix('!') {
            if !supported_platform_value(excluded) {
                return Err(LockedDependencyError::UnsupportedPackage);
            }
            negatives.push(excluded);
        } else {
            if !supported_platform_value(text) {
                return Err(LockedDependencyError::UnsupportedPackage);
            }
            positives.push(text);
        }
    }
    Ok(!negatives.contains(&selected) && (positives.is_empty() || positives.contains(&selected)))
}

fn supported_platform_value(value: &str) -> bool {
    matches!(
        value,
        "darwin"
            | "linux"
            | "win32"
            | "freebsd"
            | "openbsd"
            | "sunos"
            | "aix"
            | "android"
            | "openharmony"
            | "arm"
            | "arm64"
            | "ia32"
            | "x64"
            | "ppc64"
            | "s390x"
            | "riscv64"
            | "wasm32"
            | "loong64"
            | "mips"
            | "mipsel"
            | "mips64el"
            | "netbsd"
            | "universal"
    )
}

pub(super) fn validate_target(target: &BuildTargetV1) -> Result<(), LockedDependencyError> {
    if !matches!(target.os.as_str(), "darwin" | "linux" | "win32")
        || !matches!(target.cpu.as_str(), "arm64" | "x64")
    {
        return Err(LockedDependencyError::InvalidTarget);
    }
    Ok(())
}

pub(super) fn optional_lock_bool(
    entry: &Value,
    field: &str,
) -> Result<bool, LockedDependencyError> {
    match entry.get(field) {
        None => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(LockedDependencyError::UnsupportedPackage),
    }
}

pub(super) fn validate_package_path(path: &str) -> Result<(), LockedDependencyError> {
    if path.len() > MAX_PATH_BYTES || path.contains('\\') || path.chars().any(char::is_control) {
        return Err(LockedDependencyError::InvalidPackagePath);
    }
    let parts = path.split('/').collect::<Vec<_>>();
    if parts.len() > MAX_PATH_DEPTH || parts.first() != Some(&"node_modules") {
        return Err(LockedDependencyError::InvalidPackagePath);
    }
    let mut index = 1;
    let mut count = 0;
    while index < parts.len() {
        let part = parts[index];
        if let Some(scope) = part.strip_prefix('@') {
            validate_package_name(scope)?;
            index += 1;
            validate_package_name(
                parts
                    .get(index)
                    .ok_or(LockedDependencyError::InvalidPackagePath)?,
            )?;
            index += 1;
        } else {
            validate_package_name(part)?;
            index += 1;
        }
        count += 1;
        if index == parts.len() {
            break;
        }
        if parts[index] != "node_modules" {
            return Err(LockedDependencyError::InvalidPackagePath);
        }
        index += 1;
        if index == parts.len() {
            return Err(LockedDependencyError::InvalidPackagePath);
        }
    }
    if count == 0 {
        return Err(LockedDependencyError::InvalidPackagePath);
    }
    Ok(())
}

pub(super) fn validate_package_name(name: &str) -> Result<(), LockedDependencyError> {
    if name.is_empty() || name.len() > 214 {
        return Err(LockedDependencyError::InvalidPackagePath);
    }
    let segments: Vec<&str> = if let Some(scoped) = name.strip_prefix('@') {
        let (scope, package) = scoped
            .split_once('/')
            .ok_or(LockedDependencyError::InvalidPackagePath)?;
        if package.contains('/') {
            return Err(LockedDependencyError::InvalidPackagePath);
        }
        vec![scope, package]
    } else {
        if name.contains('/') {
            return Err(LockedDependencyError::InvalidPackagePath);
        }
        vec![name]
    };
    if segments.iter().any(|segment| {
        segment.is_empty()
            || *segment == "."
            || *segment == ".."
            || !segment
                .bytes()
                .any(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
            || !segment.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'-' | b'_' | b'.' | b'~')
            })
    }) {
        return Err(LockedDependencyError::InvalidPackagePath);
    }
    Ok(())
}

pub(super) fn package_name_from_path(path: &str) -> Option<String> {
    if validate_package_path(path).is_err() {
        return None;
    }
    let parts = path.split('/').collect::<Vec<_>>();
    let mut index = 1;
    let mut name = None;
    while index < parts.len() {
        if parts[index].starts_with('@') {
            name = Some(format!("{}/{}", parts[index], parts[index + 1]));
            index += 2;
        } else {
            name = Some(parts[index].to_owned());
            index += 1;
        }
        if index < parts.len() {
            index += 1;
        }
    }
    name
}

pub(super) fn valid_integrity(integrity: &PackageIntegrityV1) -> bool {
    let expected_len = match integrity.algorithm.as_str() {
        "sha512" => 128,
        "sha256" => 64,
        _ => return false,
    };
    integrity.digest_hex.len() == expected_len
        && integrity
            .digest_hex
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub(super) fn valid_package_version(value: &str) -> bool {
    semver::Version::parse(value).is_ok_and(|version| version.to_string() == value)
}

pub(super) fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
