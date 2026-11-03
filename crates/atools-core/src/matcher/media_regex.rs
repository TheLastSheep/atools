//! A bounded compiled bank avoids one cold DFA allocation per files rule during a paste.
use super::media_content::{FilesRule, NamePattern};
use regex::{Regex, RegexBuilder, RegexSet, RegexSetBuilder};
use std::{collections::HashMap, sync::Arc};

#[derive(Clone, Debug)]
pub(super) struct MediaRegexBank {
    patterns: HashMap<String, usize>,
    compiled: Result<CompiledBank, ()>,
}
#[derive(Clone, Debug)]
enum CompiledBank {
    Small(Vec<Regex>),
    Set(RegexSet),
}
impl MediaRegexBank {
    pub(super) fn build<'a>(rules: impl Iterator<Item = &'a Arc<FilesRule>>) -> Self {
        let mut expressions = rules
            .filter_map(|rule| match &rule.pattern {
                Some(NamePattern::Regex { expression, .. }) => Some(expression.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        expressions.sort_unstable();
        expressions.dedup();
        Self::from_expressions(expressions, 8 * 1024 * 1024)
    }
    fn from_expressions(expressions: Vec<String>, program_limit: usize) -> Self {
        let compiled = if expressions.len() <= 8 {
            let divisor = expressions.len().max(1);
            expressions
                .iter()
                .map(|expression| {
                    RegexBuilder::new(expression)
                        .size_limit(program_limit / divisor)
                        .dfa_size_limit(4 * 1024 * 1024 / divisor)
                        .build()
                        .map_err(|_| ())
                })
                .collect::<Result<Vec<_>, _>>()
                .map(CompiledBank::Small)
        } else {
            RegexSetBuilder::new(&expressions)
                .size_limit(program_limit)
                .dfa_size_limit(4 * 1024 * 1024)
                .build()
                .map(CompiledBank::Set)
                .map_err(|_| ())
        };
        Self {
            patterns: expressions
                .into_iter()
                .enumerate()
                .map(|(index, expression)| (expression, index))
                .collect(),
            compiled,
        }
    }
    pub(super) fn pattern_count(&self) -> usize {
        self.patterns.len()
    }
    pub(super) fn match_names(&self, names: &[&str]) -> crate::Result<Vec<bool>> {
        let compiled = self.compiled.as_ref().map_err(|_| {
            crate::AToolsError::Plugin(
                "MEDIA_MATCH_WORK_BUDGET: 文件规则超过8 MiB编译预算，请减少启用的文件规则后重试"
                    .into(),
            )
        })?;
        #[cfg(test)]
        super::media_query_diagnostics::checkpoint("regex_bank_entry");
        match compiled {
            CompiledBank::Small(regexes) => Ok(regexes
                .iter()
                .map(|regex| names.iter().all(|name| regex.is_match(name)))
                .collect()),
            CompiledBank::Set(compiled) => {
                let mut passed = vec![true; self.patterns.len()];
                #[cfg(test)]
                let mut first_name = true;
                for name in names {
                    let matches = compiled.matches(name);
                    #[cfg(test)]
                    if first_name {
                        super::media_query_diagnostics::checkpoint("regex_first_name");
                        first_name = false;
                    }
                    if matches.matched_all() {
                        continue;
                    }
                    for (index, passed) in passed.iter_mut().enumerate() {
                        *passed &= matches.matched(index);
                    }
                }
                #[cfg(test)]
                super::media_query_diagnostics::checkpoint("regex_remaining_names");
                Ok(passed)
            }
        }
    }
    pub(super) fn passed(&self, expression: &str, matches: &[bool]) -> bool {
        self.patterns
            .get(expression)
            .is_some_and(|index| matches.get(*index) == Some(&true))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compiled_program_failure_rejects_whole_query_without_runtime_compilation_or_fallback() {
        let bank = MediaRegexBank::from_expressions(vec!["(?i:^item[0-9]+\\.png$)".into()], 1);
        assert!(bank.compiled.is_err());
        assert!(bank
            .match_names(&["item1.png"])
            .unwrap_err()
            .to_string()
            .contains("MEDIA_MATCH_WORK_BUDGET"));
        assert!(bank.compiled.is_err());
    }
}
