//! Feature matching engine for ATools.
//!
//! Provides high-performance utilities to match user input against plugin feature commands,
//! supporting zero-allocation ASCII fast-paths, full 20,902+ CJK pinyin initials and full
//! pinyin (`quanpin`), cached JS/Rust regex patterns, and pre-indexed `FeatureSearchIndex`.

use std::collections::HashMap;

use once_cell::sync::Lazy;
use parking_lot::RwLock;
use pinyin::ToPinyin;
use regex::{Regex, RegexBuilder};

use crate::models::FeatureEntry;

/// Scoring constants for different match types.
pub const SCORE_EXACT: i32 = 100;
pub const SCORE_PREFIX: i32 = 90;
pub const SCORE_REGEX: i32 = 80;
pub const SCORE_IMG: i32 = 75;
pub const SCORE_FILES: i32 = 70;
pub const SCORE_OVER: i32 = 60;
pub const SCORE_CONTAINS: i32 = 50;
pub const SCORE_PINYIN: i32 = 30;

mod index;
pub use index::{
    FeatureSearchIndex, MediaFile, MAX_MEDIA_FILES, MAX_MEDIA_PATH_BYTES,
    MAX_MEDIA_PATH_TOTAL_BYTES, MAX_MEDIA_RULE_NAME_BYTES, MAX_MEDIA_RULE_NAME_WORK,
};

const MAX_REGEX_CACHE_ENTRIES: usize = 2048;

static REGEX_CACHE: Lazy<RwLock<HashMap<String, Option<Regex>>>> =
    Lazy::new(|| RwLock::new(HashMap::with_capacity(256)));

/// Match result containing scoring information.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchResult {
    /// The feature code that matched.
    pub feature_code: String,
    /// The plugin ID that owns the feature.
    pub plugin_id: String,
    /// Match confidence score (higher = better match).
    pub score: i32,
    /// Type of match that occurred.
    pub match_type: &'static str,
}

#[cfg(test)]
mod tests;

/// Search all features and return match results sorted by score (descending),
/// then feature priority (descending), then feature code (ascending).
pub fn search_all(features: &[FeatureEntry], query: &str) -> Vec<MatchResult> {
    search_all_checked(features, query)
        .expect("search_all budget exceeded; use search_all_checked for untrusted catalogs/input")
}

/// Fallible convenience search. Repeated user searches should retain a prebuilt index.
pub fn search_all_checked(
    features: &[FeatureEntry],
    query: &str,
) -> crate::Result<Vec<MatchResult>> {
    FeatureSearchIndex::try_build(features)?.search_checked(query)
}

mod typed_text_bank_key;
mod typed_text_digits;
mod typed_text_metrics;
mod typed_text_pattern;
mod typed_text_prepare;
mod typed_text_regex;

#[cfg(all(test, target_os = "macos"))]
#[path = "matcher/query_cpu_diagnostics.rs"]
mod query_cpu_diagnostics;
pub(crate) use typed_text_pattern::has_text_literal;
#[cfg(test)]
pub(crate) use typed_text_regex::compile_count as typed_text_compile_count;
pub use typed_text_regex::MAX_TYPED_TEXT_REGEX_WORK;
pub(crate) use typed_text_regex::{TypedTextRegexBank, TEXT_REGEX_ALLOWANCE_BYTES};

/// Compile or retrieve a cached [`Regex`], supporting both raw Rust regex patterns
/// and JavaScript `/pattern/flags` regex literals used across ZTools plugins.
fn get_or_compile_regex(pattern: &str) -> Option<Regex> {
    if let Some(cached) = REGEX_CACHE.read().get(pattern) {
        return cached.clone();
    }

    let compiled = compile_ztools_regex(pattern);
    let mut cache = REGEX_CACHE.write();
    if cache.len() >= MAX_REGEX_CACHE_ENTRIES {
        cache.clear();
    }
    cache.insert(pattern.to_string(), compiled.clone());
    compiled
}

fn compile_ztools_regex(pattern: &str) -> Option<Regex> {
    let trimmed = pattern.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some(rest) = trimmed.strip_prefix('/') {
        if let Some(last_slash) = rest.rfind('/') {
            let body = &rest[..last_slash];
            let flags = &rest[last_slash + 1..];
            if flags
                .chars()
                .all(|f| matches!(f, 'i' | 'g' | 'm' | 's' | 'u' | 'y' | 'x'))
            {
                // Each ZTools query starts a fresh JS regexp at lastIndex=0.
                // Sticky matching must start at zero even when multiline is enabled.
                let anchored;
                let body = if flags.contains('y') {
                    anchored = format!(r"\A(?:{body})");
                    anchored.as_str()
                } else {
                    body
                };
                let mut builder = RegexBuilder::new(body);
                builder.case_insensitive(flags.contains('i'));
                builder.multi_line(flags.contains('m'));
                builder.dot_matches_new_line(flags.contains('s'));
                builder.ignore_whitespace(flags.contains('x'));
                if let Ok(re) = builder.build() {
                    return Some(re);
                }
            }
        }
    }

    Regex::new(trimmed).ok()
}

#[inline]
fn match_precomputed_pinyin(
    initials: Option<&str>,
    full_pinyin: Option<&str>,
    query_lower: &str,
) -> bool {
    if let Some(init) = initials {
        if init.starts_with(query_lower) {
            return true;
        }
    }
    if query_lower.len() >= 2 {
        if let Some(full) = full_pinyin {
            if full.starts_with(query_lower) {
                return true;
            }
        }
    }
    false
}

/// Convert Chinese characters to their pinyin initials (covers 20,902+ CJK characters).
/// Example: `"天气查询"` -> `"tqcx"`, `"Paste剪切板"` -> `"Pastejqb"`.
pub fn to_pinyin_initials(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if c.is_ascii() {
            out.push(c);
        } else {
            out.push(pinyin_initial_from_char(c));
        }
    }
    out
}

/// Convert Chinese characters to their full toneless pinyin (`quanpin`).
/// Example: `"剪贴板"` -> `"jiantieban"`.
pub fn to_pinyin_full(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    for c in text.chars() {
        if c.is_ascii() {
            out.push(c);
        } else if let Some(py) = c.to_pinyin() {
            out.push_str(py.plain());
        } else {
            out.push(c);
        }
    }
    out
}

fn to_pinyin_initials_lower(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if c.is_ascii() {
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(pinyin_initial_from_char(c).to_ascii_lowercase());
        }
    }
    out
}

fn to_pinyin_full_lower(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    for c in text.chars() {
        if c.is_ascii() {
            out.push(c.to_ascii_lowercase());
        } else if let Some(py) = c.to_pinyin() {
            out.push_str(py.plain());
        } else {
            for lc in c.to_lowercase() {
                out.push(lc);
            }
        }
    }
    out
}

/// Get pinyin initial from a single Chinese character in $O(1)$ time via the static CJK table.
#[inline]
fn pinyin_initial_from_char(c: char) -> char {
    if let Some(py) = c.to_pinyin() {
        if let Some(first) = py.plain().chars().next() {
            return first;
        }
    }
    c
}

#[cfg(test)]
mod pinyin_tests {
    use super::*;

    #[test]
    fn test_pinyin_initials() {
        assert_eq!(to_pinyin_initials("你好"), "nh");
        assert_eq!(to_pinyin_initials("天气"), "tq");
        assert_eq!(to_pinyin_initials("剪贴板"), "jtb");
        assert_eq!(to_pinyin_full("剪贴板"), "jiantieban");
    }

    #[test]
    fn test_pinyin_initial_from_char() {
        let initial = pinyin_initial_from_char('你');
        assert_eq!(initial, 'n');
        assert_eq!(pinyin_initial_from_char('剪'), 'j');
    }
}

pub(crate) use index::file_regex_literal_source;
