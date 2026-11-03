//! Typed media content matching; filesystem access remains a host responsibility.
use super::{FeatureSearchIndex, IndexedCmd, MatchResult};
use crate::matcher::{get_or_compile_regex, SCORE_FILES, SCORE_IMG};
use crate::models::CmdTyped;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

pub const MAX_MEDIA_FILES: usize = 1000;
pub const MAX_MEDIA_PATH_BYTES: usize = 8192;
pub const MAX_MEDIA_PATH_TOTAL_BYTES: usize = 256 * 1024;
/// Full-work preflight, not a partial-results limit. Shared predicates count once.
pub const MAX_MEDIA_RULE_NAME_WORK: usize = 8192;
pub const MAX_MEDIA_RULE_NAME_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFile {
    pub path: String,
    pub name: String,
    pub is_file: bool,
    pub is_directory: bool,
}

type RuleKey = (Option<String>, Vec<String>, Option<String>);
#[derive(Debug)]
pub(super) struct FilesRule {
    file_type: Option<String>,
    extensions: Vec<String>,
    pub(super) pattern: Option<NamePattern>,
}
#[derive(Debug)]
pub(super) enum NamePattern {
    Regex { expression: String },
    Literal(String),
}

fn parse_file_literal(pattern: &str) -> Option<(&str, &str)> {
    let (body, flags) = pattern.strip_prefix('/')?.rsplit_once('/')?;
    if body.is_empty()
        || body
            .chars()
            .any(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
    {
        return None;
    }
    let mut seen = 0u8;
    for flag in flags.chars() {
        let bit = match flag {
            'g' => 1,
            'i' => 2,
            'm' => 4,
            'u' => 8,
            'y' => 16,
            _ => return None,
        };
        if seen & bit != 0 {
            return None;
        }
        seen |= bit;
    }
    Some((body, flags))
}
/// Syntax-only reservation check; this preflight never compiles a regex program.
pub(crate) fn file_regex_literal_source(pattern: &str) -> bool {
    parse_file_literal(pattern).is_some()
}

pub(super) fn indexed_rule(
    typed: &CmdTyped,
    cache: &mut HashMap<RuleKey, Arc<FilesRule>>,
) -> Arc<FilesRule> {
    let mut extensions = typed
        .extensions
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|e| e.to_lowercase())
        .collect::<Vec<_>>();
    extensions.sort_unstable();
    extensions.dedup();
    let key = (typed.file_type.clone(), extensions, typed.match_.clone());
    cache
        .entry(key.clone())
        .or_insert_with(|| {
            Arc::new(FilesRule {
                file_type: key.0,
                extensions: key.1,
                pattern: key.2.filter(|p| !p.is_empty()).map(|p| {
                    // Official files parsing recognizes only a nonempty slash literal and gimuy.
                    // Raw or invalid literals are original case-sensitive substrings, not regexes.
                    let compiled = parse_file_literal(&p).and_then(|_| get_or_compile_regex(&p));
                    match compiled {
                        Some(compiled) => {
                            let flags = p.rsplit_once('/').map_or("", |(_, flags)| flags);
                            let modifiers =
                                [('i', flags.contains('i')), ('m', flags.contains('m'))]
                                    .into_iter()
                                    .filter_map(|(flag, on)| on.then_some(flag))
                                    .collect::<String>();
                            let expression = format!("(?{modifiers}:{})", compiled.as_str());
                            NamePattern::Regex { expression }
                        }
                        None => NamePattern::Literal(p),
                    }
                }),
            })
        })
        .clone()
}

pub(super) struct Selection<'a> {
    pub(super) names: Vec<&'a str>,
    extensions: Vec<String>,
    has_files: bool,
    has_directories: bool,
    name_bytes: usize,
}
impl<'a> Selection<'a> {
    fn new(files: &'a [MediaFile]) -> Self {
        let mut names = HashSet::new();
        let mut extensions = HashSet::new();
        for file in files {
            names.insert(file.name.as_str());
            if !file.is_directory {
                extensions.insert(file.name.rsplit('.').next().unwrap_or("").to_lowercase());
            }
        }
        let name_bytes = names.iter().map(|name| name.len()).sum();
        Self {
            names: names.into_iter().collect(),
            extensions: extensions.into_iter().collect(),
            has_files: files.iter().any(|file| file.is_file),
            has_directories: files.iter().any(|file| file.is_directory),
            name_bytes,
        }
    }
}
impl FilesRule {
    fn metadata_matches(&self, selection: &Selection<'_>) -> bool {
        if self.file_type.as_deref() == Some("file") && selection.has_directories {
            return false;
        }
        if self.file_type.as_deref() == Some("directory") && selection.has_files {
            return false;
        }
        self.extensions.is_empty()
            || selection.extensions.iter().all(|extension| {
                !extension.is_empty() && self.extensions.binary_search(extension).is_ok()
            })
    }
    fn names_match(&self, selection: &Selection<'_>) -> bool {
        match &self.pattern {
            Some(NamePattern::Regex { .. }) => false, // Regex rules are exclusively evaluated by the bounded compiled bank.
            Some(NamePattern::Literal(text)) => {
                selection.names.iter().all(|name| name.contains(text))
            }
            None => true,
        }
    }
}

pub fn validate_files(files: &[MediaFile]) -> crate::Result<()> {
    let bytes = files.iter().try_fold(0usize, |total, file| {
        if file.path.is_empty()
            || file.path.len() > MAX_MEDIA_PATH_BYTES
            || file.name.is_empty()
            || file.name.len() > MAX_MEDIA_PATH_BYTES
            || file.is_file == file.is_directory
        {
            return Err(crate::AToolsError::Plugin(
                "Invalid media file metadata".into(),
            ));
        }
        total
            .checked_add(file.path.len())
            .ok_or_else(|| crate::AToolsError::Plugin("File path size overflow".into()))
    })?;
    if files.len() > MAX_MEDIA_FILES || bytes > MAX_MEDIA_PATH_TOTAL_BYTES {
        return Err(crate::AToolsError::Plugin(
            "File content exceeds 1000 files or 256 KiB path budget".into(),
        ));
    }
    Ok(())
}

impl FeatureSearchIndex {
    pub fn search_file_content(&self, files: &[MediaFile]) -> crate::Result<Vec<MatchResult>> {
        #[cfg(test)]
        super::media_query_diagnostics::checkpoint("query_entry");
        validate_files(files)?;
        #[cfg(test)]
        super::media_query_diagnostics::checkpoint("validate");
        if files.is_empty() {
            return Ok(Vec::new());
        }
        let selection = Selection::new(files);
        #[cfg(test)]
        super::media_query_diagnostics::checkpoint("selection");
        let mut rules = HashMap::new();
        // Preflight every eligible unique predicate before evaluating a name or returning a result.
        // A whole-request rejection preserves ranking and the exact selected payload.
        for feature in &self.entries {
            for cmd in &feature.cmds {
                if let IndexedCmd::Files {
                    rule,
                    min_length,
                    max_length,
                } = cmd
                {
                    if files.len() >= *min_length as usize && files.len() <= *max_length as usize {
                        rules
                            .entry(Arc::as_ptr(rule))
                            .or_insert_with(|| (rule, rule.metadata_matches(&selection)));
                    }
                }
            }
        }
        let has_regex = rules.values().any(|(rule, eligible)| {
            *eligible && matches!(rule.pattern, Some(NamePattern::Regex { .. }))
        });
        let literals = rules
            .values()
            .filter(|(rule, eligible)| {
                *eligible && matches!(rule.pattern, Some(NamePattern::Literal(_)))
            })
            .count();
        // A RegexSet evaluates its entire compiled pattern bank; charge the bank rather
        // than claiming only metadata-eligible patterns consume query work.
        let predicates = literals
            + if has_regex {
                self.media_regex.pattern_count()
            } else {
                0
            };
        if predicates.saturating_mul(selection.names.len()) > MAX_MEDIA_RULE_NAME_WORK
            || predicates.saturating_mul(selection.name_bytes) > MAX_MEDIA_RULE_NAME_BYTES
        {
            #[cfg(test)]
            super::media_query_diagnostics::checkpoint("quota_rejection");
            return Err(crate::AToolsError::Plugin("MEDIA_MATCH_WORK_BUDGET: 文件匹配量超过预算，请减少选择的文件或启用的文件规则后重试".into()));
        }
        #[cfg(test)]
        super::media_query_diagnostics::checkpoint("rules_quota");
        let batch = if has_regex {
            Some(self.media_regex.match_names(&selection.names)?)
        } else {
            None
        };
        #[cfg(test)]
        super::media_query_diagnostics::checkpoint("regex_bank_return");
        let evaluated = rules
            .into_iter()
            .map(|(key, (rule, eligible))| {
                let matched = eligible
                    && match &rule.pattern {
                        Some(NamePattern::Regex { expression, .. }) => batch
                            .as_ref()
                            .is_some_and(|matched| self.media_regex.passed(expression, matched)),
                        _ => rule.names_match(&selection),
                    };
                (key, matched)
            })
            .collect::<HashMap<_, _>>();
        #[cfg(test)]
        super::media_query_diagnostics::checkpoint("evaluated_map");
        let matches = self.media_matches(SCORE_FILES, "files", |cmd| match cmd {
            IndexedCmd::Files {
                rule,
                min_length,
                max_length,
            } if files.len() >= *min_length as usize && files.len() <= *max_length as usize => {
                evaluated.get(&Arc::as_ptr(rule)).copied().unwrap_or(false)
            }
            _ => false,
        });
        #[cfg(test)]
        super::media_query_diagnostics::checkpoint("materialize_sort");
        Ok(matches)
    }
    pub fn search_image_content(&self) -> Vec<MatchResult> {
        self.media_matches(SCORE_IMG, "img", |cmd| matches!(cmd, IndexedCmd::Img))
    }
    fn media_matches(
        &self,
        score: i32,
        kind: &'static str,
        mut matches: impl FnMut(&IndexedCmd) -> bool,
    ) -> Vec<MatchResult> {
        let mut scored = self
            .entries
            .iter()
            .filter(|feature| feature.cmds.iter().any(&mut matches))
            .map(|feature| {
                (
                    feature.priority,
                    MatchResult {
                        feature_code: feature.code.clone(),
                        plugin_id: feature.plugin_id.clone(),
                        score,
                        match_type: kind,
                    },
                )
            })
            .collect::<Vec<_>>();
        scored.sort_unstable_by(|(pa, a), (pb, b)| {
            b.score
                .cmp(&a.score)
                .then_with(|| pb.cmp(pa))
                .then_with(|| a.feature_code.cmp(&b.feature_code))
        });
        scored.into_iter().map(|(_, result)| result).collect()
    }
}
