//! ZTools typed text literals have context-specific flags, independent of raw regex APIs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TextContext {
    Ordinary,
    FixedText,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(super) enum EffectivePattern {
    Regex(String),
    /// Exact optimization for unanchored repetitions of JavaScript's any-character class.
    MinLength {
        minimum: usize,
        unicode: bool,
    },
}

/// The official parser uses /^\/(.+)\/([gimuy]*)$/ without trimming or raw fallback.
/// Ordinary mode strips flags before constructing RegExp, including duplicate flags.
pub(super) fn expression(pattern: &str, context: TextContext) -> Option<EffectivePattern> {
    let rest = pattern.strip_prefix('/')?;
    let slash = rest.rfind('/')?;
    let (body, suffix) = rest.split_at(slash);
    let flags = &suffix[1..];
    if body.is_empty()
        || body
            .chars()
            .any(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
        || !flags
            .bytes()
            .all(|f| matches!(f, b'g' | b'i' | b'm' | b'u' | b'y'))
    {
        return None;
    }
    if context == TextContext::FixedText {
        let mut seen = 0u8;
        for flag in flags.bytes() {
            let bit = match flag {
                b'g' => 1,
                b'i' => 2,
                b'm' => 4,
                b'u' => 8,
                b'y' => 16,
                _ => unreachable!(),
            };
            if seen & bit != 0 {
                return None;
            }
            seen |= bit;
        }
    }
    if let Some(minimum) = any_text_minimum(body) {
        return Some(EffectivePattern::MinLength {
            minimum,
            unicode: context == TextContext::FixedText && flags.contains('u'),
        });
    }
    let body = super::typed_text_digits::normalize(
        body,
        context == TextContext::FixedText && flags.contains('u'),
    )?;
    if context == TextContext::Ordinary {
        return Some(EffectivePattern::Regex(body));
    }
    // Stateless searches recreate JS lastIndex=0. Sticky remains anchored even with m.
    let mut enabled = String::new();
    if flags.contains('i') {
        enabled.push('i');
    }
    if flags.contains('m') {
        enabled.push('m');
    }
    let body = if enabled.is_empty() {
        body
    } else {
        format!("(?{enabled}:{body})")
    };
    Some(EffectivePattern::Regex(if flags.contains('y') {
        format!(r"\A(?:{body})")
    } else {
        body
    }))
}

pub(crate) fn has_text_literal(rule: &crate::CmdTyped) -> bool {
    let pattern = match rule.type_ {
        crate::CmdType::Regex => rule.match_.as_deref(),
        crate::CmdType::Over => rule.exclude.as_deref(),
        _ => None,
    };
    pattern.is_some_and(|p| {
        matches!(
            expression(p, TextContext::Ordinary),
            Some(EffectivePattern::Regex(_))
        )
    })
}

/// These entire-source forms are exact length predicates, never arbitrary substring rewrites.
/// An unanchored {n,m} only needs some n-character substring; its upper bound is irrelevant.
/// Only the unbounded full-anchor forms are optimized: bounded `$` has newline subtleties.
fn any_text_minimum(body: &str) -> Option<usize> {
    if matches!(body, r"^[\s\S]*$" | r"^[\S\s]*$") {
        return Some(0);
    }
    if matches!(body, r"^[\s\S]+$" | r"^[\S\s]+$") {
        return Some(1);
    }
    let suffix = body
        .strip_prefix(r"[\s\S]")
        .or_else(|| body.strip_prefix(r"[\S\s]"))?;
    match suffix {
        "" | "+" => Some(1),
        "*" | "?" => Some(0),
        _ => {
            let bounds = suffix.strip_prefix('{')?.strip_suffix('}')?;
            let (min, max) = bounds
                .split_once(',')
                .map_or((bounds, Some(bounds)), |(min, max)| {
                    (min, (!max.is_empty()).then_some(max))
                });
            if min.is_empty() || !min.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let min = min.parse::<usize>().ok()?;
            if let Some(max) = max {
                if max.is_empty()
                    || !max.bytes().all(|b| b.is_ascii_digit())
                    || max.parse::<usize>().ok()? < min
                {
                    return None;
                }
            }
            Some(min)
        }
    }
}
