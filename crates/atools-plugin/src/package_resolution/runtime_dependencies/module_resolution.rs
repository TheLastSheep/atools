use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{
    model::{DependencyKind as Kind, DependencyStatus as Status},
    resolver::{Pending, Scan, ANCESTOR_DEPTH_LIMIT, BYTE_LIMIT, FILE_LIMIT, PATH_LIMIT},
};
use crate::package_resolution::paths;

impl Scan<'_> {
    pub(super) fn resolve_local(&mut self, from: &Pending, specifier: &str) {
        let parent = from.path.parent().unwrap_or_else(|| Path::new(""));
        let relative = match paths::normalized_relative(parent, specifier, true) {
            Ok(path) if path.as_os_str().len() <= PATH_LIMIT => path,
            _ => {
                self.unknown(
                    from.path.clone(),
                    specifier,
                    "unsafe_or_unsupported_module_specifier",
                );
                return;
            }
        };
        match self.resolve_path(&relative) {
            Resolve::File(path, _bytes) if path.extension().is_some_and(|ext| ext == "node") => {
                self.finding(
                    specifier,
                    from.path.clone(),
                    Some(path),
                    Kind::NativeAddon,
                    Status::Unknown,
                    "native_addon_not_loaded_or_abi_checked",
                );
                self.complete = false;
            }
            Resolve::File(path, _) => {
                self.finding(
                    specifier,
                    from.path.clone(),
                    Some(path.clone()),
                    Kind::LocalPreload,
                    Status::Resolved,
                    "local_preload_module_resolved",
                );
                self.pending.push_back(Pending {
                    path,
                    depth: from.depth + 1,
                });
            }
            Resolve::Unknown(reason) => self.unknown(from.path.clone(), specifier, reason),
            Resolve::Missing => self.finding(
                specifier,
                from.path.clone(),
                None,
                Kind::LocalPreload,
                Status::Missing,
                "literal_local_module_missing",
            ),
        }
    }

    pub(super) fn resolve_external(&mut self, from: &Pending, specifier: &str) {
        let Some((package_name, subpath)) = package_parts(specifier) else {
            self.unknown(from.path.clone(), specifier, "invalid_package_specifier");
            return;
        };
        let mut directory = from
            .path
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .to_path_buf();
        loop {
            let candidate = directory.join("node_modules").join(&package_name);
            if subpath.is_none() {
                match self.resolve_path_files_only(&candidate) {
                    Resolve::File(path, _bytes)
                        if path.extension().is_some_and(|ext| ext == "node") =>
                    {
                        self.finding(
                            specifier,
                            from.path.clone(),
                            Some(path),
                            Kind::NativeAddon,
                            Status::Unknown,
                            "native_addon_not_loaded_or_abi_checked",
                        );
                        self.complete = false;
                        return;
                    }
                    Resolve::File(path, _) => {
                        self.finding(
                            specifier,
                            from.path.clone(),
                            Some(path.clone()),
                            Kind::ExternalNodeModule,
                            Status::Resolved,
                            "preload_node_module_resolved",
                        );
                        self.pending.push_back(Pending {
                            path,
                            depth: from.depth + 1,
                        });
                        return;
                    }
                    Resolve::Unknown(reason) => {
                        self.unknown(from.path.clone(), specifier, reason);
                        return;
                    }
                    Resolve::Missing => {}
                }
            }
            match self.read_package_json(&candidate) {
                PackageRead::Json(manifest) => {
                    if manifest.get("exports").is_some() {
                        self.unknown(
                            from.path.clone(),
                            specifier,
                            "package_exports_resolution_unsupported",
                        );
                        return;
                    }
                    if manifest.get("type").and_then(Value::as_str) == Some("module") {
                        self.unknown(
                            from.path.clone(),
                            specifier,
                            "package_type_module_unsupported",
                        );
                        return;
                    }
                    let target = if let Some(subpath) = subpath.as_deref() {
                        candidate.join(subpath)
                    } else if let Some(main) = manifest.get("main").and_then(Value::as_str) {
                        if main.starts_with('/') || main.contains(['\\', '\0', ':']) {
                            self.unknown(from.path.clone(), specifier, "unsafe_package_main_path");
                            return;
                        }
                        match paths::normalized_relative(&candidate, main, true) {
                            Ok(path) if path.starts_with(&candidate) => path,
                            _ => {
                                self.unknown(
                                    from.path.clone(),
                                    specifier,
                                    "unsafe_package_main_path",
                                );
                                return;
                            }
                        }
                    } else {
                        if manifest.get("main").is_some() {
                            self.unknown(
                                from.path.clone(),
                                specifier,
                                "unsupported_package_main_value",
                            );
                            return;
                        }
                        candidate.join("index")
                    };
                    let mut resolved = self.resolve_path(&target);
                    if matches!(&resolved, Resolve::Missing)
                        && subpath.is_none()
                        && manifest.get("main").is_some()
                    {
                        resolved = self.resolve_path_files_only(&candidate.join("index"));
                    }
                    match resolved {
                        Resolve::File(path, _bytes)
                            if path.extension().is_some_and(|ext| ext == "node") =>
                        {
                            self.finding(
                                specifier,
                                from.path.clone(),
                                Some(path),
                                Kind::NativeAddon,
                                Status::Unknown,
                                "native_addon_not_loaded_or_abi_checked",
                            );
                            self.complete = false;
                        }
                        Resolve::File(path, _) => {
                            self.finding(
                                specifier,
                                from.path.clone(),
                                Some(path.clone()),
                                Kind::ExternalNodeModule,
                                Status::Resolved,
                                "preload_node_module_resolved",
                            );
                            self.pending.push_back(Pending {
                                path,
                                depth: from.depth + 1,
                            });
                        }
                        Resolve::Missing => self.finding(
                            specifier,
                            from.path.clone(),
                            None,
                            Kind::ExternalNodeModule,
                            Status::Missing,
                            "literal_external_module_missing",
                        ),
                        Resolve::Unknown(reason) => {
                            self.unknown(from.path.clone(), specifier, reason)
                        }
                    }
                    return;
                }
                PackageRead::Missing => {
                    let target = subpath
                        .as_deref()
                        .map(|value| candidate.join(value))
                        .unwrap_or_else(|| candidate.clone());
                    match self.resolve_path(&target) {
                        Resolve::File(path, _bytes)
                            if path.extension().is_some_and(|ext| ext == "node") =>
                        {
                            self.finding(
                                specifier,
                                from.path.clone(),
                                Some(path),
                                Kind::NativeAddon,
                                Status::Unknown,
                                "native_addon_not_loaded_or_abi_checked",
                            );
                            self.complete = false;
                        }
                        Resolve::File(path, _) => {
                            self.finding(
                                specifier,
                                from.path.clone(),
                                Some(path.clone()),
                                Kind::ExternalNodeModule,
                                Status::Resolved,
                                "preload_node_module_resolved",
                            );
                            self.pending.push_back(Pending {
                                path,
                                depth: from.depth + 1,
                            });
                        }
                        Resolve::Unknown(reason) => {
                            self.unknown(from.path.clone(), specifier, reason);
                            return;
                        }
                        Resolve::Missing => {}
                    }
                }
                PackageRead::Unknown(reason) => {
                    self.unknown(from.path.clone(), specifier, reason);
                    return;
                }
            }
            if directory.as_os_str().is_empty() {
                break;
            }
            if directory.components().count() > ANCESTOR_DEPTH_LIMIT {
                self.unknown(
                    from.path.clone(),
                    specifier,
                    "dependency_ancestor_budget_exhausted",
                );
                return;
            }
            let Some(parent) = directory.parent() else {
                break;
            };
            directory = parent.to_path_buf();
        }
        self.finding(
            specifier,
            from.path.clone(),
            None,
            Kind::ExternalNodeModule,
            Status::Missing,
            "literal_external_module_missing",
        );
    }

    fn read_package_json(&mut self, package: &Path) -> PackageRead {
        let manifest_path = package.join("package.json");
        if manifest_path.as_os_str().len() > PATH_LIMIT {
            return PackageRead::Unknown("dependency_path_budget_exhausted");
        }
        if self.files >= FILE_LIMIT || self.bytes >= BYTE_LIMIT {
            return PackageRead::Unknown("dependency_file_or_byte_budget_exhausted");
        }
        match self.read_asset(&manifest_path) {
            Ok(None) => PackageRead::Missing,
            Ok(Some(bytes)) => serde_json::from_slice(&bytes)
                .map(PackageRead::Json)
                .unwrap_or(PackageRead::Unknown(
                    "invalid_or_oversized_package_manifest",
                )),
            Err(error) if error.to_ascii_lowercase().contains("budget") => {
                PackageRead::Unknown("dependency_resolver_budget_exhausted")
            }
            Err(_) => PackageRead::Unknown("unsafe_or_unreadable_package_path"),
        }
    }

    fn resolve_path(&mut self, target: &Path) -> Resolve {
        if target.as_os_str().len() > PATH_LIMIT {
            return Resolve::Unknown("dependency_path_budget_exhausted");
        }
        let mut candidates = vec![target.to_path_buf()];
        if target.extension().is_none() {
            for ext in ["js", "json", "node"] {
                candidates.push(target.with_extension(ext));
            }
        }
        for candidate in candidates {
            if self.files >= FILE_LIMIT || self.bytes >= BYTE_LIMIT {
                return Resolve::Unknown("dependency_file_or_byte_budget_exhausted");
            }
            match self.read_asset(&candidate) {
                Ok(Some(bytes)) => return Resolve::File(candidate, bytes),
                Ok(None) => {}
                Err(error) => {
                    let lower = error.to_ascii_lowercase();
                    if lower.contains("budget") || lower.contains("path_budget") {
                        return Resolve::Unknown("dependency_resolver_budget_exhausted");
                    } else if !(lower.contains("not a directory")
                        || lower.contains("not a regular file")
                        || lower.contains("is a directory")
                        || lower.contains("no such file"))
                    {
                        return Resolve::Unknown("unsafe_or_unreadable_package_path");
                    }
                }
            }
        }
        match self.read_package_json_for_path(&target.join("package.json")) {
            PackageRead::Json(manifest) => {
                if manifest.get("exports").is_some() {
                    return Resolve::Unknown("package_exports_resolution_unsupported");
                }
                if manifest.get("type").and_then(Value::as_str) == Some("module") {
                    return Resolve::Unknown("package_type_module_unsupported");
                }
                let entry = match manifest.get("main").and_then(Value::as_str) {
                    Some(main) if !main.starts_with('/') && !main.contains(['\\', '\0', ':']) => {
                        match paths::normalized_relative(target, main, true) {
                            Ok(path) if path.starts_with(target) => path,
                            _ => return Resolve::Unknown("unsafe_package_main_path"),
                        }
                    }
                    Some(_) => return Resolve::Unknown("unsafe_package_main_path"),
                    None if manifest.get("main").is_some() => {
                        return Resolve::Unknown("unsupported_package_main_value")
                    }
                    None => target.join("index"),
                };
                let mut resolved = self.resolve_path_files_only(&entry);
                if matches!(&resolved, Resolve::Missing) && manifest.get("main").is_some() {
                    resolved = self.resolve_path_files_only(&target.join("index"));
                }
                resolved
            }
            PackageRead::Missing => self.resolve_path_files_only(&target.join("index")),
            PackageRead::Unknown(reason) => Resolve::Unknown(reason),
        }
    }

    fn resolve_path_files_only(&mut self, target: &Path) -> Resolve {
        let mut candidates = vec![target.to_path_buf()];
        if target.extension().is_none() {
            for ext in ["js", "json", "node"] {
                candidates.push(target.with_extension(ext));
            }
        }
        for candidate in candidates {
            if self.files >= FILE_LIMIT || self.bytes >= BYTE_LIMIT {
                return Resolve::Unknown("dependency_file_or_byte_budget_exhausted");
            }
            match self.read_asset(&candidate) {
                Ok(Some(bytes)) => return Resolve::File(candidate, bytes),
                Ok(None) => {}
                Err(error) => {
                    let lower = error.to_ascii_lowercase();
                    if lower.contains("budget") || lower.contains("path_budget") {
                        return Resolve::Unknown("dependency_resolver_budget_exhausted");
                    } else if !(lower.contains("not a directory")
                        || lower.contains("not a regular file")
                        || lower.contains("is a directory"))
                    {
                        return Resolve::Unknown("unsafe_or_unreadable_package_path");
                    }
                }
            }
        }
        Resolve::Missing
    }

    fn read_package_json_for_path(&mut self, path: &Path) -> PackageRead {
        if path.as_os_str().len() > PATH_LIMIT {
            return PackageRead::Unknown("dependency_path_budget_exhausted");
        }
        match self.read_asset(path) {
            Ok(None) => PackageRead::Missing,
            Ok(Some(bytes)) => serde_json::from_slice(&bytes)
                .map(PackageRead::Json)
                .unwrap_or(PackageRead::Unknown(
                    "invalid_or_oversized_package_manifest",
                )),
            Err(error) if error.to_ascii_lowercase().contains("budget") => {
                PackageRead::Unknown("dependency_resolver_budget_exhausted")
            }
            Err(_) => PackageRead::Unknown("unsafe_or_unreadable_package_path"),
        }
    }
}

enum Resolve {
    File(PathBuf, Vec<u8>),
    Missing,
    Unknown(&'static str),
}
enum PackageRead {
    Json(Value),
    Missing,
    Unknown(&'static str),
}

fn package_parts(specifier: &str) -> Option<(String, Option<String>)> {
    let mut parts = specifier.split('/');
    let first = parts.next()?;
    if first.is_empty() || first == "." || first == ".." {
        return None;
    }
    let (name, rest) = if first.starts_with('@') {
        let second = parts.next()?;
        if first.len() < 2 || second.is_empty() || second == "." || second == ".." {
            return None;
        }
        (format!("{first}/{second}"), parts.collect::<Vec<_>>())
    } else {
        (first.to_string(), parts.collect::<Vec<_>>())
    };
    if name.contains(['\\', '\0', ':']) {
        return None;
    }
    let subpath = if rest.is_empty() {
        None
    } else {
        if rest
            .iter()
            .any(|part| part.is_empty() || *part == "." || *part == "..")
        {
            return None;
        }
        Some(rest.join("/"))
    };
    Some((name, subpath))
}
