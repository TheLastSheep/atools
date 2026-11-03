//! Validates the one staged HTML entry allowed to add a smoke observer.
use std::path::Path;

pub(super) const FIXTURE_CSP: &str = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' asset: http://asset.localhost https://asset.localhost atools-plugin://localhost http://atools-plugin.localhost https://atools-plugin.localhost; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: asset: http://asset.localhost https://asset.localhost; connect-src ipc: http://ipc.localhost http://127.0.0.1:*; frame-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'";
pub(super) const CHILD_FIXTURE_CSP: &str = FIXTURE_CSP;

pub(super) fn read_staged_entry(scratch: &Path, entry: &Path) -> Result<Vec<u8>, String> {
    let expected = scratch
        .join("image-toolbox-fixture-entry.html")
        .canonicalize()
        .map_err(|_| "Staged Image-Toolbox entry unavailable")?;
    let metadata =
        std::fs::symlink_metadata(entry).map_err(|_| "Staged Image-Toolbox entry unavailable")?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || entry
            .canonicalize()
            .map_err(|_| "Staged Image-Toolbox entry unavailable")?
            != expected
    {
        return Err("Staged Image-Toolbox entry is outside its fixed fixture location".into());
    }
    let bytes = std::fs::read(entry).map_err(|_| "Staged Image-Toolbox entry unavailable")?;
    let text =
        std::str::from_utf8(&bytes).map_err(|_| "Staged Image-Toolbox entry is not UTF-8")?;
    if !has_exact_child_csp_meta(text) || !text.contains("atools-image-toolbox-smoke") {
        return Err("Staged Image-Toolbox entry is missing its fixture CSP or observer".into());
    }
    Ok(bytes)
}

// The staged entry has a fixed HTML shape; this deliberately small scanner is
// not a general HTML parser. It finds CSP meta tags case-insensitively, then
// counts every http-equiv meta conservatively, then accepts only the one exact
// canonical tag emitted by the fixture.
fn has_exact_child_csp_meta(html: &str) -> bool {
    let Some(html_without_comments) = remove_html_comments(html) else {
        return false;
    };
    let Some(csp_meta_tags) = csp_meta_tags(&html_without_comments) else {
        return false;
    };
    let expected_meta =
        format!("<meta http-equiv=\"Content-Security-Policy\" content=\"{CHILD_FIXTURE_CSP}\">");
    csp_meta_tags.len() == 1 && csp_meta_tags[0] == expected_meta
}

fn csp_meta_tags(html: &str) -> Option<Vec<&str>> {
    let bytes = html.as_bytes();
    let mut tags = Vec::new();
    let mut cursor = 0;
    while cursor + 5 <= bytes.len() {
        if bytes[cursor] != b'<'
            || !bytes[cursor..cursor + 5].eq_ignore_ascii_case(b"<meta")
            || !bytes
                .get(cursor + 5)
                .is_some_and(|byte| byte.is_ascii_whitespace() || matches!(byte, b'/' | b'>'))
        {
            cursor += 1;
            continue;
        }

        let mut quote = None;
        let mut end = cursor + 5;
        while end < bytes.len() {
            let byte = bytes[end];
            match (quote, byte) {
                (Some(current), value) if current == value => quote = None,
                (None, b'\'' | b'\"') => quote = Some(byte),
                (None, b'>') => break,
                _ => {}
            }
            end += 1;
        }
        if end == bytes.len() {
            return None;
        }
        let tag = &html[cursor..=end];
        let lowered = tag.to_ascii_lowercase();
        if lowered.contains("http-equiv") || lowered.contains("content-security-policy") {
            tags.push(tag);
        }
        cursor = end + 1;
    }
    Some(tags)
}

fn remove_html_comments(html: &str) -> Option<String> {
    let mut output = String::with_capacity(html.len());
    let mut remaining = html;
    while let Some(start) = remaining.find("<!--") {
        output.push_str(&remaining[..start]);
        remaining = &remaining[start + 4..];
        let end = remaining.find("-->")?;
        remaining = &remaining[end + 3..];
    }
    output.push_str(remaining);
    Some(output)
}

#[cfg(test)]
mod tests {
    use super::{has_exact_child_csp_meta, CHILD_FIXTURE_CSP, FIXTURE_CSP};

    fn meta(policy: &str) -> String {
        format!("<meta http-equiv=\"Content-Security-Policy\" content=\"{policy}\">")
    }

    fn csp_meta_with(attributes: &str) -> String {
        format!("<meta {attributes}>")
    }

    #[test]
    fn accepts_only_one_exact_child_policy_meta() {
        assert!(has_exact_child_csp_meta(&meta(CHILD_FIXTURE_CSP)));
        assert_eq!(FIXTURE_CSP, CHILD_FIXTURE_CSP);
        assert!(has_exact_child_csp_meta(&meta(FIXTURE_CSP)));
        assert!(!has_exact_child_csp_meta(&meta(
            &CHILD_FIXTURE_CSP.replace("atools-plugin://localhost", "atools-plugin://*",)
        )));
        assert!(!has_exact_child_csp_meta(&meta(&format!(
            "{} *",
            CHILD_FIXTURE_CSP
        ))));
        assert!(!has_exact_child_csp_meta(&format!(
            "{}{}",
            meta(CHILD_FIXTURE_CSP),
            meta(CHILD_FIXTURE_CSP)
        )));
        assert!(!has_exact_child_csp_meta(&format!(
            "{}{}",
            meta(CHILD_FIXTURE_CSP),
            meta(&CHILD_FIXTURE_CSP.replace("localhost", "attacker"))
        )));
        assert!(!has_exact_child_csp_meta(&format!(
            "<!-- {} -->{}",
            meta(CHILD_FIXTURE_CSP),
            meta(&CHILD_FIXTURE_CSP.replace("atools-plugin://localhost", "atools-plugin://*"))
        )));
        assert!(!has_exact_child_csp_meta(&format!(
            "{}{}",
            meta(CHILD_FIXTURE_CSP),
            csp_meta_with("HTTP-EQUIV='Content-Security-Policy' CONTENT='script-src *'")
        )));
        assert!(!has_exact_child_csp_meta(&format!(
            "{}{}",
            meta(CHILD_FIXTURE_CSP),
            csp_meta_with("content='script-src *' http-equiv='content-security-policy'")
        )));
        assert!(!has_exact_child_csp_meta(&format!(
            "{}{}",
            meta(CHILD_FIXTURE_CSP),
            csp_meta_with("http-equiv='Content-Security-&#80;olicy' content='script-src *'")
        )));
        assert!(!has_exact_child_csp_meta(&format!(
            "{}{}",
            meta(CHILD_FIXTURE_CSP),
            csp_meta_with("http-equiv=\"Content-Security-Policy\" content=\"script-src *\"")
        )));
        assert!(has_exact_child_csp_meta(&format!(
            "<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">{}",
            meta(CHILD_FIXTURE_CSP)
        )));
        assert!(!has_exact_child_csp_meta(&format!(
            "<!-- {} -->{}",
            meta(CHILD_FIXTURE_CSP),
            csp_meta_with("http-equiv='Content-Security-Policy' content='script-src *'")
        )));
        assert!(!has_exact_child_csp_meta(&format!(
            "{}<META HTTP-EQUIV='Content-Security-Policy' CONTENT='script-src *'",
            meta(CHILD_FIXTURE_CSP)
        )));
    }
}
