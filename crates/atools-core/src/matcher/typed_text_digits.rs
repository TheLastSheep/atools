//! Token-aware ASCII JavaScript digit classes without enabling Rust set operators.
#[derive(Clone)]
struct Atom {
    source: String,
    scalar: Option<char>,
    class: bool,
    hyphen: bool,
}

pub(super) fn normalize(body: &str, unicode: bool) -> Option<String> {
    let chars = body.chars().collect::<Vec<_>>();
    let mut index = 0;
    let mut out = String::with_capacity(body.len());
    while index < chars.len() {
        match chars[index] {
            '[' => out.push_str(&class(&chars, &mut index, unicode)?),
            '\\' => {
                let atom = escape(&chars, &mut index)?;
                out.push_str(&atom.source);
            }
            c => {
                out.push(c);
                index += 1;
            }
        }
    }
    Some(out)
}

fn class(chars: &[char], index: &mut usize, unicode: bool) -> Option<String> {
    *index += 1;
    let negated = chars.get(*index) == Some(&'^');
    if negated {
        *index += 1;
    }
    let mut atoms = Vec::new();
    while chars.get(*index) != Some(&']') {
        let c = *chars.get(*index)?;
        if c == '\\' {
            atoms.push(escape(chars, index)?);
        } else {
            atoms.push(Atom {
                source: if matches!(c, '&' | '~' | '[' | '-') {
                    format!("\\{c}")
                } else {
                    c.to_string()
                },
                scalar: Some(c),
                class: false,
                hyphen: c == '-',
            });
            *index += 1;
        }
    }
    *index += 1;
    let mut out = if negated {
        "[^".to_owned()
    } else {
        "[".to_owned()
    };
    let mut at = 0;
    while at < atoms.len() {
        if !atoms[at].hyphen && atoms.get(at + 1).is_some_and(|a| a.hyphen) && at + 2 < atoms.len()
        {
            let (left, right) = (&atoms[at], &atoms[at + 2]);
            if left.class || right.class {
                // Annex-B legacy ranges with a class endpoint mean a literal hyphen;
                // Unicode-mode RegExp rejects those declarations.
                if unicode {
                    return None;
                }
                out.push_str(&left.source);
                out.push_str(r"\-");
                out.push_str(&right.source);
            } else {
                if left.scalar? > right.scalar? {
                    return None;
                }
                out.push_str(&left.source);
                out.push('-');
                out.push_str(&right.source);
            }
            at += 3;
        } else {
            out.push_str(&atoms[at].source);
            at += 1;
        }
    }
    out.push(']');
    Some(out)
}

fn escape(chars: &[char], index: &mut usize) -> Option<Atom> {
    *index += 1;
    let escaped = *chars.get(*index)?;
    *index += 1;
    let (source, scalar, class) = match escaped {
        'd' => ("[0-9]".to_owned(), None, true),
        'D' => ("[^0-9]".to_owned(), None, true),
        's' | 'S' | 'w' | 'W' => (format!("\\{escaped}"), None, true),
        'x' | 'u' => {
            let count = if escaped == 'x' { 2 } else { 4 };
            let digits = chars
                .get(*index..*index + count)
                .map(|part| part.iter().collect::<String>());
            if let Some(digits) =
                digits.filter(|digits| digits.bytes().all(|b| b.is_ascii_hexdigit()))
            {
                *index += count;
                (
                    format!("\\{escaped}{digits}"),
                    char::from_u32(u32::from_str_radix(&digits, 16).ok()?),
                    false,
                )
            } else {
                (format!("\\{escaped}"), None, false)
            }
        }
        'n' => (r"\n".to_owned(), Some('\n'), false),
        'r' => (r"\r".to_owned(), Some('\r'), false),
        't' => (r"\t".to_owned(), Some('\t'), false),
        'f' => (r"\f".to_owned(), Some('\u{c}'), false),
        'v' => (r"\x0b".to_owned(), Some('\u{b}'), false),
        'b' => (r"\b".to_owned(), None, false),
        '0' => {
            if chars.get(*index).is_some_and(|c| c.is_ascii_digit()) {
                return None;
            }
            (r"\x00".to_owned(), Some('\0'), false)
        }
        c => (format!("\\{c}"), Some(c), false),
    };
    Some(Atom {
        source,
        scalar,
        class,
        hyphen: false,
    })
}
