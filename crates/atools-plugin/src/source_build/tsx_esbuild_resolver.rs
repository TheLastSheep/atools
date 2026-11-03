//! Resolves the esbuild executable imported by the reviewed TSX Node test loader.
//!
//! This intentionally supports only the inspected TSX 4.23.1 ESM/CJS loader
//! layout. It is not a general Node dependency-closure resolver; changed
//! exports/importers fail closed until their runtime resolution is reviewed.
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::esbuild_resolver::{
    direct_project_spec, lock_entry, resolve_esbuild_binary_for_importers_checked,
    verify_installed_version, ResolveError,
};
use super::metadata::{canonical_directory, canonical_regular_file, read_json};
use super::policy::string;
use crate::package_resolution::read_package_asset_bytes;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TsxResolveError {
    Missing,
    LockMismatch,
    Unsupported,
    Unsafe,
}

impl From<ResolveError> for TsxResolveError {
    fn from(error: ResolveError) -> Self {
        match error {
            ResolveError::Missing => Self::Missing,
            ResolveError::LockMismatch => Self::LockMismatch,
            ResolveError::AmbiguousImporters => Self::Unsupported,
            ResolveError::Unsafe => Self::Unsafe,
        }
    }
}

const REVIEWED_TSX_VERSION: &str = "4.23.1";
const TSX_PACKAGE: &str = "node_modules/tsx";
const MAX_IMPORTER_BYTES: usize = 1024 * 1024;

pub(super) fn resolve_tsx_esbuild(
    root: &Path,
    dependency_root: &Path,
    project_package: &Value,
    lock: &Value,
) -> Result<PathBuf, TsxResolveError> {
    if dependency_root.strip_prefix(root).ok() != Some(Path::new("node_modules")) {
        return Err(TsxResolveError::Unsafe);
    }

    let tsx_relative = Path::new(TSX_PACKAGE);
    let tsx_directory = canonical_directory(root, tsx_relative)
        .map_err(|_| ResolveError::Unsafe)?
        .ok_or(ResolveError::Missing)?;
    if !tsx_directory.starts_with(dependency_root) {
        return Err(TsxResolveError::Unsafe);
    }
    let tsx_package = read_json(root, &tsx_relative.join("package.json"))
        .map_err(|_| ResolveError::Unsafe)?
        .ok_or(ResolveError::Missing)?;
    if string(&tsx_package, "name") != Some("tsx") {
        return Err(TsxResolveError::LockMismatch);
    }
    let tsx_version = string(&tsx_package, "version").ok_or(ResolveError::LockMismatch)?;
    let tsx_spec = direct_project_spec(project_package, "tsx").ok_or(ResolveError::LockMismatch)?;
    let tsx_lock = lock_entry(lock, tsx_relative)?;
    verify_installed_version("tsx", tsx_version, tsx_lock, tsx_spec)?;
    let lock_root = lock
        .get("packages")
        .and_then(|packages| packages.get(""))
        .ok_or(ResolveError::LockMismatch)?;
    if direct_project_spec(lock_root, "tsx") != Some(tsx_spec) {
        return Err(TsxResolveError::LockMismatch);
    }
    // First preserve metadata classifications even when a supported-layout
    // review will later reject the package version, export, or import graph.
    let tsx_esbuild_spec = tsx_package
        .get("dependencies")
        .and_then(|dependencies| dependencies.get("esbuild"))
        .and_then(Value::as_str)
        .ok_or(ResolveError::Missing)?;
    if tsx_lock
        .get("dependencies")
        .and_then(|dependencies| dependencies.get("esbuild"))
        .and_then(Value::as_str)
        != Some(tsx_esbuild_spec)
    {
        return Err(TsxResolveError::LockMismatch);
    }

    if tsx_version != REVIEWED_TSX_VERSION {
        return Err(TsxResolveError::Unsupported);
    }
    // The reviewed TSX 4.23.1 graph requires this dependency range. Other
    // lock-consistent ranges remain eligible for the unsupported-version
    // classification above rather than being mislabeled as lock failures.
    if tsx_esbuild_spec != "~0.28.0" {
        return Err(TsxResolveError::LockMismatch);
    }

    if tsx_package
        .get("exports")
        .and_then(|exports| exports.get("."))
        .and_then(Value::as_str)
        != Some("./dist/loader.mjs")
    {
        return Err(TsxResolveError::Unsupported);
    }
    validate_import_graph(root, &tsx_directory)?;

    // TSX 4.23.1's reviewed loader imports both the ESM and CJS entrypoints.
    // Keep the concrete CJS importer directory in the same resolution check:
    // Node resolves `require("esbuild")` from each importing file, and a nearer
    // package under dist/cjs must not be skipped.
    let importers = [
        PathBuf::from(TSX_PACKAGE).join("dist/esm"),
        PathBuf::from(TSX_PACKAGE).join("dist"),
        PathBuf::from(TSX_PACKAGE).join("dist/cjs"),
    ];
    resolve_esbuild_binary_for_importers_checked(
        root,
        dependency_root,
        &importers,
        project_package,
        lock,
        tsx_esbuild_spec,
    )
    .map_err(TsxResolveError::from)
}

fn validate_import_graph(root: &Path, tsx_directory: &Path) -> Result<(), TsxResolveError> {
    let loader = read_importer(root, "node_modules/tsx/dist/loader.mjs", tsx_directory)?;
    let cjs_entry = read_importer(root, "node_modules/tsx/dist/cjs/index.cjs", tsx_directory)?;
    let esm_entry = read_importer(root, "node_modules/tsx/dist/esm/index.mjs", tsx_directory)?;
    let esbuild_importer = read_importer(
        root,
        "node_modules/tsx/dist/index-CQhDiIsg.mjs",
        tsx_directory,
    )?;
    let cjs_esbuild_importer = read_importer(
        root,
        "node_modules/tsx/dist/index-BN2t1Mfo.cjs",
        tsx_directory,
    )?;
    if !loader.contains("from\"./esm/index.mjs\"")
        || !loader.contains("r(\"./cjs/index.cjs\")")
        || !cjs_entry.contains("require(\"esbuild\")")
        || !cjs_entry.contains("../index-BN2t1Mfo.cjs")
        || !esm_entry.contains("import\"esbuild\"")
        || !esm_entry.contains("../index-CQhDiIsg.mjs")
        || !esbuild_importer.contains("from\"esbuild\"")
        || !cjs_esbuild_importer.contains("require(\"esbuild\")")
    {
        return Err(TsxResolveError::Unsupported);
    }
    Ok(())
}

fn read_importer(
    root: &Path,
    relative: &str,
    tsx_directory: &Path,
) -> Result<String, TsxResolveError> {
    let path = Path::new(relative);
    let canonical = canonical_regular_file(root, path)
        .map_err(|_| ResolveError::Unsafe)?
        .ok_or(ResolveError::Missing)?;
    if !canonical.starts_with(tsx_directory) {
        return Err(TsxResolveError::Unsafe);
    }
    let bytes = read_package_asset_bytes(root, path, MAX_IMPORTER_BYTES)
        .map_err(|_| ResolveError::Unsafe)?
        .ok_or(ResolveError::Missing)?;
    String::from_utf8(bytes).map_err(|_| ResolveError::Unsafe.into())
}
