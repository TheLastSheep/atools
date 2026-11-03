//! Text payload matching reuses compiled rules while keeping discovery keywords separate.
use super::{FeatureSearchIndex, IndexedCmd, MatchResult, SCORE_OVER, SCORE_REGEX};

impl FeatureSearchIndex {
    pub const MAX_TEXT_CONTENT_BYTES: usize = 256 * 1024;

    /// ZTools fixed-text rules use JS UTF-16 length, regex flags, and an over upper bound.
    /// No lowercase/pinyin copies, index reconstruction, or plugin execution occur here.
    pub fn search_text_content(&self, text: &str) -> crate::Result<Vec<MatchResult>> {
        validate_text_bytes(text)?;
        if text.is_empty() {
            return Ok(Vec::new());
        }
        let (text_matches, text_metrics) = self.text_regex.matches_with_metrics(text)?;
        let length = text_metrics.utf16_len;
        let mut scored = Vec::new();
        for feature in &self.entries {
            let mut best = None;
            for rule in &feature.cmds {
                let matched = match rule {
                    IndexedCmd::Regex {
                        fixed_pattern: Some(pattern),
                        min_length,
                        ..
                    } if length >= *min_length as usize && text_matches[*pattern] => {
                        Some((SCORE_REGEX, "regex"))
                    }
                    IndexedCmd::Over {
                        min_length,
                        max_length,
                        ..
                    } if length >= *min_length as usize && length <= *max_length as usize => {
                        Some((SCORE_OVER, "over"))
                    }
                    _ => None,
                };
                if let Some((score, kind)) = matched {
                    if best.map_or(true, |(previous, _)| score > previous) {
                        best = Some((score, kind));
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
        scored.sort_unstable_by(|(pa, a), (pb, b)| {
            b.score
                .cmp(&a.score)
                .then_with(|| pb.cmp(pa))
                .then_with(|| a.feature_code.cmp(&b.feature_code))
        });
        Ok(scored.into_iter().map(|(_, result)| result).collect())
    }
}

pub(super) fn validate_text_bytes(text: &str) -> crate::Result<()> {
    if text.len() > FeatureSearchIndex::MAX_TEXT_CONTENT_BYTES {
        return Err(crate::AToolsError::Plugin(format!(
            "TEXT_INPUT_BUDGET: 文本超过{} UTF-8字节，请缩短文本后重试",
            FeatureSearchIndex::MAX_TEXT_CONTENT_BYTES
        )));
    }
    Ok(())
}
