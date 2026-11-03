//! Query length metrics shared by typed regex predicates and result scoring.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct TextMetrics {
    pub(super) utf16_len: usize,
    pub(super) scalar_len: usize,
}

impl TextMetrics {
    pub(super) fn from_str(text: &str) -> Self {
        if text.is_ascii() {
            let len = text.len();
            return Self {
                utf16_len: len,
                scalar_len: len,
            };
        }

        text.chars().fold(
            Self {
                utf16_len: 0,
                scalar_len: 0,
            },
            |mut metrics, scalar| {
                metrics.utf16_len += scalar.len_utf16();
                metrics.scalar_len += 1;
                metrics
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::TextMetrics;

    fn check_against_std(text: &str) {
        let actual = TextMetrics::from_str(text);
        assert_eq!(actual.utf16_len, text.encode_utf16().count());
        assert_eq!(actual.scalar_len, text.chars().count());
    }

    #[test]
    fn metrics_preserve_ascii_bmp_supplementary_and_mixed_lengths() {
        for text in ["", "ascii", "汉字", "😀", "a中😀b"] {
            check_against_std(text);
        }
        let emoji = TextMetrics::from_str("😀");
        assert_eq!(emoji.utf16_len, 2);
        assert_eq!(emoji.scalar_len, 1);
    }
}
