use std::{collections::HashMap, sync::Arc};

use crate::models::{Cmd, CmdType, FeatureEntry};

use super::{
    match_precomputed_pinyin, to_pinyin_full_lower, to_pinyin_initials_lower, MatchResult,
    SCORE_CONTAINS, SCORE_EXACT, SCORE_OVER, SCORE_PINYIN, SCORE_PREFIX, SCORE_REGEX,
};

/// Pre-indexed feature search structure for ultra-low-latency repeated searches.
#[derive(Debug, Clone)]
pub struct FeatureSearchIndex {
    entries: Vec<IndexedFeature>,
    media_regex: media_regex::MediaRegexBank,
    text_regex: super::typed_text_regex::TypedTextRegexBank,
}

#[derive(Debug, Clone)]
struct IndexedFeature {
    code: String,
    plugin_id: String,
    priority: i32,
    cmds: Vec<IndexedCmd>,
}

#[derive(Debug, Clone)]
enum IndexedCmd {
    Text {
        lower: String,
        is_ascii: bool,
        pinyin_initials: Option<String>,
        pinyin_full: Option<String>,
    },
    Regex {
        ordinary_pattern: Option<usize>,
        fixed_pattern: Option<usize>,
        min_length: u32,
    },
    Over {
        exclude_pattern: Option<usize>,
        min_length: u32,
        max_length: u32,
    },
    Img,
    Files {
        rule: Arc<media_content::FilesRule>,
        min_length: u32,
        max_length: u32,
    },
    Window,
}

impl FeatureSearchIndex {
    /// Build a pre-computed search index from a slice of [`FeatureEntry`] items.
    pub fn build(features: &[FeatureEntry]) -> Self {
        Self::try_build(features).expect(
            "FeatureSearchIndex::build budget exceeded; use try_build for untrusted catalogs",
        )
    }

    /// Fallible construction for installed or otherwise untrusted plugin catalogs.
    pub fn try_build(features: &[FeatureEntry]) -> crate::Result<Self> {
        let text_regex = super::typed_text_regex::TypedTextRegexBank::build(features)?;
        Self::build_with_text_regex(features, text_regex)
    }

    /// Only the catalog supplies this bank, after complete key/budget admission.
    pub(crate) fn build_with_text_regex(
        features: &[FeatureEntry],
        text_regex: super::typed_text_regex::TypedTextRegexBank,
    ) -> crate::Result<Self> {
        let mut file_rules = HashMap::new();
        let entries = features
            .iter()
            .map(|feature| {
                let cmds = feature
                    .cmds
                    .iter()
                    .map(|cmd| match cmd {
                        Cmd::Text(text) => {
                            let is_ascii = text.is_ascii();
                            let lower = if is_ascii {
                                text.to_ascii_lowercase()
                            } else {
                                text.to_lowercase()
                            };
                            let (pinyin_initials, pinyin_full) = if !is_ascii
                                && text.chars().any(|c| !c.is_ascii() && c.is_alphabetic())
                            {
                                (
                                    Some(to_pinyin_initials_lower(text)),
                                    Some(to_pinyin_full_lower(text)),
                                )
                            } else {
                                (None, None)
                            };
                            IndexedCmd::Text {
                                lower,
                                is_ascii,
                                pinyin_initials,
                                pinyin_full,
                            }
                        }
                        Cmd::Typed(typed) => match typed.type_ {
                            CmdType::Regex => IndexedCmd::Regex {
                                ordinary_pattern: text_regex.pattern_id(
                                    typed.match_.as_deref(),
                                    super::typed_text_pattern::TextContext::Ordinary,
                                ),
                                fixed_pattern: text_regex.pattern_id(
                                    typed.match_.as_deref(),
                                    super::typed_text_pattern::TextContext::FixedText,
                                ),
                                min_length: typed.length.unwrap_or(1),
                            },
                            CmdType::Over => IndexedCmd::Over {
                                exclude_pattern: text_regex.pattern_id(
                                    typed.exclude.as_deref(),
                                    super::typed_text_pattern::TextContext::Ordinary,
                                ),
                                min_length: typed.length.unwrap_or(1),
                                max_length: typed.max_length.unwrap_or(10_000),
                            },
                            CmdType::Img => IndexedCmd::Img,
                            CmdType::Files => IndexedCmd::Files {
                                rule: media_content::indexed_rule(typed, &mut file_rules),
                                min_length: typed.length.unwrap_or(1),
                                max_length: typed.max_length.unwrap_or(10_000),
                            },
                            CmdType::Window => IndexedCmd::Window,
                        },
                    })
                    .collect();

                IndexedFeature {
                    code: feature.code.clone(),
                    plugin_id: feature.plugin_id.clone(),
                    priority: feature.priority,
                    cmds,
                }
            })
            .collect();

        let media_regex = media_regex::MediaRegexBank::build(file_rules.values());
        Ok(Self {
            entries,
            media_regex,
            text_regex,
        })
    }

    /// Search the pre-built index with zero per-feature preprocessing allocations.
    pub fn search(&self, query: &str) -> Vec<MatchResult> {
        self.search_checked(query)
            .expect("FeatureSearchIndex::search budget exceeded; use search_checked for user input")
    }

    /// Reject the complete query on budget failure; never return a partial candidate list.
    pub fn search_checked(&self, query: &str) -> crate::Result<Vec<MatchResult>> {
        text_content::validate_text_bytes(query)?;
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let (text_matches, text_metrics) = self.text_regex.matches_with_metrics(query)?;

        let query_lower = if query.is_ascii() {
            query.to_ascii_lowercase()
        } else {
            query.to_lowercase()
        };
        let query_char_len = text_metrics.utf16_len as u32;

        let mut scored: Vec<(i32, MatchResult)> = Vec::new();

        for feature in &self.entries {
            let mut best: Option<(i32, &'static str)> = None;
            for cmd in &feature.cmds {
                let matched = match cmd {
                    IndexedCmd::Text {
                        lower,
                        is_ascii,
                        pinyin_initials,
                        pinyin_full,
                    } => {
                        if lower == &query_lower {
                            Some((SCORE_EXACT, "exact"))
                        } else if lower.starts_with(&query_lower) {
                            Some((SCORE_PREFIX, "prefix"))
                        } else if !*is_ascii
                            && match_precomputed_pinyin(
                                pinyin_initials.as_deref(),
                                pinyin_full.as_deref(),
                                &query_lower,
                            )
                        {
                            Some((SCORE_PINYIN, "pinyin"))
                        } else if lower.contains(&query_lower) {
                            Some((SCORE_CONTAINS, "contains"))
                        } else {
                            None
                        }
                    }
                    IndexedCmd::Regex {
                        ordinary_pattern,
                        min_length,
                        ..
                    } => {
                        if query_char_len >= *min_length
                            && ordinary_pattern.is_some_and(|id| text_matches[id])
                        {
                            Some((SCORE_REGEX, "regex"))
                        } else {
                            None
                        }
                    }
                    IndexedCmd::Over {
                        exclude_pattern,
                        min_length,
                        max_length,
                    } => {
                        if query_char_len >= *min_length
                            && query_char_len <= *max_length
                            && !exclude_pattern.is_some_and(|id| text_matches[id])
                        {
                            Some((SCORE_OVER, "over"))
                        } else {
                            None
                        }
                    }
                    // Files and images require explicit host-validated media context.
                    IndexedCmd::Img | IndexedCmd::Files { .. } => None,
                    IndexedCmd::Window => None,
                };

                if let Some((score, match_type)) = matched {
                    if best.map_or(true, |(best_score, _)| score > best_score) {
                        best = Some((score, match_type));
                        if score == SCORE_EXACT {
                            break;
                        }
                    }
                }
            }

            if let Some((score, match_type)) = best {
                scored.push((
                    feature.priority,
                    MatchResult {
                        feature_code: feature.code.clone(),
                        plugin_id: feature.plugin_id.clone(),
                        score,
                        match_type,
                    },
                ));
            }
        }

        scored.sort_unstable_by(|(prio_a, a), (prio_b, b)| {
            b.score
                .cmp(&a.score)
                .then_with(|| prio_b.cmp(prio_a))
                .then_with(|| a.feature_code.cmp(&b.feature_code))
        });

        Ok(scored.into_iter().map(|(_, res)| res).collect())
    }
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, thread};

    use crate::matcher::search_all;
    use crate::models::{Cmd, CmdType, CmdTyped, FeatureEntry};

    use super::{FeatureSearchIndex, IndexedCmd};

    fn feature(code: &str, cmds: Vec<Cmd>, priority: i32) -> FeatureEntry {
        FeatureEntry {
            code: code.to_owned(),
            plugin_id: "test-plugin".to_owned(),
            plugin_name: "Test Plugin".to_owned(),
            label: code.to_owned(),
            icon: None,
            explain: code.to_owned(),
            cmds,
            main_push: false,
            priority,
        }
    }

    fn regex(pattern: &str) -> Cmd {
        Cmd::Typed(CmdTyped {
            type_: CmdType::Regex,
            label: None,
            match_: Some(pattern.to_owned()),
            length: None,
            max_length: None,
            file_type: None,
            extensions: None,
            exclude: None,
        })
    }

    #[test]
    fn repeated_regex_patterns_share_one_index_cache_but_distinct_patterns_do_not() {
        let index = FeatureSearchIndex::build(&[
            feature("one", vec![regex(r"/^#[0-9a-f]{6}$/i")], 1),
            feature("two", vec![regex(r"/^#[0-9a-f]{6}$/i")], 2),
            feature("other", vec![regex(r"/^#[0-9a-f]{3}$/")], 3),
            feature("invalid-a", vec![regex("[")], 4),
            feature("invalid-b", vec![regex("[")], 5),
        ]);

        let get = |entry_index: usize| match &index.entries[entry_index].cmds[0] {
            IndexedCmd::Regex {
                ordinary_pattern,
                fixed_pattern,
                ..
            } => (*ordinary_pattern, *fixed_pattern),
            _ => panic!("expected regex command"),
        };
        assert_eq!(get(0), get(1));
        assert_ne!(get(0), get(2));
        assert_eq!(get(3), (None, None));
        assert_eq!(get(4), (None, None));
    }

    #[test]
    fn regex_index_preserves_raw_search_results() {
        let features = vec![
            feature("color", vec![regex(r"/^#[0-9a-f]{6}$/i")], 10),
            feature("three", vec![regex(r"/^#[0-9a-f]{3}$/")], 20),
            feature("text", vec![Cmd::Text("clipboard".into())], 30),
        ];
        let index = FeatureSearchIndex::build(&features);
        for query in ["#FF00aa", "#abc", "clipboard", "none", ""] {
            assert_eq!(index.search(query), search_all(&features, query), "{query}");
        }
    }

    #[test]
    fn shared_index_and_its_clones_match_concurrently() {
        let features = (0..32)
            .map(|i| feature(&format!("color-{i}"), vec![regex(r"/^#[0-9a-f]{6}$/i")], i))
            .collect::<Vec<_>>();
        let index = Arc::new(FeatureSearchIndex::build(&features));
        let expected = index.search("#1a2b3c");
        assert_eq!(expected.len(), 32);
        let workers = (0..6)
            .map(|_| {
                let index = Arc::clone(&index);
                let expected = expected.clone();
                thread::spawn(move || {
                    let index_clone = (*index).clone();
                    for _ in 0..50 {
                        for index in [&*index, &index_clone] {
                            match index.search_checked("#1a2b3c") {
                                Ok(actual) => assert_eq!(actual, expected),
                                Err(error) => {
                                    assert!(error.to_string().contains("TYPED_TEXT_SEARCH_BUSY"))
                                }
                            }
                        }
                    }
                    match index.search_checked("invalid") {
                        Ok(actual) => assert!(actual.is_empty()),
                        Err(error) => assert!(error.to_string().contains("TYPED_TEXT_SEARCH_BUSY")),
                    }
                })
            })
            .collect::<Vec<_>>();
        for worker in workers {
            worker.join().expect("search thread should complete");
        }
    }
}

#[path = "text_content.rs"]
mod text_content;

#[path = "media_content.rs"]
mod media_content;
pub use media_content::{
    MediaFile, MAX_MEDIA_FILES, MAX_MEDIA_PATH_BYTES, MAX_MEDIA_PATH_TOTAL_BYTES,
    MAX_MEDIA_RULE_NAME_BYTES, MAX_MEDIA_RULE_NAME_WORK,
};

#[path = "media_regex.rs"]
mod media_regex;

#[cfg(test)]
#[path = "media_query_diagnostics.rs"]
mod media_query_diagnostics;

#[cfg(all(test, target_os = "macos"))]
pub(super) use media_query_diagnostics::{Reading, capture};

pub(crate) use media_content::file_regex_literal_source;
