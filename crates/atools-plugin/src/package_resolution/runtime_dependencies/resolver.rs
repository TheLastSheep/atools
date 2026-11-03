use std::{
    collections::{BTreeSet, HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
};

use super::{
    builtins::is_node_builtin,
    lexer,
    model::{
        DependencyKind as Kind, DependencyStatus as Status, RuntimeDependencyBudget as Budget,
        RuntimeDependencyFinding as Finding, RuntimeDependencyReport as Report,
    },
};
use crate::package_resolution::{paths, ResolvedPluginPackage};

pub(super) const FILE_LIMIT: usize = 128;
pub(super) const BYTE_LIMIT: usize = 4 * 1024 * 1024;
pub(super) const EDGE_LIMIT: usize = 512;
pub(super) const DEPTH_LIMIT: usize = 32;
pub(super) const PATH_LIMIT: usize = 512;
pub(super) const PROBE_LIMIT: usize = 4096;
pub(super) const ANCESTOR_DEPTH_LIMIT: usize = 64;
pub(super) const PER_FILE_LIMIT: usize = 256 * 1024;

pub(super) struct Pending {
    pub(super) path: PathBuf,
    pub(super) depth: usize,
}

pub(super) struct Scan<'a> {
    pub(super) root: &'a Path,
    pub(super) package_name: &'a str,
    findings: Vec<Finding>,
    seen_files: HashSet<PathBuf>,
    module_type_cache: HashMap<PathBuf, Option<bool>>,
    seen_edges: BTreeSet<(PathBuf, String)>,
    pub(super) pending: VecDeque<Pending>,
    pub(super) files: usize,
    pub(super) bytes: usize,
    probes: usize,
    edges: usize,
    max_depth: usize,
    pub(super) complete: bool,
}

pub(super) fn inspect(package: &ResolvedPluginPackage) -> Report {
    let preload = package.manifest.preload.as_deref();
    let selected =
        preload.and_then(|value| paths::normalized_relative(Path::new(""), value, false).ok());
    let mut scan = Scan {
        root: &package.package_root,
        package_name: &package.manifest.name,
        findings: Vec::new(),
        seen_files: HashSet::new(),
        module_type_cache: HashMap::new(),
        seen_edges: BTreeSet::new(),
        pending: VecDeque::new(),
        files: 0,
        bytes: 0,
        probes: 0,
        edges: 0,
        max_depth: 0,
        complete: true,
    };
    match (preload, selected.as_ref()) {
        (None, _) => {}
        (Some(_), None) => scan.unknown(PathBuf::new(), "<preload>", "unsafe_preload_path"),
        (Some(_), Some(entry)) => scan.pending.push_back(Pending {
            path: entry.clone(),
            depth: 0,
        }),
    }
    while let Some(next) = scan.pending.pop_front() {
        scan.inspect_file(next);
    }
    scan.findings.sort_by(|a, b| {
        a.source_path
            .cmp(&b.source_path)
            .then(a.specifier.cmp(&b.specifier))
            .then(a.kind.cmp(&b.kind))
            .then(a.status.cmp(&b.status))
            .then(a.reason_code.cmp(&b.reason_code))
            .then(a.resolved_path.cmp(&b.resolved_path))
    });
    scan.findings.dedup();
    Report {
        selected_preload: selected,
        findings: scan.findings,
        budget: Budget {
            files_read: scan.files,
            bytes_read: scan.bytes,
            edges_seen: scan.edges,
            max_depth_reached: scan.max_depth,
            resolver_probes: scan.probes,
            file_limit: FILE_LIMIT,
            byte_limit: BYTE_LIMIT,
            edge_limit: EDGE_LIMIT,
            depth_limit: DEPTH_LIMIT,
            path_limit: PATH_LIMIT,
            probe_limit: PROBE_LIMIT,
            ancestor_depth_limit: ANCESTOR_DEPTH_LIMIT,
            per_file_byte_limit: PER_FILE_LIMIT,
        },
        complete: scan.complete,
        runtime_verified: false,
    }
}

impl Scan<'_> {
    fn inspect_file(&mut self, pending: Pending) {
        self.max_depth = self.max_depth.max(pending.depth);
        if pending.depth > DEPTH_LIMIT {
            self.unknown(
                pending.path,
                "<depth-limit>",
                "dependency_depth_budget_exhausted",
            );
            return;
        }
        if pending.path.as_os_str().len() > PATH_LIMIT {
            self.unknown(
                pending.path,
                "<path-limit>",
                "dependency_path_budget_exhausted",
            );
            return;
        }
        if !self.seen_files.insert(pending.path.clone()) {
            return;
        }
        let bytes = match self.read_asset(&pending.path) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => {
                self.finding(
                    "<preload-file>",
                    pending.path,
                    None,
                    Kind::LocalPreload,
                    Status::Missing,
                    "selected_preload_or_module_missing",
                );
                return;
            }
            Err(error) => {
                let reason = if error.to_ascii_lowercase().contains("budget") {
                    "preload_file_budget_exhausted"
                } else {
                    "unsafe_or_unreadable_package_path"
                };
                self.unknown(pending.path, "<file-read>", reason);
                return;
            }
        };
        if pending.path.extension().is_some_and(|ext| ext == "node") {
            self.finding(
                pending.path.to_string_lossy().into_owned(),
                pending.path,
                None,
                Kind::NativeAddon,
                Status::Unknown,
                "native_addon_not_loaded_or_abi_checked",
            );
            self.complete = false;
            return;
        }
        if pending.path.extension().is_some_and(|ext| ext == "mjs") {
            self.unknown(
                pending.path,
                "<esm-file>",
                "esm_file_resolution_unsupported",
            );
            return;
        }
        if pending.path.extension().is_some_and(|ext| ext == "js") {
            match self.js_is_esm_by_package_scope(&pending.path) {
                Ok(true) => {
                    self.unknown(pending.path, "<source>", "package_type_module_unsupported");
                    return;
                }
                Ok(false) => {}
                Err(reason) => {
                    self.unknown(pending.path, "<package-scope>", reason);
                    return;
                }
            }
        }
        if pending.path.extension().is_some_and(|ext| ext == "json") {
            return;
        }
        let Ok(source) = std::str::from_utf8(&bytes) else {
            self.unknown(pending.path, "<source>", "non_utf8_preload_source");
            return;
        };
        let calls = lexer::extract(source);
        for reason in &calls.uncertainty_reasons {
            self.unknown(pending.path.clone(), "<source>", reason);
        }
        for call in calls.calls {
            if self.edges >= EDGE_LIMIT {
                self.unknown(
                    pending.path.clone(),
                    "<edge-limit>",
                    "dependency_edge_budget_exhausted",
                );
                break;
            }
            self.edges += 1;
            let specifier = call.specifier.unwrap_or_else(|| "<dynamic-require>".into());
            if calls.uncertain {
                self.finding(
                    specifier,
                    pending.path.clone(),
                    None,
                    Kind::DynamicUnknown,
                    Status::Unknown,
                    call.reason,
                );
                self.complete = false;
                continue;
            }
            self.resolve_call(&pending, &specifier);
        }
    }

    fn resolve_call(&mut self, from: &Pending, specifier: &str) {
        if !self
            .seen_edges
            .insert((from.path.clone(), specifier.to_string()))
        {
            return;
        }
        if specifier == "electron" {
            self.finding(
                specifier,
                from.path.clone(),
                None,
                Kind::ElectronShim,
                Status::HostProvided,
                "electron_host_shim",
            );
        } else if specifier.starts_with("electron/") {
            self.unknown(
                from.path.clone(),
                specifier,
                "electron_shim_subpath_unsupported",
            );
        } else if is_node_builtin(specifier) {
            self.finding(
                specifier,
                from.path.clone(),
                None,
                Kind::Builtin,
                Status::HostProvided,
                "node_builtin_v24_15_0",
            );
        } else if specifier.starts_with("node:") {
            self.unknown(
                from.path.clone(),
                specifier,
                "unknown_node_builtin_specifier",
            );
        } else if specifier.starts_with('#') {
            self.unknown(
                from.path.clone(),
                specifier,
                "package_imports_resolution_unsupported",
            );
        } else if specifier == self.package_name
            || specifier.starts_with(&format!("{}/", self.package_name))
        {
            self.unknown(
                from.path.clone(),
                specifier,
                "package_self_reference_unsupported",
            );
        } else if specifier.starts_with("./")
            || specifier.starts_with("../")
            || specifier == "."
            || specifier == ".."
        {
            self.resolve_local(from, specifier);
        } else if specifier.starts_with('/') || specifier.contains(['\\', '\0', ':']) {
            self.unknown(
                from.path.clone(),
                specifier,
                "unsafe_or_unsupported_module_specifier",
            );
        } else {
            self.resolve_external(from, specifier);
        }
    }

    pub(super) fn unknown(&mut self, source: PathBuf, specifier: &str, reason: &'static str) {
        self.complete = false;
        self.finding(
            specifier,
            source,
            None,
            Kind::DynamicUnknown,
            Status::Unknown,
            reason,
        );
    }

    pub(super) fn read_asset(&mut self, path: &Path) -> Result<Option<Vec<u8>>, String> {
        self.probes += 1;
        if self.probes > PROBE_LIMIT {
            return Err("dependency_probe_budget_exhausted".into());
        }
        if path.as_os_str().len() > PATH_LIMIT {
            return Err("dependency_path_budget_exhausted".into());
        }
        if self.files >= FILE_LIMIT || self.bytes >= BYTE_LIMIT {
            return Err("dependency_file_or_byte_budget_exhausted".into());
        }
        match paths::read_bytes(self.root, path, PER_FILE_LIMIT) {
            Ok(Some(bytes)) => {
                if self.bytes.saturating_add(bytes.len()) > BYTE_LIMIT {
                    return Err("dependency_byte_budget_exhausted".into());
                }
                self.files += 1;
                self.bytes += bytes.len();
                Ok(Some(bytes))
            }
            Ok(None) => Ok(None),
            Err(error) => {
                if error.to_string().to_ascii_lowercase().contains("budget") {
                    Err("dependency_file_byte_budget_exhausted".into())
                } else {
                    Err(error.to_string())
                }
            }
        }
    }

    fn js_is_esm_by_package_scope(&mut self, source: &Path) -> Result<bool, &'static str> {
        let mut directory = source
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .to_path_buf();
        for _ in 0..=ANCESTOR_DEPTH_LIMIT {
            if let Some(cached) = self.module_type_cache.get(&directory) {
                if let Some(is_module) = cached {
                    return Ok(*is_module);
                }
            } else {
                let manifest_path = directory.join("package.json");
                match self.read_asset(&manifest_path) {
                    Ok(None) => {
                        self.module_type_cache.insert(directory.clone(), None);
                    }
                    Ok(Some(bytes)) => {
                        let manifest: serde_json::Value = serde_json::from_slice(&bytes)
                            .map_err(|_| "invalid_or_oversized_package_manifest")?;
                        let module_type = match manifest.get("type") {
                            None => false,
                            Some(serde_json::Value::String(value)) if value == "module" => true,
                            Some(serde_json::Value::String(value)) if value == "commonjs" => false,
                            Some(_) => return Err("unsupported_package_type_value"),
                        };
                        self.module_type_cache
                            .insert(directory.clone(), Some(module_type));
                        return Ok(module_type);
                    }
                    Err(error) => {
                        let lower = error.to_ascii_lowercase();
                        return Err(if lower.contains("budget") {
                            "dependency_resolver_budget_exhausted"
                        } else {
                            "unsafe_or_unreadable_package_path"
                        });
                    }
                }
            }
            if directory.as_os_str().is_empty() {
                return Ok(false);
            }
            if directory.components().count() > ANCESTOR_DEPTH_LIMIT {
                return Err("dependency_ancestor_budget_exhausted");
            }
            let Some(parent) = directory.parent() else {
                return Ok(false);
            };
            directory = parent.to_path_buf();
        }
        Err("dependency_ancestor_budget_exhausted")
    }

    pub(super) fn finding(
        &mut self,
        specifier: impl Into<String>,
        source: PathBuf,
        resolved: Option<PathBuf>,
        kind: Kind,
        status: Status,
        reason: &'static str,
    ) {
        self.findings.push(Finding {
            specifier: specifier.into(),
            source_path: source,
            resolved_path: resolved,
            kind,
            status,
            reason_code: reason.to_string(),
        });
    }
}
