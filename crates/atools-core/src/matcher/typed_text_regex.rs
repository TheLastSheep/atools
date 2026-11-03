//! Bounded typed text programs plus exact length predicates; never query-time compilation.
use super::typed_text_pattern::{expression, EffectivePattern, TextContext};
use super::typed_text_metrics::TextMetrics;
use crate::{Cmd, FeatureEntry};
use regex_automata::{meta, nfa::thompson::WhichCaptures, Input, MatchKind, PatternID, PatternSet};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, TryLockError},
};

#[cfg(test)]
thread_local! { static COMPILE_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }
#[cfg(test)]
pub(crate) fn compile_count() -> usize {
    COMPILE_COUNT.with(std::cell::Cell::get)
}
#[cfg(test)]
fn profile(phase: &str, started: std::time::Instant) {
    if std::env::var_os("ATOOLS_TYPED_TEXT_PROFILE").is_some() {
        eprintln!(
            "typedtext_phase phase={phase} elapsed_ns={}",
            started.elapsed().as_nanos()
        );
    }
}

pub(crate) const TEXT_REGEX_PROGRAM_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const TEXT_REGEX_DFA_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const TEXT_REGEX_ALLOWANCE_BYTES: usize =
    TEXT_REGEX_PROGRAM_BYTES + TEXT_REGEX_DFA_BYTES;
/// Bound total bytes offered to all bank patterns, rather than arbitrarily dropping rules.
pub const MAX_TYPED_TEXT_REGEX_WORK: usize = 32 * 1024 * 1024;

#[derive(Clone, Debug)]
enum Predicate {
    Regex(usize),
    MinLength { minimum: usize, unicode: bool },
}
#[derive(Clone, Debug)]
pub(crate) struct TypedTextRegexBank {
    expressions: HashMap<EffectivePattern, usize>,
    // Remember only rejected keys, so unchanged catalogs also reuse syntax validation.
    // The complete normalized set is expressions + unsupported, with no duplicate keys.
    unsupported: Arc<[EffectivePattern]>,
    predicates: Vec<Predicate>,
    regex_count: usize,
    // One explicit cache shared across clones. try_lock prevents unbounded interactive queues.
    compiled: Option<Arc<Mutex<CachedProgram>>>,
}
impl TypedTextRegexBank {
    pub(super) fn build(features: &[FeatureEntry]) -> crate::Result<Self> {
        Self::build_commands(features.iter().flat_map(|feature| &feature.cmds))
    }
    pub(super) fn build_commands<'a>(
        commands: impl Iterator<Item = &'a Cmd>,
    ) -> crate::Result<Self> {
        Self::build_reusing_commands(commands, None)
    }
    pub(crate) fn build_reusing_commands<'a>(
        commands: impl Iterator<Item = &'a Cmd>,
        previous: Option<&Self>,
    ) -> crate::Result<Self> {
        #[cfg(test)]
        let started = std::time::Instant::now();
        let mut expressions = super::typed_text_bank_key::expressions(commands);
        #[cfg(test)]
        profile("normalized", started);
        let same = |bank: &Self, expressions: &[EffectivePattern]| {
            expressions.len() == bank.expressions.len()
                && expressions
                    .iter()
                    .all(|pattern| bank.expressions.contains_key(pattern))
        };
        if let Some(bank) = previous.filter(|bank| {
            expressions.len() == bank.expressions.len() + bank.unsupported.len()
                && expressions.iter().all(|pattern| {
                    bank.expressions.contains_key(pattern)
                        || bank.unsupported.binary_search(pattern).is_ok()
                })
        }) {
            return Ok(bank.clone());
        }
        #[cfg(test)]
        let started = std::time::Instant::now();
        let unsupported =
            super::typed_text_bank_key::retain_supported(&mut expressions, |pattern| {
                let bank = previous?;
                if bank.expressions.contains_key(pattern) {
                    Some(true)
                } else if bank.unsupported.binary_search(pattern).is_ok() {
                    Some(false)
                } else {
                    None
                }
            })
            .into();
        #[cfg(test)]
        profile("syntax", started);
        if let Some(bank) = previous.filter(|bank| same(bank, &expressions)) {
            let mut bank = bank.clone();
            bank.unsupported = unsupported;
            return Ok(bank);
        }
        let mut bank = Self::from_expressions(expressions, TEXT_REGEX_PROGRAM_BYTES)?;
        bank.unsupported = unsupported;
        Ok(bank)
    }
    fn from_expressions(
        expressions: Vec<EffectivePattern>,
        program_bytes: usize,
    ) -> crate::Result<Self> {
        let regexes = expressions
            .iter()
            .filter_map(|p| match p {
                EffectivePattern::Regex(p) => Some(p),
                _ => None,
            })
            .collect::<Vec<_>>();
        let compiled = if regexes.is_empty() {
            None
        } else {
            #[cfg(test)]
            COMPILE_COUNT.with(|count| count.set(count.get() + 1));
            #[cfg(test)]
            let started = std::time::Instant::now();
            let program = meta::Regex::builder()
                .configure(
                    meta::Regex::config()
                        .match_kind(MatchKind::All)
                        .utf8_empty(true)
                        .which_captures(WhichCaptures::None)
                        .nfa_size_limit(Some(program_bytes))
                        .hybrid_cache_capacity(TEXT_REGEX_DFA_BYTES / 2),
                )
                .build_many(&regexes);
            #[cfg(test)]
            profile("compile", started);
            let program = program.map_err(|_| compile_budget_error())?;
            // nfa_size_limit alone applies per NFA, not to total static program memory.
            if program.memory_usage() > program_bytes {
                return Err(compile_budget_error());
            }
            let cache = program.create_cache();
            let mut bank = CachedProgram { program, cache };
            bank.check_cache_budget()?;
            #[cfg(test)]
            let started = std::time::Instant::now();
            let trace = super::typed_text_prepare::cache_trace(&regexes, MAX_TYPED_TEXT_REGEX_WORK);
            if !trace.is_empty() {
                let mut matched = PatternSet::new(regexes.len());
                bank.program.which_overlapping_matches_with(
                    &mut bank.cache,
                    &Input::new(&trace),
                    &mut matched,
                );
                bank.check_cache_budget()?;
            }
            #[cfg(test)]
            profile("prepare", started);
            Some(Arc::new(Mutex::new(bank)))
        };
        let regex_count = regexes.len();
        let mut regex_id = 0;
        let predicates = expressions
            .iter()
            .map(|p| match p {
                EffectivePattern::Regex(_) => {
                    let id = regex_id;
                    regex_id += 1;
                    Predicate::Regex(id)
                }
                EffectivePattern::MinLength { minimum, unicode } => Predicate::MinLength {
                    minimum: *minimum,
                    unicode: *unicode,
                },
            })
            .collect();
        Ok(Self {
            expressions: expressions
                .into_iter()
                .enumerate()
                .map(|(i, p)| (p, i))
                .collect(),
            predicates,
            unsupported: Arc::from([]),
            regex_count,
            compiled,
        })
    }
    /// Newly retained rejected keys share one allocation across catalog clones.
    /// Charge that retained logical data within the existing catalog allowance.
    pub(crate) fn unsupported_key_bytes(&self) -> usize {
        self.unsupported
            .iter()
            .fold(2 * std::mem::size_of::<usize>(), |total, pattern| {
                total
                    .saturating_add(std::mem::size_of::<EffectivePattern>())
                    .saturating_add(match pattern {
                        EffectivePattern::Regex(source) => source.capacity(),
                        EffectivePattern::MinLength { .. } => 0,
                    })
            })
    }
    pub(super) fn pattern_id(&self, pattern: Option<&str>, context: TextContext) -> Option<usize> {
        self.expressions
            .get(&expression(pattern?, context)?)
            .copied()
    }
    pub(super) fn matches_with_metrics(
        &self,
        text: &str,
    ) -> crate::Result<(Vec<bool>, TextMetrics)> {
        if text.len().saturating_mul(self.regex_count) > MAX_TYPED_TEXT_REGEX_WORK {
            return Err(crate::AToolsError::Plugin("TYPED_TEXT_MATCH_WORK_BUDGET: 文本与规则组合超过32 MiB匹配工作预算，请缩短文本或减少启用的规则后重试".into()));
        }
        let matched = if let Some(compiled) = &self.compiled {
            let mut bank = compiled.try_lock().map_err(|error| {
                crate::AToolsError::Plugin(
                    match error {
                        TryLockError::WouldBlock => {
                            "TYPED_TEXT_SEARCH_BUSY: 文本搜索正在进行，请稍后重试"
                        }
                        TryLockError::Poisoned(_) => "Typed text matcher lock poisoned",
                    }
                    .into(),
                )
            })?;
            let mut matches = PatternSet::new(self.regex_count);
            let CachedProgram { program, cache } = &mut *bank;
            program.which_overlapping_matches_with(cache, &Input::new(text), &mut matches);
            bank.check_cache_budget()?;
            Some(
                (0..self.regex_count)
                    .map(|i| matches.contains(PatternID::must(i)))
                    .collect::<Vec<_>>(),
            )
        } else {
            None
        };
        let metrics = TextMetrics::from_str(text);
        let matches = self
            .predicates
            .iter()
            .map(|p| match p {
                Predicate::Regex(id) => matched.as_ref().is_some_and(|m| m[*id]),
                Predicate::MinLength {
                    minimum,
                    unicode: true,
                } => metrics.scalar_len >= *minimum,
                Predicate::MinLength {
                    minimum,
                    unicode: false,
                } => metrics.utf16_len >= *minimum,
            })
            .collect();
        Ok((matches, metrics))
    }

    #[cfg(test)]
    pub(super) fn matches(&self, text: &str) -> crate::Result<Vec<bool>> {
        self.matches_with_metrics(text).map(|(matches, _)| matches)
    }
}

#[derive(Debug)]
struct CachedProgram {
    program: meta::Regex,
    cache: meta::Cache,
}
impl CachedProgram {
    fn check_cache_budget(&mut self) -> crate::Result<()> {
        if self.cache.memory_usage() > TEXT_REGEX_DFA_BYTES {
            // Reject the entire observation and release grown scratch state before return.
            self.cache = self.program.create_cache();
            return Err(crate::AToolsError::Plugin("TYPED_TEXT_REGEX_CACHE_BUDGET: 文本匹配缓存超过4 MiB预算，请减少或简化启用的规则后重试".into()));
        }
        Ok(())
    }
}
fn compile_budget_error() -> crate::AToolsError {
    crate::AToolsError::Plugin(
        "TYPED_TEXT_REGEX_COMPILE_BUDGET: 文本规则超过8 MiB编译预算，请减少或简化启用的规则后重试"
            .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compile_budget_failure_is_explicit_instead_of_a_partial_bank() {
        let error = TypedTextRegexBank::from_expressions(
            vec![EffectivePattern::Regex("[a-z]{100}".into())],
            1,
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("TYPED_TEXT_REGEX_COMPILE_BUDGET"));
    }
    #[test]
    fn busy_bank_fails_immediately_and_recovers_without_partial_results() {
        let bank = TypedTextRegexBank::from_expressions(
            vec![EffectivePattern::Regex("x".into())],
            TEXT_REGEX_PROGRAM_BYTES,
        )
        .unwrap();
        let lock = bank.compiled.as_ref().unwrap().lock().unwrap();
        assert!(bank
            .matches("x")
            .unwrap_err()
            .to_string()
            .contains("TYPED_TEXT_SEARCH_BUSY"));
        drop(lock);
        assert_eq!(bank.matches("x").unwrap(), vec![true]);
    }
    #[test]
    fn reused_program_has_exact_keys_and_one_shared_busy_recoverable_cache() {
        let commands: Vec<Cmd> = serde_json::from_value(serde_json::json!([
            {"type":"regex","match":"/x/i"},
            {"type":"regex","match":"/(unsupported/"},
            {"type":"over","exclude":"/deny/i"}
        ]))
        .unwrap();
        let bank = TypedTextRegexBank::build_commands(commands.iter()).unwrap();
        let count = compile_count();
        assert_eq!(bank.unsupported.len(), 1);
        let mut commands = commands;
        commands.reverse();
        let reused =
            TypedTextRegexBank::build_reusing_commands(commands.iter(), Some(&bank)).unwrap();
        assert_eq!(compile_count(), count);
        let compiled = bank.compiled.as_ref().unwrap();
        assert!(Arc::ptr_eq(compiled, reused.compiled.as_ref().unwrap()));
        let held = compiled.lock().unwrap();
        assert!(reused
            .matches("x")
            .unwrap_err()
            .to_string()
            .contains("TYPED_TEXT_SEARCH_BUSY"));
        drop(held);
        assert_eq!(bank.matches("x").unwrap(), reused.matches("x").unwrap());
        commands.push(
            serde_json::from_value(serde_json::json!(
            {"type":"regex","match":"/another(unsupported/"}))
            .unwrap(),
        );
        let more_ignored =
            TypedTextRegexBank::build_reusing_commands(commands.iter(), Some(&bank)).unwrap();
        assert_eq!(compile_count(), count);
        assert!(Arc::ptr_eq(
            compiled,
            more_ignored.compiled.as_ref().unwrap()
        ));
        assert_eq!(more_ignored.unsupported.len(), 2);
        assert_eq!(
            bank.unsupported.len(),
            1,
            "candidate metadata cannot mutate live bank"
        );
        let held = compiled.lock().unwrap();
        let same_while_busy =
            TypedTextRegexBank::build_reusing_commands(commands.iter(), Some(&more_ignored))
                .unwrap();
        assert!(Arc::ptr_eq(
            compiled,
            same_while_busy.compiled.as_ref().unwrap()
        ));
        drop(held);
    }
    #[test]
    fn zero_one_and_many_supported_and_unsupported_keys_reuse_without_compilation() {
        for supported in [0, 1, 8] {
            for unsupported in [0, 1, 8] {
                let mut commands = (0..supported)
                    .map(|i| {
                        serde_json::from_value::<Cmd>(serde_json::json!(
                    {"type":"regex","match":format!("/x{i}/i")}))
                        .unwrap()
                    })
                    .collect::<Vec<_>>();
                commands.extend((0..unsupported).map(|i| {
                    serde_json::from_value::<Cmd>(serde_json::json!(
                    {"type":"regex","match":format!("/(?=unsupported{i})/")}))
                    .unwrap()
                }));
                let before = compile_count();
                let parsed = super::super::typed_text_bank_key::syntax_count();
                let bank = TypedTextRegexBank::build_commands(commands.iter()).unwrap();
                assert_eq!(compile_count() - before, usize::from(supported > 0));
                assert_eq!(bank.unsupported.len(), unsupported);
                assert_eq!(
                    super::super::typed_text_bank_key::syntax_count() - parsed,
                    2 * supported + unsupported
                );
                let reused =
                    TypedTextRegexBank::build_reusing_commands(commands.iter(), Some(&bank))
                        .unwrap();
                assert_eq!(compile_count() - before, usize::from(supported > 0));
                assert!(Arc::ptr_eq(&bank.unsupported, &reused.unsupported));
                assert_eq!(
                    super::super::typed_text_bank_key::syntax_count() - parsed,
                    2 * supported + unsupported
                );
                assert_eq!(bank.matches("x1").unwrap(), reused.matches("x1").unwrap());
                let parsed = super::super::typed_text_bank_key::syntax_count();
                commands.push(
                    serde_json::from_value::<Cmd>(serde_json::json!(
                    {"type":"regex","match":"/new-expression/i"}))
                    .unwrap(),
                );
                let changed =
                    TypedTextRegexBank::build_reusing_commands(commands.iter(), Some(&bank))
                        .unwrap();
                assert_eq!(
                    super::super::typed_text_bank_key::syntax_count() - parsed,
                    2,
                    "only new canonical keys require syntax validation"
                );
                assert_eq!(compile_count() - before, usize::from(supported > 0) + 1);
                assert!(changed
                    .pattern_id(Some("/new-expression/i"), TextContext::FixedText)
                    .is_some());
            }
        }
    }
    #[test]
    fn effective_expressions_share_slots_across_sources_and_contexts() {
        let feature: FeatureEntry = serde_json::from_value(serde_json::json!({
            "code":"f","plugin_id":"p","plugin_name":"p","label":"f","explain":"",
            "cmds":[{"type":"regex","match":"/x/"},{"type":"regex","match":"/x/g"},
                {"type":"regex","match":"/x/i"},{"type":"over","exclude":"/x/ii"},
                {"type":"regex","match":"/[/"}],"main_push":false,"priority":0
        }))
        .unwrap();
        let bank = TypedTextRegexBank::build(&[feature]).unwrap();
        assert_eq!(bank.expressions.len(), 2);
        let raw = bank.pattern_id(Some("/x/"), TextContext::Ordinary);
        assert_eq!(raw, bank.pattern_id(Some("/x/g"), TextContext::FixedText));
        assert_eq!(raw, bank.pattern_id(Some("/x/i"), TextContext::Ordinary));
        assert_eq!(raw, bank.pattern_id(Some("/x/ii"), TextContext::Ordinary));
        assert_ne!(raw, bank.pattern_id(Some("/x/i"), TextContext::FixedText));
        assert_eq!(None, bank.pattern_id(Some("/x/ii"), TextContext::FixedText));
        assert_eq!(None, bank.pattern_id(Some("/[/"), TextContext::Ordinary));
    }
    #[test]
    fn explicit_cache_stays_shared_and_reported_heap_is_checked_across_worker_threads() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/launcher-typed-text-ecosystem-rules.json"
        ))
        .unwrap();
        let features = fixture["commands"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(i, c)| FeatureEntry {
                code: format!("f{i}"),
                plugin_id: "metadata".into(),
                plugin_name: String::new(),
                label: String::new(),
                icon: None,
                explain: String::new(),
                cmds: vec![serde_json::from_value(c.clone()).unwrap()],
                main_push: false,
                priority: 0,
            })
            .collect::<Vec<_>>();
        let bank = TypedTextRegexBank::build(&features).unwrap();
        let compiled = bank.compiled.as_ref().unwrap();
        assert!(Arc::ptr_eq(
            compiled,
            bank.clone().compiled.as_ref().unwrap()
        ));
        for worker in 0..4 {
            let cloned = bank.clone();
            std::thread::spawn(move || cloned.matches(&"x".repeat(262144)).unwrap())
                .join()
                .unwrap();
            let state = compiled.lock().unwrap();
            let program_bytes = state.program.memory_usage();
            let cache_bytes = state.cache.memory_usage();
            eprintln!("typedtext_heap worker={worker} program_reported_bytes={program_bytes} cache_reported_bytes={cache_bytes} program_limit={} cache_limit={}",TEXT_REGEX_PROGRAM_BYTES,TEXT_REGEX_DFA_BYTES);
            assert!(program_bytes <= TEXT_REGEX_PROGRAM_BYTES);
            assert!(cache_bytes <= TEXT_REGEX_DFA_BYTES);
        }
    }
}
