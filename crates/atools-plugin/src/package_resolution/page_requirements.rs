//! Bounded, non-executing Node requirement inspection for selected Web entry.
mod module_classification;
use super::js_tokens::{lex, Token};
use super::{
    html::{html_entry_references, is_remote_entry, local_html_reference_path, HtmlAssetKind},
    paths::{canonical_root, html_relative, normalized_relative, read_bytes},
    resolve_plugin_package, PackageReadiness, MAX_HTML_BYTES,
};
use anyhow::Result;
use module_classification::{
    call_open, classify_call, is_node_builtin, is_reexport, is_selected_builtin,
    normalize_graph_path, require_resolve_call, unsupported_require_reference,
};
use serde::Serialize;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

const MAX_SOURCE_BYTES: usize = 4 * 1024 * 1024;
const MAX_SOURCE_COUNT: usize = 64;
const MAX_GRAPH_DEPTH: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Usage {
    Detected,
    NotDetected,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PageRequirements {
    pub node_usage: Usage,
    pub electron_usage: Usage,
}
impl PageRequirements {
    fn unknown() -> Self {
        Self {
            node_usage: Usage::Unknown,
            electron_usage: Usage::Unknown,
        }
    }
}

/// Inspects only the selected local HTML entry, actual scripts and static local dependencies.
pub fn inspect_plugin_page(root: &Path) -> Result<PageRequirements> {
    let package = resolve_plugin_package(root)?;
    if package.readiness != PackageReadiness::Ready
        || package.manifest.effective_runtime_kind() != atools_core::PluginRuntimeKind::Web
    {
        return Ok(PageRequirements::unknown());
    }
    let Some(main) = package.manifest.effective_runtime_entry() else {
        return Ok(PageRequirements::unknown());
    };
    let main_lower = main.to_ascii_lowercase();
    if is_remote_entry(main) || !(main_lower.ends_with(".html") || main_lower.ends_with(".htm")) {
        return Ok(PageRequirements::unknown());
    }
    let root = canonical_root(&package.package_root)?;
    let main_path = normalized_relative(Path::new(""), main, false)?;
    let Some(html) = read_bytes(&root, &main_path, MAX_HTML_BYTES)? else {
        return Ok(PageRequirements::unknown());
    };
    let Ok(html) = String::from_utf8(html) else {
        return Ok(PageRequirements::unknown());
    };
    let refs = html_entry_references(&html);
    let script_count = refs
        .assets
        .iter()
        .filter(|asset| asset.kind == HtmlAssetKind::Script)
        .count()
        + refs.inline_scripts.len();
    if refs.inline_scripts_truncated
        || refs.inline_handlers_truncated
        || refs.inline_handlers.len() + script_count + 1 > MAX_SOURCE_COUNT
        || refs.base_href.as_deref().is_some_and(is_remote_entry)
    {
        return Ok(PageRequirements::unknown());
    }
    let mut base = main_path
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .to_path_buf();
    if let Some(href) = refs.base_href.filter(|value| !value.is_empty()) {
        let Ok(decoded) = local_html_reference_path(&href) else {
            return Ok(PageRequirements::unknown());
        };
        let base_file = if decoded.ends_with('/') || decoded == "." || decoded == ".." {
            format!("{decoded}/__atools_base__")
        } else if decoded.is_empty() {
            "__atools_base__".to_string()
        } else {
            decoded
        };
        let Ok(mut base_path) = html_relative(&base, &base_file) else {
            return Ok(PageRequirements::unknown());
        };
        base_path.pop();
        base = base_path;
    }
    let mut scan = Scan::new(&root, 1, html.len());
    for inline in refs.inline_scripts {
        if scan.inspect_source(inline.as_bytes(), &main_path, 0) {
            return Ok(scan.finish());
        }
    }
    for handler in refs.inline_handlers {
        if scan.inspect_source(handler.as_bytes(), &main_path, 0) {
            return Ok(scan.finish());
        }
    }
    for asset in refs.assets {
        if asset.kind != HtmlAssetKind::Script || asset.value.trim().is_empty() {
            continue;
        }
        let value = asset.value.trim();
        if is_remote_entry(value) || value.starts_with("data:") || value.starts_with("blob:") {
            scan.unknown = true;
            continue;
        }
        let Ok(decoded) = local_html_reference_path(value) else {
            scan.unknown = true;
            continue;
        };
        let Ok(relative) = html_relative(&base, &decoded) else {
            scan.unknown = true;
            continue;
        };
        if scan.inspect_file(relative, 0) {
            return Ok(scan.finish());
        }
    }
    Ok(scan.finish())
}

/// Inspects a selected preload and its static local module graph with the same caps.
pub fn inspect_plugin_preload(root: &Path, preload: &str) -> Result<PageRequirements> {
    let package = resolve_plugin_package(root)?;
    let root = canonical_root(&package.package_root)?;
    let relative = normalized_relative(Path::new(""), preload, false)?;
    let mut scan = Scan::new(&root, 0, 0);
    scan.inspect_file(relative, 0);
    Ok(scan.finish())
}

/// Complete bounded source snapshot for one explicitly selected preload. This is
/// inspection data only and never authorizes or executes the selected source.
pub struct SelectedPreloadInspection {
    pub requirements: PageRequirements,
    pub sources: Vec<(PathBuf, Vec<u8>)>,
}

pub fn inspect_selected_preload(root: &Path, preload: &str) -> Result<SelectedPreloadInspection> {
    let canonical = canonical_root(root)?;
    if canonical != root {
        anyhow::bail!("Selected preload root changed or is not canonical");
    }
    let root = canonical;
    let relative = normalized_relative(Path::new(""), preload, false)?;
    let mut scan = Scan::new(&root, 0, 0);
    scan.capture_sources = true;
    scan.inspect_file(relative, 0);
    if scan.incomplete {
        anyhow::bail!("Selected preload graph is unsafe, missing or exceeds its inspection budget");
    }
    Ok(SelectedPreloadInspection {
        requirements: scan.finish(),
        sources: scan.captured,
    })
}

struct Scan<'a> {
    root: &'a Path,
    seen: HashSet<PathBuf>,
    sources: usize,
    bytes: usize,
    node: bool,
    electron: bool,
    unknown: bool,
    capture_sources: bool,
    incomplete: bool,
    captured: Vec<(PathBuf, Vec<u8>)>,
}
impl<'a> Scan<'a> {
    fn new(root: &'a Path, sources: usize, bytes: usize) -> Self {
        Self {
            root,
            seen: HashSet::new(),
            sources,
            bytes,
            node: false,
            electron: false,
            unknown: false,
            capture_sources: false,
            incomplete: false,
            captured: Vec::new(),
        }
    }
    fn finish(&self) -> PageRequirements {
        PageRequirements {
            node_usage: if self.node {
                Usage::Detected
            } else if self.unknown {
                Usage::Unknown
            } else {
                Usage::NotDetected
            },
            electron_usage: if self.electron {
                Usage::Detected
            } else if self.unknown {
                Usage::Unknown
            } else {
                Usage::NotDetected
            },
        }
    }
    fn inspect_file(&mut self, relative: PathBuf, depth: usize) -> bool {
        if self.seen.contains(&relative) {
            return false;
        }
        if depth > MAX_GRAPH_DEPTH || self.sources >= MAX_SOURCE_COUNT {
            self.unknown = true;
            self.incomplete = true;
            return false;
        }
        self.seen.insert(relative.clone());
        let Ok(Some(source)) = read_bytes(
            self.root,
            &relative,
            MAX_SOURCE_BYTES.saturating_sub(self.bytes),
        ) else {
            self.unknown = true;
            self.incomplete = true;
            return false;
        };
        self.inspect_source(&source, &relative, depth)
    }
    fn inspect_source(&mut self, source: &[u8], owner: &Path, depth: usize) -> bool {
        if self.sources >= MAX_SOURCE_COUNT
            || self.bytes.saturating_add(source.len()) > MAX_SOURCE_BYTES
        {
            self.unknown = true;
            self.incomplete = true;
            return false;
        }
        self.sources += 1;
        self.bytes += source.len();
        if self.capture_sources {
            self.captured.push((owner.to_path_buf(), source.to_vec()));
        }
        let Ok(source) = std::str::from_utf8(source) else {
            self.unknown = true;
            self.incomplete = true;
            return false;
        };
        let (tokens, uncertain) = lex(source);
        self.unknown |= uncertain;
        self.incomplete |= uncertain;
        let mut dependencies = Vec::new();
        for index in 0..tokens.len() {
            if self.capture_sources && unsupported_require_reference(&tokens, index) {
                self.unknown = true;
                self.incomplete = true;
            }
            let Token::Ident(name) = &tokens[index] else {
                continue;
            };
            if matches!(name.as_str(), "window" | "globalThis" | "self")
                && tokens.get(index + 1) == Some(&Token::Punct('['))
            {
                let close = (index + 2..tokens.len().min(index + 18))
                    .find(|cursor| tokens.get(*cursor) == Some(&Token::Punct(']')));
                if let Some(close) = close {
                    match tokens.get(index + 2) {
                        Some(Token::String(property)) if property == "require" => {
                            let resolve_member = tokens.get(close + 1) == Some(&Token::Punct('.'))
                                && tokens.get(close + 2) == Some(&Token::Ident("resolve".into()))
                                && call_open(&tokens, close + 3).is_some();
                            if resolve_member {
                                self.unknown = true;
                                self.incomplete = true;
                            } else if let Some(call_open) = call_open(&tokens, close + 1) {
                                classify_call(
                                    &tokens,
                                    call_open,
                                    true,
                                    self,
                                    owner,
                                    &mut dependencies,
                                );
                            }
                        }
                        Some(Token::String(property)) if property == "import" => {
                            if let Some(call_open) = call_open(&tokens, close + 1) {
                                classify_call(
                                    &tokens,
                                    call_open,
                                    false,
                                    self,
                                    owner,
                                    &mut dependencies,
                                );
                            }
                        }
                        Some(Token::String(_)) => {}
                        _ => {
                            self.unknown = true;
                            self.incomplete = true;
                        }
                    }
                }
            }
            let member = index > 0
                && tokens.get(index - 1) == Some(&Token::Punct('.'))
                && !matches!(
                    index.checked_sub(2).and_then(|base| tokens.get(base)),
                    Some(Token::Ident(base)) if matches!(base.as_str(), "window" | "globalThis" | "self")
                );
            if matches!(name.as_str(), "require") && require_resolve_call(&tokens, index) {
                // `require.resolve` is not implemented by the ATools Node bridge.
                // Do not mistake an unsupported resolver call for page Node usage.
                self.unknown = true;
                self.incomplete = true;
            }
            if !member
                && matches!(
                    name.as_str(),
                    "process" | "__dirname" | "__filename" | "module" | "exports"
                )
            {
                // These bare identifiers also occur as object keys, method names,
                // webpack parameters and guarded UMD probes. They are insufficient
                // evidence to start or authorize Node, but make classification uncertain.
                self.unknown = true;
            }
            if self.capture_sources && !member && name == "export" && is_reexport(&tokens, index) {
                self.incomplete = true;
            }
            if !member && name == "require" {
                if let Some(call_open) = call_open(&tokens, index + 1) {
                    classify_call(&tokens, call_open, true, self, owner, &mut dependencies);
                }
            } else if !member && name == "import" {
                if let Some(call_open) = call_open(&tokens, index + 1) {
                    classify_call(&tokens, call_open, false, self, owner, &mut dependencies);
                } else if let Some(Token::String(module)) = tokens.get(index + 1) {
                    self.classify_module(module, owner, false, &mut dependencies);
                } else {
                    for cursor in index + 1..tokens.len().min(index + 32) {
                        if tokens[cursor] == Token::Punct(';') {
                            break;
                        }
                        if tokens[cursor] == Token::Ident("from".into()) {
                            if let Some(Token::String(module)) = tokens.get(cursor + 1) {
                                self.classify_module(module, owner, false, &mut dependencies);
                            } else {
                                self.unknown = true;
                                self.incomplete = true;
                            }
                            break;
                        }
                    }
                }
            }
        }
        if self.node && !self.capture_sources {
            return true;
        }
        for dependency in dependencies {
            if self.inspect_file(dependency, depth + 1) {
                return true;
            }
        }
        false
    }
    fn classify_module(
        &mut self,
        name: &str,
        owner: &Path,
        commonjs: bool,
        dependencies: &mut Vec<PathBuf>,
    ) {
        if self.capture_sources
            && name != "electron"
            && !name.starts_with("./")
            && !name.starts_with("../")
            && !is_selected_builtin(name)
        {
            self.unknown = true;
            self.incomplete = true;
            return;
        }
        if name == "electron" {
            self.electron = true;
        } else if is_node_builtin(name) {
            self.node = true;
        } else if name.starts_with("./") || name.starts_with("../") {
            let Some(parent) = owner.parent() else {
                self.unknown = true;
                self.incomplete = true;
                return;
            };
            let Ok(candidate) = normalize_graph_path(&parent.join(name)) else {
                self.unknown = true;
                self.incomplete = true;
                return;
            };
            let mut candidates = vec![candidate.clone()];
            if candidate.extension().is_none() {
                candidates.extend([
                    candidate.with_extension("js"),
                    candidate.with_extension("cjs"),
                    candidate.with_extension("mjs"),
                    candidate.join("index.js"),
                ]);
            }
            if let Some(found) = candidates.into_iter().find(|path| {
                std::fs::symlink_metadata(self.root.join(path))
                    .is_ok_and(|meta| meta.is_file() && !meta.file_type().is_symlink())
            }) {
                dependencies.push(found);
            } else {
                self.unknown = true;
                self.incomplete = true;
            }
        } else if commonjs && !name.starts_with('#') {
            self.node = true;
        } else if !name.starts_with('#') {
            self.unknown = true;
            self.incomplete = true;
        }
    }
}
