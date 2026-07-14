//! Feature matching engine for ATools.
//!
//! Provides utilities to match user input against plugin feature commands,
//! supporting text matching, pinyin abbreviations, regex patterns, and
//! length-based triggers.

use crate::models::{Cmd, CmdType, FeatureEntry};

/// Scoring constants for different match types.
pub const SCORE_EXACT: i32 = 100;
pub const SCORE_PREFIX: i32 = 90;
pub const SCORE_REGEX: i32 = 80;
pub const SCORE_OVER: i32 = 60;
pub const SCORE_CONTAINS: i32 = 50;
pub const SCORE_PINYIN: i32 = 30;

/// Match result containing scoring information.
#[derive(Debug, Clone)]
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

/// Search all features and return match results sorted by score.
pub fn search_all(features: &[FeatureEntry], query: &str) -> Vec<MatchResult> {
    if query.is_empty() {
        return Vec::new();
    }

    let query_lower = query.to_lowercase();
    let mut matches: Vec<MatchResult> = features
        .iter()
        .filter_map(|feature| match_feature(&query_lower, feature))
        .collect();

    // Sort by score (descending), then by priority (descending), then alphabetically
    matches.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.feature_code.cmp(&b.feature_code))
    });

    matches
}

/// Match query against a single feature entry.
fn match_feature(query: &str, feature: &FeatureEntry) -> Option<MatchResult> {
    let mut best_match: Option<MatchResult> = None;

    for cmd in &feature.cmds {
        if let Some((score, match_type)) = cmd_match_query(query, cmd) {
            let result = MatchResult {
                feature_code: feature.code.clone(),
                plugin_id: feature.plugin_id.clone(),
                score,
                match_type,
            };

            best_match = Some(match best_match {
                Some(existing) if existing.score >= score => existing,
                _ => result,
            });
        }
    }

    best_match
}

/// Check if a query matches a specific command.
/// Returns (score, match_type) if matched.
fn cmd_match_query(query: &str, cmd: &Cmd) -> Option<(i32, &'static str)> {
    match cmd {
        Cmd::Text(text) => {
            let text_lower = text.to_lowercase();

            // Exact match: score 100
            if text_lower == query {
                return Some((SCORE_EXACT, "exact"));
            }

            // Prefix match: score 90
            if text_lower.starts_with(query) {
                return Some((SCORE_PREFIX, "prefix"));
            }

            // Pinyin match for Chinese characters: score 30
            if text.chars().any(|c| !c.is_ascii() && c.is_alphabetic()) {
                if let Some(pinyin_match) = try_pinyin_match(text, query) {
                    return Some(pinyin_match);
                }
            }

            // Contains match: score 50
            if text_lower.contains(query) {
                return Some((SCORE_CONTAINS, "contains"));
            }

            None
        }
        Cmd::Typed(typed) => match typed.type_ {
            CmdType::Regex => {
                if let Some(pattern) = &typed.match_ {
                    if let Ok(re) = regex::Regex::new(pattern) {
                        if re.is_match(query) {
                            return Some((SCORE_REGEX, "regex"));
                        }
                    }
                }
                None
            }
            CmdType::Over => {
                if let Some(len) = typed.length {
                    if query.len() as u32 >= len {
                        return Some((SCORE_OVER, "over"));
                    }
                }
                None
            }
            CmdType::Img | CmdType::Files | CmdType::Window => {
                // These types require specialized matching logic (file paths, images, etc.)
                // For now, return None
                None
            }
        },
    }
}

/// Try to match query against pinyin abbreviation of Chinese text.
fn try_pinyin_match(text: &str, query: &str) -> Option<(i32, &'static str)> {
    let pinyin = to_pinyin_initials(text);
    let pinyin_lower = pinyin.to_lowercase();
    let query_lower = query.to_lowercase();

    if pinyin_lower.starts_with(&query_lower) {
        Some((SCORE_PINYIN, "pinyin"))
    } else {
        None
    }
}

/// Convert Chinese characters to their pinyin initials.
/// Example: "天气查询" -> "tqcx"
pub fn to_pinyin_initials(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_ascii() {
                c
            } else {
                pinyin_initial_from_char(c)
            }
        })
        .collect()
}

/// Get pinyin initial from a single Chinese character.
/// This is a simplified lookup table for ~300 common characters covering all 26 initials.
fn pinyin_initial_from_char(c: char) -> char {
    // Use a HashMap-based lookup for better performance and correctness
    use std::collections::HashMap;
    use std::sync::OnceLock;

    static PINYIN_MAP: OnceLock<HashMap<char, char>> = OnceLock::new();

    let map = PINYIN_MAP.get_or_init(|| {
        let mut m = HashMap::new();

        // Helper function to add chars for an initial
        let mut add_chars = |initial: char, chars: &[char]| {
            for &ch in chars {
                m.insert(ch, initial);
            }
        };

        add_chars('a', &['阿', '爱', '安', '暗', '按', '奥', '案', '傲']);
        add_chars(
            'b',
            &[
                '八', '把', '百', '办', '包', '报', '被', '本', '比', '边', '不', '步',
            ],
        );
        add_chars(
            'c',
            &[
                '擦', '才', '草', '层', '查', '常', '成', '出', '处', '春', '此', '从',
            ],
        );
        add_chars(
            'd',
            &[
                '大', '打', '代', '带', '单', '当', '到', '的', '得', '等', '地', '点', '定', '东',
                '动', '都', '读', '度', '多',
            ],
        );
        add_chars('e', &['额', '而', '儿', '二', '耳', '恶', '恩', '饿']);
        add_chars(
            'f',
            &[
                '发', '法', '反', '方', '房', '放', '非', '分', '风', '夫', '服', '福', '父', '复',
                '副', '翻',
            ],
        );
        add_chars(
            'g',
            &[
                '该', '改', '干', '感', '刚', '高', '告', '哥', '个', '给', '根', '更', '工', '公',
                '功', '共', '古', '故', '关', '国', '过',
            ],
        );
        add_chars(
            'h',
            &[
                '还', '孩', '海', '含', '好', '号', '和', '河', '很', '红', '后', '候', '呼', '花',
                '华', '化', '话', '欢', '回', '会', '活', '火',
            ],
        );
        add_chars(
            'j',
            &[
                '家', '加', '价', '间', '见', '江', '将', '教', '接', '街', '节', '结', '解', '今',
                '金', '进', '近', '经', '九', '就', '旧', '军',
            ],
        );
        add_chars(
            'k',
            &[
                '开', '看', '考', '科', '可', '课', '克', '客', '空', '口', '快', '况',
            ],
        );
        add_chars(
            'l',
            &[
                '来', '老', '乐', '了', '类', '冷', '离', '里', '理', '力', '立', '利', '连', '两',
                '林', '领', '六', '路', '绿', '论',
            ],
        );
        add_chars(
            'm',
            &[
                '妈', '马', '买', '满', '毛', '么', '没', '每', '美', '门', '们', '米', '面', '名',
                '明', '母', '木', '目',
            ],
        );
        add_chars(
            'n',
            &[
                '拿', '那', '男', '南', '难', '内', '能', '你', '年', '念', '农', '女',
            ],
        );
        add_chars('o', &['哦', '欧', '偶']);
        add_chars(
            'p',
            &['爬', '怕', '排', '旁', '跑', '朋', '皮', '片', '平', '普'],
        );
        add_chars(
            'q',
            &[
                '七', '其', '起', '气', '前', '钱', '强', '亲', '青', '清', '情', '请', '去', '全',
                '却',
            ],
        );
        add_chars('r', &['然', '让', '热', '人', '认', '任', '日', '如', '入']);
        add_chars(
            's',
            &[
                '三', '色', '山', '上', '少', '身', '什', '生', '声', '十', '时', '实', '事', '市',
                '世', '是', '手', '书', '说', '四', '送', '所', '岁',
            ],
        );
        add_chars(
            't',
            &['他', '她', '它', '太', '天', '条', '同', '头', '土', '推'],
        );
        add_chars(
            'w',
            &[
                '外', '万', '王', '往', '望', '为', '位', '文', '问', '我', '五', '无', '物',
            ],
        );
        add_chars(
            'x',
            &[
                '西', '希', '习', '洗', '喜', '下', '先', '现', '想', '向', '小', '笑', '写', '些',
                '心', '新', '信', '行', '学', '雪',
            ],
        );
        add_chars(
            'y',
            &[
                '呀', '压', '牙', '眼', '样', '要', '也', '业', '一', '以', '意', '因', '应', '用',
                '有', '又', '右', '于', '与', '元', '员', '远', '月', '云', '译',
            ],
        );
        add_chars(
            'z',
            &[
                '在', '再', '早', '怎', '造', '站', '张', '找', '这', '真', '正', '整', '知', '只',
                '中', '种', '重', '主', '住', '自', '字', '走', '最', '做', '作', '坐',
            ],
        );

        m
    });

    *map.get(&c).unwrap_or(&c)
}

#[cfg(test)]
mod pinyin_tests {
    use super::*;

    #[test]
    fn test_pinyin_initials() {
        assert!(!to_pinyin_initials("你好").is_empty());
        assert!(!to_pinyin_initials("天气").is_empty());
    }

    #[test]
    fn test_pinyin_initial_from_char() {
        let initial = pinyin_initial_from_char('你');
        assert!(initial.is_ascii());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CmdTyped, FeatureEntry};

    fn make_feature(code: &str, cmds: Vec<Cmd>, priority: i32) -> FeatureEntry {
        FeatureEntry {
            code: code.to_string(),
            plugin_id: "test-plugin".to_string(),
            plugin_name: "Test Plugin".to_string(),
            label: code.to_string(),
            icon: None,
            explain: format!("Feature {}", code),
            cmds,
            main_push: false,
            priority,
        }
    }

    #[test]
    fn test_search_all_exact_match() {
        let features = vec![
            make_feature("calc", vec![Cmd::Text("calculator".to_string())], 10),
            make_feature("weather", vec![Cmd::Text("weather".to_string())], 5),
        ];

        let matches = search_all(&features, "calculator");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].feature_code, "calc");
        assert_eq!(matches[0].score, 100);
        assert_eq!(matches[0].match_type, "exact");
    }

    #[test]
    fn test_search_all_prefix_match() {
        let features = vec![make_feature(
            "calc",
            vec![Cmd::Text("calculator".to_string())],
            10,
        )];

        let matches = search_all(&features, "calc");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].score, 90);
        assert_eq!(matches[0].match_type, "prefix");
    }

    #[test]
    fn test_search_all_contains_match() {
        let features = vec![make_feature(
            "calc",
            vec![Cmd::Text("calculator".to_string())],
            10,
        )];

        let matches = search_all(&features, "cula");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].score, 50);
        assert_eq!(matches[0].match_type, "contains");
    }

    #[test]
    fn test_search_all_no_match() {
        let features = vec![make_feature(
            "calc",
            vec![Cmd::Text("calculator".to_string())],
            10,
        )];

        let matches = search_all(&features, "xyz");
        assert_eq!(matches.len(), 0);
    }

    #[test]
    fn test_search_all_regex_match() {
        let features = vec![make_feature(
            "color",
            vec![Cmd::Typed(CmdTyped {
                type_: CmdType::Regex,
                label: None,
                match_: Some(r"^#[0-9a-fA-F]{6}$".to_string()),
                length: None,
            })],
            10,
        )];

        let matches = search_all(&features, "#ff0000");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].score, 80);
        assert_eq!(matches[0].match_type, "regex");
    }

    #[test]
    fn test_search_all_over_match() {
        let features = vec![make_feature(
            "long-query",
            vec![Cmd::Typed(CmdTyped {
                type_: CmdType::Over,
                label: None,
                match_: None,
                length: Some(10),
            })],
            10,
        )];

        let matches = search_all(&features, "short");
        assert_eq!(matches.len(), 0);

        let matches = search_all(&features, "this is a very long query");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].score, 60);
        assert_eq!(matches[0].match_type, "over");
    }

    #[test]
    fn test_search_all_empty_query() {
        let features = vec![make_feature(
            "calc",
            vec![Cmd::Text("calculator".to_string())],
            10,
        )];

        let matches = search_all(&features, "");
        assert_eq!(matches.len(), 0);
    }
}
