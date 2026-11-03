//! Static call and module-name classification shared by bounded graph inspection.
use super::{Scan, Token};
use anyhow::Result;
use std::path::{Path, PathBuf};

pub(super) fn call_open(tokens: &[Token], start: usize) -> Option<usize> {
    match tokens.get(start) {
        Some(Token::Punct('(')) => Some(start),
        Some(Token::Punct('?'))
            if tokens.get(start + 1) == Some(&Token::Punct('.'))
                && tokens.get(start + 2) == Some(&Token::Punct('(')) =>
        {
            Some(start + 2)
        }
        _ => None,
    }
}

pub(super) fn require_resolve_call(tokens: &[Token], index: usize) -> bool {
    let member_start = match (tokens.get(index + 1), tokens.get(index + 2)) {
        (Some(Token::Punct('.')), _) => index + 2,
        (Some(Token::Punct('?')), Some(Token::Punct('.'))) => index + 3,
        _ => return false,
    };
    tokens.get(member_start) == Some(&Token::Ident("resolve".into()))
        && call_open(tokens, member_start + 1).is_some()
}

pub(super) fn classify_call(
    tokens: &[Token],
    open: usize,
    commonjs: bool,
    scan: &mut Scan<'_>,
    owner: &Path,
    dependencies: &mut Vec<PathBuf>,
) {
    match (tokens.get(open + 1), tokens.get(open + 2)) {
        (Some(Token::String(module)), Some(Token::Punct(')'))) => {
            scan.classify_module(module, owner, commonjs, dependencies)
        }
        _ => {
            scan.unknown = true;
            scan.incomplete = true;
        }
    }
}

pub(super) fn normalize_graph_path(path: &Path) -> Result<PathBuf> {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(part) => output.push(part),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir if output.pop() => {}
            _ => anyhow::bail!("module path escapes package"),
        }
    }
    if output.as_os_str().is_empty() {
        anyhow::bail!("empty module path");
    }
    Ok(output)
}

pub(super) fn is_node_builtin(name: &str) -> bool {
    let name = name.strip_prefix("node:").unwrap_or(name);
    let name = name.split('/').next().unwrap_or(name);
    matches!(
        name,
        "assert"
            | "async_hooks"
            | "buffer"
            | "child_process"
            | "cluster"
            | "console"
            | "constants"
            | "crypto"
            | "dgram"
            | "diagnostics_channel"
            | "dns"
            | "domain"
            | "events"
            | "fs"
            | "http"
            | "http2"
            | "https"
            | "inspector"
            | "module"
            | "net"
            | "os"
            | "path"
            | "perf_hooks"
            | "process"
            | "punycode"
            | "querystring"
            | "readline"
            | "repl"
            | "sea"
            | "sqlite"
            | "stream"
            | "string_decoder"
            | "sys"
            | "test"
            | "timers"
            | "tls"
            | "trace_events"
            | "tty"
            | "url"
            | "util"
            | "v8"
            | "vm"
            | "wasi"
            | "worker_threads"
            | "zlib"
    )
}

/// The selected-source binding does not resolve node_modules or package imports.
/// Unlike the broad hint classifier, only exact known builtin specifiers qualify.
pub(super) fn is_selected_builtin(name: &str) -> bool {
    if matches!(
        name,
        "node:test" | "node:test/reporters" | "node:sea" | "node:sqlite"
    ) {
        return true;
    }
    let name = name.strip_prefix("node:").unwrap_or(name);
    if name.contains(':') || matches!(name, "test" | "test/reporters" | "sea" | "sqlite") {
        return false;
    }
    if name.contains('/') {
        return matches!(
            name,
            "assert/strict"
                | "dns/promises"
                | "fs/promises"
                | "inspector/promises"
                | "path/posix"
                | "path/win32"
                | "readline/promises"
                | "stream/consumers"
                | "stream/promises"
                | "stream/web"
                | "timers/promises"
                | "util/types"
        );
    }
    is_node_builtin(name)
}

/// Re-exports can load another source, while self-contained exports cannot.
pub(super) fn is_reexport(tokens: &[Token], index: usize) -> bool {
    match tokens.get(index + 1) {
        Some(Token::Punct('*')) => true,
        Some(Token::Punct('{')) => tokens[index + 2..]
            .iter()
            .position(|token| *token == Token::Punct('}'))
            .is_some_and(|close| {
                tokens.get(index + 3 + close) == Some(&Token::Ident("from".into()))
            }),
        _ => false,
    }
}

/// Only direct require calls on a recognized global have statically bound inputs.
/// Optional receivers and unknown objects may carry the authorized resolver too.
pub(super) fn unsupported_require_reference(tokens: &[Token], index: usize) -> bool {
    let known_global = |token: Option<&Token>| {
        matches!(token,
        Some(Token::Ident(base)) if matches!(base.as_str(), "window" | "globalThis" | "self"))
    };
    if known_global(tokens.get(index)) {
        let bracket = if tokens.get(index + 1) == Some(&Token::Punct('[')) {
            Some(index + 1)
        } else if tokens.get(index + 1) == Some(&Token::Punct('?'))
            && tokens.get(index + 2) == Some(&Token::Punct('.'))
            && tokens.get(index + 3) == Some(&Token::Punct('['))
        {
            Some(index + 3)
        } else {
            None
        };
        if let Some(bracket) = bracket {
            // A computed global property can be the resolver; only a complete
            // literal property is statically known, regardless of optional access.
            if !matches!(
                (tokens.get(bracket + 1), tokens.get(bracket + 2)),
                (Some(Token::String(_)), Some(Token::Punct(']')))
            ) {
                return true;
            }
        }
    }
    match tokens.get(index) {
        Some(Token::Ident(name)) if name == "require" => {
            let dot_member = index > 0 && tokens[index - 1] == Token::Punct('.');
            let recognized =
                !dot_member || known_global(index.checked_sub(2).and_then(|at| tokens.get(at)));
            !recognized || call_open(tokens, index + 1).is_none()
        }
        Some(Token::String(name))
            if name == "require"
                && index > 0
                && tokens[index - 1] == Token::Punct('[')
                && tokens.get(index + 1) == Some(&Token::Punct(']')) =>
        {
            !known_global(index.checked_sub(2).and_then(|at| tokens.get(at)))
                || call_open(tokens, index + 2).is_none()
        }
        _ => false,
    }
}
