//! Immutable search data and human presentation, independent of execution identities.
use crate::{Cmd, FeatureEntry, FeatureSearchIndex, MatchResult};
use std::{collections::HashMap, mem::size_of};

pub const MAX_FEATURE_CATALOG_FEATURES: usize = 20_000;
pub const MAX_FEATURE_CATALOG_COMMANDS: usize = 65_536;
pub const MAX_FEATURE_CATALOG_METADATA_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_FEATURE_CATALOG_INDEX_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug)]
pub struct CatalogFeature {
    /// The original matcher input, including its unmodified commands and label.
    pub feature: FeatureEntry,
    pub display_label: String,
    pub label_source: &'static str,
    pub plugin_display_name: String,
    pub plugin_path: String,
    /// Unresolved feature icon or manifest logo. The desktop resolves it once per snapshot.
    pub icon: Option<String>,
}

#[derive(Debug)]
pub struct FeatureCatalogSnapshot {
    pub generation: u64,
    pub metadata_bytes: usize,
    /// Conservative owned index-data allowance including typed-text and media regex banks.
    pub index_budget_bytes: usize,
    entries: Vec<CatalogFeature>,
    by_plugin: HashMap<String, HashMap<String, usize>>,
    index: FeatureSearchIndex,
    discovery_index: FeatureSearchIndex,
}

impl FeatureCatalogSnapshot {
    pub(crate) fn build(
        generation: u64,
        entries: Vec<CatalogFeature>,
        metadata_bytes: usize,
        text_regex: crate::matcher::TypedTextRegexBank,
    ) -> crate::Result<Self> {
        let index_budget_bytes = validate_admitted_index_budget(&entries, &text_regex)?;
        let discovery = entries
            .iter()
            .filter_map(discovery_entry)
            .collect::<Vec<_>>();
        // Build from raw entries: presentation cannot change command matching or ranking.
        let raw = entries
            .iter()
            .map(|entry| entry.feature.clone())
            .collect::<Vec<_>>();
        let index = FeatureSearchIndex::build_with_text_regex(&raw, text_regex)?;
        let discovery_index = FeatureSearchIndex::try_build(&discovery)?;
        let mut by_plugin: HashMap<String, HashMap<String, usize>> = HashMap::new();
        for (position, entry) in entries.iter().enumerate() {
            by_plugin
                .entry(entry.feature.plugin_id.clone())
                .or_default()
                .insert(entry.feature.code.clone(), position);
        }
        Ok(Self {
            generation,
            metadata_bytes,
            index_budget_bytes,
            entries,
            by_plugin,
            index,
            discovery_index,
        })
    }

    pub fn entries(&self) -> &[CatalogFeature] {
        &self.entries
    }
    pub fn find(&self, plugin_id: &str, code: &str) -> Option<&CatalogFeature> {
        let position = self.by_plugin.get(plugin_id)?.get(code)?;
        self.entries.get(*position)
    }
    /// Match declared commands for execution without presentation-name discovery.
    pub fn search_commands_checked(&self, query: &str) -> crate::Result<Vec<MatchResult>> {
        self.index.search_checked(query)
    }
    /// Match a fixed original text only against typed rules, excluding discovery names.
    pub fn search_text_content(&self, text: &str) -> crate::Result<Vec<MatchResult>> {
        self.index.search_text_content(text)
    }
    /// Match a host-validated, ordered file selection against cached files-only rules.
    pub fn search_file_content(
        &self,
        files: &[crate::matcher::MediaFile],
    ) -> crate::Result<Vec<MatchResult>> {
        self.index.search_file_content(files)
    }
    pub fn search_image_content(&self) -> Vec<MatchResult> {
        self.index.search_image_content()
    }
    /// Convenience for bounded test/legacy inputs; user-facing paths use search_checked.
    pub fn search(&self, query: &str) -> Vec<MatchResult> {
        self.search_checked(query)
            .expect("Feature catalog query budget exceeded; use search_checked for user input")
    }
    pub fn search_checked(&self, query: &str) -> crate::Result<Vec<MatchResult>> {
        let mut results = self.index.search_checked(query)?;
        let mut seen = results
            .iter()
            .enumerate()
            .filter_map(|(index, item)| {
                self.position(&item.plugin_id, &item.feature_code)
                    .map(|position| (position, index))
            })
            .collect::<std::collections::HashMap<_, _>>();
        for matched in self.discovery_index.search_checked(query)? {
            if let Some(position) = self.position(&matched.plugin_id, &matched.feature_code) {
                if let Some(index) = seen.get(&position) {
                    if matched.score > results[*index].score {
                        results[*index] = matched;
                    }
                } else {
                    seen.insert(position, results.len());
                    results.push(matched);
                }
            }
        }
        // Better/tied original command matches retain their score/type. Human
        // names can improve discovery without duplicate-term score boosts.
        results.sort_unstable_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then_with(|| self.priority(b).cmp(&self.priority(a)))
                .then_with(|| a.feature_code.cmp(&b.feature_code))
        });
        Ok(results)
    }
    fn position(&self, plugin: &str, code: &str) -> Option<usize> {
        self.by_plugin.get(plugin)?.get(code).copied()
    }
    fn priority(&self, item: &MatchResult) -> i32 {
        self.find(&item.plugin_id, &item.feature_code)
            .map_or(0, |entry| entry.feature.priority)
    }
}

/// Exact owned-data allowance shared by snapshot construction and write preflight.
/// This does not build matcher indexes, expand pinyin, or compile regex programs.
pub(crate) fn validate_index_budget(entries: &[CatalogFeature]) -> crate::Result<usize> {
    let mut bytes = entries.iter().try_fold(0usize, |total, item| {
        total
            .checked_add(index_allowance(&item.feature))
            .ok_or_else(|| budget_error("index size overflow"))
    })?;
    for entry in entries {
        if let Some(discovery) = discovery_entry(entry) {
            bytes = bytes.saturating_add(index_allowance(&discovery));
        }
    }
    // A files regex bank has strict 8 MiB compiled-program / 4 MiB lazy-DFA
    // limits. Reserve its entire allowance within the existing 32 MiB cap.
    if entries.iter().any(|entry|entry.feature.cmds.iter().any(|cmd|matches!(cmd,Cmd::Typed(rule) if rule.type_==crate::CmdType::Files && rule.match_.as_deref().is_some_and(crate::matcher::file_regex_literal_source)))) {
        bytes=bytes.saturating_add(12*1024*1024);
    }
    if entries.iter().any(|entry| {
        entry
            .feature
            .cmds
            .iter()
            .any(|cmd| matches!(cmd, Cmd::Typed(rule) if crate::matcher::has_text_literal(rule)))
    }) {
        bytes = bytes.saturating_add(crate::matcher::TEXT_REGEX_ALLOWANCE_BYTES);
    }
    if bytes > MAX_FEATURE_CATALOG_INDEX_BYTES {
        return Err(budget_error(
            "search index exceeds 32 MiB owned-data allowance",
        ));
    }
    Ok(bytes)
}

/// Retained unsupported normalization keys are additional catalog state, not free cache data.
pub(crate) fn validate_admitted_index_budget(
    entries: &[CatalogFeature],
    text_regex: &crate::matcher::TypedTextRegexBank,
) -> crate::Result<usize> {
    let bytes = validate_index_budget(entries)?.saturating_add(text_regex.unsupported_key_bytes());
    if bytes > MAX_FEATURE_CATALOG_INDEX_BYTES {
        return Err(budget_error(
            "search index exceeds 32 MiB owned-data allowance",
        ));
    }
    Ok(bytes)
}

fn discovery_entry(entry: &CatalogFeature) -> Option<FeatureEntry> {
    let mut terms: Vec<String> = Vec::new();
    for term in [&entry.display_label, &entry.plugin_display_name] {
        let term = term.trim();
        if term.is_empty() {
            continue;
        }
        let lower = term.to_lowercase();
        if terms.iter().any(|prior| prior.to_lowercase() == lower)
            || entry
                .feature
                .cmds
                .iter()
                .any(|cmd| matches!(cmd, Cmd::Text(text) if text.trim().to_lowercase() == lower))
        {
            continue;
        }
        terms.push(term.to_string());
    }
    if terms.is_empty() {
        return None;
    }
    Some(FeatureEntry {
        code: entry.feature.code.clone(),
        plugin_id: entry.feature.plugin_id.clone(),
        priority: entry.feature.priority,
        cmds: terms.into_iter().map(Cmd::Text).collect(),
        plugin_name: String::new(),
        label: String::new(),
        icon: None,
        explain: String::new(),
        main_push: entry.feature.main_push,
    })
}

pub(crate) fn budget_error(message: &str) -> crate::AToolsError {
    crate::AToolsError::Plugin(format!("Feature catalog budget exceeded: {message}"))
}

fn index_allowance(feature: &FeatureEntry) -> usize {
    // Includes lookup keys, vectors, lowercase strings, and worst-case pinyin expansion.
    // Compiled typed text/media banks are separately reserved above within the same cap.
    let base =
        size_of::<FeatureEntry>() + 256 + feature.code.len() * 2 + feature.plugin_id.len() * 2;
    feature.cmds.iter().fold(base, |total, cmd| {
        total.saturating_add(
            128 + match cmd {
                Cmd::Text(text) => text.len().saturating_mul(16),
                Cmd::Typed(typed) => typed
                    .match_
                    .as_ref()
                    .map_or(0, |p| p.len().saturating_mul(16))
                    .saturating_add(
                        typed
                            .exclude
                            .as_ref()
                            .map_or(0, |p| p.len().saturating_mul(16)),
                    )
                    .saturating_add(
                        typed
                            .file_type
                            .as_ref()
                            .map_or(0, |kind| kind.len().saturating_mul(4)),
                    )
                    .saturating_add(typed.extensions.as_ref().map_or(0, |items| {
                        items.iter().fold(0usize, |sum, ext| {
                            sum.saturating_add(64 + ext.len().saturating_mul(4))
                        })
                    })),
            },
        )
    })
}
