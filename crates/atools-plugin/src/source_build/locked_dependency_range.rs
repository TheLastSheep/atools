//! Bounded npm semver-range subset for validating lock graph edges.
//!
//! Supports npm bare full-version equality, X-ranges, `*`, caret/tilde,
//! primitive comparisons, whitespace AND, and bounded `||`. Git/alias/workspace
//! specs, hyphen ranges, tags, URLs, and unrecognized syntax fail closed.
use semver::{Version, VersionReq};

const MAX_SPEC_BYTES: usize = 512;
const MAX_OR_BRANCHES: usize = 8;
const MAX_AND_TERMS: usize = 16;

pub(super) fn matches(spec: &str, candidate: &str) -> Result<bool, ()> {
    if spec.len() > MAX_SPEC_BYTES || candidate.len() > 128 || spec.is_empty() {
        return Err(());
    }
    let version = Version::parse(candidate).map_err(|_| ())?;
    let branches = spec.split("||").collect::<Vec<_>>();
    if branches.len() > MAX_OR_BRANCHES || branches.iter().any(|part| part.contains('|')) {
        return Err(());
    }
    let mut matched = false;
    for branch in branches {
        let branch = branch.trim();
        if branch.is_empty() || branch.contains(" - ") {
            return Err(());
        }
        if branch.split(',').any(|part| part.trim().is_empty()) {
            return Err(());
        }
        let terms = normalize_terms(branch)?;
        let normalized = terms.join(", ");
        let requirement = VersionReq::parse(&normalized).map_err(|_| ())?;
        matched |= requirement.matches(&version);
    }
    Ok(matched)
}

fn normalize_terms(branch: &str) -> Result<Vec<String>, ()> {
    let with_space_commas = branch.replace(',', " ");
    let raw = with_space_commas
        .split_ascii_whitespace()
        .collect::<Vec<_>>();
    if raw.is_empty() || raw.len() > MAX_AND_TERMS * 2 {
        return Err(());
    }
    let mut terms = Vec::new();
    let mut index = 0;
    while index < raw.len() {
        let token = raw[index];
        let operator_only = matches!(token, ">" | ">=" | "<" | "<=" | "=" | "^" | "~");
        let combined = if operator_only {
            index += 1;
            let version = raw.get(index).ok_or(())?;
            format!("{token}{version}")
        } else {
            token.to_owned()
        };
        if combined.contains(',')
            || combined.contains('/')
            || combined.contains(':')
            || combined.contains('\\')
            || combined.chars().any(char::is_control)
        {
            return Err(());
        }
        terms.push(normalize_wildcard_case(&combined));
        if terms.len() > MAX_AND_TERMS {
            return Err(());
        }
        index += 1;
    }
    // Normalize each comparator independently. npm whitespace means an AND,
    // so a bare version or partial version can appear beside other terms too.
    // Rust semver treats a bare full version as a caret requirement; npm treats
    // it as exact equality. Bare partials are X-ranges, not caret requirements.
    let mut normalized = terms
        .into_iter()
        .map(|term| {
            if has_operator(&term) {
                Ok(term)
            } else if is_bare_full_version(&term) {
                Ok(format!("={term}"))
            } else {
                to_bare_x_range(&term)
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    // `*` contributes no stable-version constraint and, in npm, can appear
    // alongside other comparators. Rust's parser requires it to stand alone.
    normalized.retain(|term| term != "*");
    if normalized.is_empty() {
        normalized.push("*".to_owned());
    }
    Ok(normalized)
}

fn normalize_wildcard_case(value: &str) -> String {
    let suffix_start = value
        .char_indices()
        .find(|(_, character)| matches!(*character, '-' | '+'))
        .map_or(value.len(), |(index, _)| index);
    let (version, suffix) = value.split_at(suffix_start);
    format!("{}{}", version.replace('X', "x"), suffix)
}

fn has_operator(value: &str) -> bool {
    value.starts_with('^')
        || value.starts_with('~')
        || value.starts_with('>')
        || value.starts_with('<')
        || value.starts_with('=')
}

fn is_bare_full_version(value: &str) -> bool {
    !has_operator(value) && Version::parse(value).is_ok()
}

fn to_bare_x_range(value: &str) -> Result<String, ()> {
    let parts = value.split('.').collect::<Vec<_>>();
    if parts.is_empty() || parts.len() > 3 {
        return Err(());
    }
    let mut wildcard_seen = false;
    for (index, part) in parts.iter().enumerate() {
        let wildcard = matches!(*part, "*" | "x");
        if wildcard {
            if wildcard_seen || index + 1 != parts.len() {
                return Err(());
            }
            wildcard_seen = true;
        } else if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(());
        }
    }
    if parts.len() == 1 && wildcard_seen {
        return Ok("*".to_owned());
    }
    match (parts.len(), wildcard_seen) {
        (1, false) => Ok(format!("{}.x", parts[0])),
        (2, false) => Ok(format!("{}.{}.x", parts[0], parts[1])),
        (2, true) => Ok(format!("{}.x", parts[0])),
        (3, true) => Ok(format!("{}.{}.x", parts[0], parts[1])),
        _ => Err(()),
    }
}

#[cfg(test)]
mod tests {
    use super::matches;

    #[test]
    fn handles_npm_exact_prerelease_and_range_forms() {
        assert_eq!(matches("1.0.0-beta.27", "1.0.0-beta.27"), Ok(true));
        assert_eq!(matches("1.0.0-beta.27", "1.0.0-beta.28"), Ok(false));
        assert_eq!(matches("^1.2.0 || ^2.0.0", "2.3.4"), Ok(true));
        assert_eq!(matches(">= 1.2 < 2", "1.9.9"), Ok(true));
        assert_eq!(matches("1.2", "1.2.8"), Ok(true));
        assert_eq!(matches("~1", "1.9.0"), Ok(true));
        assert_eq!(matches("~1", "2.0.0"), Ok(false));
        assert_eq!(matches("1.2.3 >=1", "1.2.3"), Ok(true));
        assert_eq!(matches("1.2.3 >=1", "1.3.0"), Ok(false));
        assert_eq!(matches("1.2 <2", "1.2.8"), Ok(true));
        assert_eq!(matches("1.2 <2", "1.3.0"), Ok(false));
        assert_eq!(matches("* >=1", "1.0.0"), Ok(true));
        assert_eq!(matches("* >=1", "1.0.0-beta.1"), Ok(false));
        assert_eq!(matches("*", "1.0.0-beta.1"), Ok(false));
        assert_eq!(matches("^1.2.0", "1.3.0-beta.1"), Ok(false));
        assert_eq!(matches("^1.3.0-beta.0", "1.3.0-beta.1"), Ok(true));
        assert_eq!(matches("^0.0", "0.0.9"), Ok(true));
        assert_eq!(matches("^0.0", "0.1.0"), Ok(false));
        assert_eq!(matches("~1.2", "1.2.9"), Ok(true));
        assert_eq!(matches("~1.2", "1.3.0"), Ok(false));
        assert_eq!(matches(">=1.2, <2", "1.8.0"), Ok(true));
        assert_eq!(matches(">=1.2, <2", "2.0.0"), Ok(false));
    }

    #[test]
    fn rejects_unbounded_or_unsupported_protocols() {
        for value in [
            "^1 || ^2 || ^3 || ^4 || ^5 || ^6 || ^7 || ^8 || ^9",
            "1 - 2",
            "latest",
            "git+https://x",
            "workspace:*",
            "npm:other@^1",
            "1 ||",
            ",>=1",
            ">=1,,<2",
            ">=1,",
        ] {
            assert!(matches(value, "1.2.3").is_err(), "{value}");
        }
    }
}
