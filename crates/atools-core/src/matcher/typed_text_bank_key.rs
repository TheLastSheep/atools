//! Canonical expression sets are independent of feature identity and presentation.
use super::typed_text_pattern::{expression, EffectivePattern, TextContext};
use crate::{Cmd, CmdType};

#[cfg(test)]
thread_local! { static SYNTAX_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }
#[cfg(test)]
pub(crate) fn syntax_count() -> usize {
    SYNTAX_COUNT.with(std::cell::Cell::get)
}

pub(super) fn expressions<'a>(commands: impl Iterator<Item = &'a Cmd>) -> Vec<EffectivePattern> {
    let mut expressions = Vec::new();
    for command in commands {
        let Cmd::Typed(rule) = command else { continue };
        match rule.type_ {
            CmdType::Regex => {
                if let Some(pattern) = &rule.match_ {
                    expressions.extend(
                        [TextContext::Ordinary, TextContext::FixedText]
                            .into_iter()
                            .filter_map(|mode| expression(pattern, mode)),
                    );
                }
            }
            CmdType::Over => {
                if let Some(pattern) = &rule.exclude {
                    expressions.extend(expression(pattern, TextContext::Ordinary));
                }
            }
            _ => {}
        }
    }
    expressions.sort_unstable();
    expressions.dedup();
    expressions
}

pub(super) fn retain_supported(
    expressions: &mut Vec<EffectivePattern>,
    known: impl Fn(&EffectivePattern) -> Option<bool>,
) -> Vec<EffectivePattern> {
    // HIR validation is needed only when the complete normalized set differs.
    // Unsupported JS constructs preserve the existing adapter's ignored subset.
    let mut unsupported = Vec::new();
    expressions.retain(|pattern| {
        let supported = known(pattern).unwrap_or_else(|| match pattern {
            EffectivePattern::Regex(pattern) => {
                #[cfg(test)]
                SYNTAX_COUNT.with(|count| count.set(count.get() + 1));
                regex_syntax::Parser::new().parse(pattern).is_ok()
            }
            EffectivePattern::MinLength { .. } => true,
        });
        if !supported {
            unsupported.push(pattern.clone());
        }
        supported
    });
    unsupported
}
