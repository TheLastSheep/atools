//! Small lexer for static source hints; it never evaluates JavaScript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Token {
    Ident(String),
    String(String),
    Punct(char),
}

pub(super) fn lex(source: &str) -> (Vec<Token>, bool) {
    let bytes = source.as_bytes();
    let (mut tokens, mut index, mut uncertain) = (Vec::new(), 0usize, false);
    while index < bytes.len() {
        let byte = bytes[index];
        if byte.is_ascii_whitespace() {
            index += 1;
            continue;
        }
        if byte == b'/' && bytes.get(index + 1) == Some(&b'/') {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if byte == b'/' && bytes.get(index + 1) == Some(&b'*') {
            index += 2;
            while index + 1 < bytes.len() && &bytes[index..index + 2] != b"*/" {
                index += 1;
            }
            if index + 1 == bytes.len() {
                uncertain = true;
            } else {
                index += 2;
            }
            continue;
        }
        if byte == b'\'' || byte == b'"' {
            let quote = byte;
            index += 1;
            let start = index;
            let mut escaped = false;
            while index < bytes.len() && bytes[index] != quote {
                if bytes[index] == b'\\' {
                    escaped = true;
                    index = (index + 2).min(bytes.len());
                } else {
                    index += 1;
                }
            }
            if index >= bytes.len() {
                uncertain = true;
                break;
            }
            let value = if escaped {
                uncertain = true;
                String::new()
            } else {
                String::from_utf8_lossy(&bytes[start..index]).into_owned()
            };
            index += 1;
            tokens.push(Token::String(value));
            continue;
        }
        if byte == 0x60 {
            index += 1;
            let mut interpolation = false;
            while index < bytes.len() && bytes[index] != 0x60 {
                if bytes[index] == b'\\' {
                    index = (index + 2).min(bytes.len());
                } else {
                    if bytes.get(index) == Some(&b'$') && bytes.get(index + 1) == Some(&b'{') {
                        interpolation = true;
                    }
                    index += 1;
                }
            }
            if index >= bytes.len() {
                uncertain = true;
            } else {
                index += 1;
            }
            uncertain |= interpolation;
            continue;
        }
        if byte.is_ascii_alphabetic() || byte == b'_' || byte == b'$' {
            let start = index;
            index += 1;
            while index < bytes.len()
                && (bytes[index].is_ascii_alphanumeric() || matches!(bytes[index], b'_' | b'$'))
            {
                index += 1;
            }
            tokens.push(Token::Ident(
                String::from_utf8_lossy(&bytes[start..index]).into_owned(),
            ));
            continue;
        }
        if byte == b'/' && regex_can_start(tokens.last()) {
            index += 1;
            let mut in_class = false;
            while index < bytes.len() {
                match bytes[index] {
                    b'\\' => index = (index + 2).min(bytes.len()),
                    b'[' => {
                        in_class = true;
                        index += 1;
                    }
                    b']' => {
                        in_class = false;
                        index += 1;
                    }
                    b'/' if !in_class => {
                        index += 1;
                        while index < bytes.len() && bytes[index].is_ascii_alphabetic() {
                            index += 1;
                        }
                        break;
                    }
                    b'\n' => break,
                    _ => index += 1,
                }
            }
            continue;
        }
        tokens.push(Token::Punct(byte as char));
        index += 1;
    }
    (tokens, uncertain)
}

fn regex_can_start(previous: Option<&Token>) -> bool {
    matches!(
        previous,
        None | Some(Token::Punct(
            '(' | '[' | '{' | '=' | ':' | ',' | ';' | '!' | '?' | '&' | '|'
        ))
    ) || matches!(previous, Some(Token::Ident(word)) if matches!(word.as_str(), "return" | "case" | "throw" | "typeof" | "instanceof" | "in" | "of"))
}
