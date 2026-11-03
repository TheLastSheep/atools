use super::super::js_tokens::{lex, Token};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Call {
    pub specifier: Option<String>,
    pub reason: &'static str,
}

#[derive(Debug, Default)]
pub(super) struct SourceCalls {
    pub calls: Vec<Call>,
    pub uncertain: bool,
    pub uncertainty_reasons: Vec<&'static str>,
}

/// Extracts only syntactically narrow `require("literal")` calls. This is not a JS parser;
/// uncertain scopes and control flow intentionally widen to unknown.
pub(super) fn extract(source: &str) -> SourceCalls {
    let (tokens, lexical_uncertainty) = lex(source);
    let mut result = SourceCalls::default();
    let conditional = tokens.iter().any(|token| matches!(token,
        Token::Ident(word) if matches!(word.as_str(), "if" | "try" | "catch" | "switch" | "case" | "for" | "while"))
    ) || tokens.iter().any(|token| matches!(token, Token::Punct('&' | '|' | '?')));
    let rebound = has_rebound_require(&tokens);
    if lexical_uncertainty {
        result.mark("unsupported_escaped_or_template_syntax");
    }
    if tokens.iter().any(|token| token == &Token::Punct('/')) {
        // The shared lexer cannot always distinguish division from a regex literal.
        // If a slash remains as punctuation, do not treat nearby identifiers as calls.
        result.mark("ambiguous_regex_or_division_syntax");
    }
    if source.contains(['\\', '`']) {
        result.mark("unsupported_escaped_or_template_syntax");
    }
    if tokens
        .iter()
        .any(|token| matches!(token, Token::Ident(word) if word == "import" || word == "export"))
    {
        result.mark("unsupported_esm_syntax");
    }
    if tokens
        .iter()
        .any(|token| matches!(token, Token::Ident(word) if word == "createRequire"))
    {
        result.mark("dynamic_create_require");
    }
    if rebound {
        result.mark("shadowed_or_rebound_require");
    }
    if has_dynamic_evaluation(&tokens) {
        result.mark("dynamic_code_evaluation");
    }
    if conditional {
        result.mark("conditional_or_optional_call");
    }
    if has_delayed_or_braced_require_scope(&tokens) {
        result.mark("deferred_or_ambiguous_require_scope");
    }

    for (index, token) in tokens.iter().enumerate() {
        if token != &Token::Ident("require".into()) {
            continue;
        }
        if is_member_property(&tokens, index) {
            if matches!(tokens.get(index + 1), Some(Token::Punct('(' | '?'))) {
                result.calls.push(Call {
                    specifier: None,
                    reason: "unsupported_require_property_call",
                });
                result.mark("unsupported_require_property_call");
            }
            continue;
        }
        let next = index + 1;
        if is_require_resolve(&tokens, index) {
            result.calls.push(Call {
                specifier: None,
                reason: "require_resolve_not_load_edge",
            });
            result.mark("require_resolve_not_load_edge");
            continue;
        }
        if is_optional_call(&tokens, next) {
            result.calls.push(Call {
                specifier: None,
                reason: "optional_require_call",
            });
            result.mark("conditional_or_optional_call");
            continue;
        }
        if tokens.get(next) != Some(&Token::Punct('(')) {
            result.mark("require_reference_alias_or_rebinding");
            continue;
        }
        if tokens.get(next + 1) == Some(&Token::String(String::new())) {
            result.calls.push(Call {
                specifier: None,
                reason: "escaped_require_specifier",
            });
            result.mark("unsupported_escaped_or_template_syntax");
            continue;
        }
        match (
            tokens.get(next + 1),
            tokens.get(next + 2),
            tokens.get(next + 3),
        ) {
            (Some(Token::String(specifier)), Some(Token::Punct(')')), _) => {
                let reason = if result.uncertain {
                    result.uncertainty_reasons[0]
                } else {
                    "literal_commonjs_require"
                };
                result.calls.push(Call {
                    specifier: Some(specifier.clone()),
                    reason,
                });
            }
            _ => {
                result.calls.push(Call {
                    specifier: None,
                    reason: "dynamic_or_nonliteral_require",
                });
                result.mark("dynamic_or_nonliteral_require");
            }
        }
    }
    result
        .calls
        .sort_by(|a, b| a.specifier.cmp(&b.specifier).then(a.reason.cmp(b.reason)));
    result.calls.dedup();
    result.uncertainty_reasons.sort_unstable();
    result.uncertainty_reasons.dedup();
    result
}

impl SourceCalls {
    fn mark(&mut self, reason: &'static str) {
        self.uncertain = true;
        self.uncertainty_reasons.push(reason);
    }
}

fn is_member_property(tokens: &[Token], index: usize) -> bool {
    matches!(tokens.get(index.wrapping_sub(1)), Some(Token::Punct('.')))
        || (tokens.get(index.wrapping_sub(1)) == Some(&Token::Punct('?'))
            && tokens.get(index.wrapping_sub(2)) == Some(&Token::Punct('.')))
}

fn is_optional_call(tokens: &[Token], start: usize) -> bool {
    tokens.get(start) == Some(&Token::Punct('?'))
        && tokens.get(start + 1) == Some(&Token::Punct('.'))
        && tokens.get(start + 2) == Some(&Token::Punct('('))
}

fn is_require_resolve(tokens: &[Token], index: usize) -> bool {
    tokens.get(index + 1) == Some(&Token::Punct('.'))
        && tokens.get(index + 2) == Some(&Token::Ident("resolve".into()))
        && tokens.get(index + 3) == Some(&Token::Punct('('))
}

fn has_dynamic_evaluation(tokens: &[Token]) -> bool {
    tokens.iter().any(|token| {
        matches!(token,
        Token::Ident(word) if matches!(word.as_str(), "eval" | "Function"))
    }) || tokens
        .windows(2)
        .any(|pair| pair[0] == Token::Punct('=') && pair[1] == Token::Ident("require".into()))
}

fn has_rebound_require(tokens: &[Token]) -> bool {
    for (index, token) in tokens.iter().enumerate() {
        if token != &Token::Ident("require".into()) {
            continue;
        }
        if matches!(tokens.get(index.wrapping_sub(1)), Some(Token::Ident(word)) if matches!(word.as_str(), "const" | "let" | "var" | "function" | "class"))
            || matches!(tokens.get(index + 1), Some(Token::Punct('=' | '+')))
        {
            return true;
        }
        if matches!(
            tokens.get(index.wrapping_sub(1)),
            Some(Token::Punct('(' | ','))
        ) && matches!(tokens.get(index + 1), Some(Token::Punct(')' | ',')))
        {
            return true;
        }
        if tokens.get(index.wrapping_sub(1)) == Some(&Token::Punct('=')) {
            return true;
        }
    }
    false
}

/// A compact token stream cannot prove whether a call nested in braces executes during
/// preload initialization. This covers function/class bodies and object methods without
/// pretending to parse JavaScript scopes. Arrow expressions are deferred even without braces.
fn has_delayed_or_braced_require_scope(tokens: &[Token]) -> bool {
    if tokens.iter().any(|token| {
        matches!(token, Token::Ident(word) if matches!(word.as_str(), "function" | "class"))
    }) || tokens
        .windows(2)
        .any(|pair| pair[0] == Token::Punct('=') && pair[1] == Token::Punct('>'))
    {
        return true;
    }

    let mut brace_depth = 0usize;
    for token in tokens {
        if token == &Token::Ident("require".into()) && brace_depth > 0 {
            return true;
        }
        match token {
            Token::Punct('{') => brace_depth = brace_depth.saturating_add(1),
            Token::Punct('}') => brace_depth = brace_depth.saturating_sub(1),
            _ => {}
        }
    }
    false
}
