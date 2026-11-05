//! Bounded, pattern-derived cache preparation belongs to index construction, never a query.
use regex_syntax::hir::{Class, Hir, HirKind};

const MAX_WITNESS_BYTES: usize = 512;
const MAX_PREPARE_BYTES: usize = 1024;
const MAX_PREPARE_WITNESSES: usize = 8;

/// A deterministic representative trace reduces first-query lazy-DFA construction cost.
/// It is an optimization, not a correctness shortcut: every real query still evaluates
/// every compiled pattern. Preparation has the same full-bank work ceiling as a query.
pub(super) fn cache_trace(patterns: &[&String], work_limit: usize) -> String {
    let limit = MAX_PREPARE_BYTES.min(work_limit / patterns.len().max(1));
    let mut trace = String::new();
    let count = patterns.len().min(MAX_PREPARE_WITNESSES);
    for selected in 0..count {
        let index = if count <= 1 {
            0
        } else {
            selected * (patterns.len() - 1) / (count - 1)
        };
        let pattern = patterns[index];
        let Ok(hir) = regex_syntax::Parser::new().parse(pattern) else {
            continue;
        };
        let mut witness = String::new();
        if append_witness(&hir, &mut witness).is_none() {
            continue;
        }
        if trace.len().saturating_add(witness.len() + 1) > limit {
            continue;
        }
        trace.push_str(&witness);
        trace.push('\n');
    }
    trace
}

fn append_witness(hir: &Hir, out: &mut String) -> Option<()> {
    match hir.kind() {
        HirKind::Empty | HirKind::Look(_) => {}
        HirKind::Literal(literal) => {
            if out.len().saturating_add(literal.0.len()) > MAX_WITNESS_BYTES {
                return None;
            }
            out.push_str(std::str::from_utf8(&literal.0).ok()?);
        }
        HirKind::Class(Class::Unicode(class)) => {
            let c = ['a', 'x', '0', ' ', '\n', '中']
                .into_iter()
                .find(|c| class.iter().any(|r| r.start() <= *c && *c <= r.end()))
                .or_else(|| class.iter().next().map(|r| r.start()))?;
            if out.len().saturating_add(c.len_utf8()) > MAX_WITNESS_BYTES {
                return None;
            }
            out.push(c);
        }
        HirKind::Class(Class::Bytes(class)) => {
            let c = (*b"ax0 \n")
                .into_iter()
                .find(|c| class.iter().any(|r| r.start() <= *c && *c <= r.end()))
                .or_else(|| class.iter().next().map(|r| r.start()))?;
            if !c.is_ascii() {
                return None;
            }
            if out.len() >= MAX_WITNESS_BYTES {
                return None;
            }
            out.push(c as char);
        }
        HirKind::Capture(capture) => append_witness(&capture.sub, out)?,
        HirKind::Concat(parts) => {
            for part in parts {
                append_witness(part, out)?;
            }
        }
        HirKind::Alternation(parts) => append_witness(parts.first()?, out)?,
        HirKind::Repetition(repetition) => {
            let count = if repetition.max == Some(0) {
                0
            } else {
                repetition
                    .max
                    .unwrap_or(repetition.min.max(1))
                    .min(8)
                    .max(repetition.min)
            };
            if count as usize > MAX_WITNESS_BYTES {
                return None;
            }
            for _ in 0..count {
                append_witness(&repetition.sub, out)?;
            }
        }
    }
    (out.len() <= MAX_WITNESS_BYTES).then_some(())
}
