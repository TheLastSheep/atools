//! Bounded callers use an HTML tokenizer, never regexes, to inspect real asset attributes.

use std::cell::RefCell;

use html5ever::buffer_queue::BufferQueue;
use html5ever::tokenizer::{
    states::RawKind, TagKind, Token, TokenSink, TokenSinkResult, Tokenizer,
};

pub const MAX_HTML_REFERENCES: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HtmlAssetKind {
    Script,
    Stylesheet,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HtmlAssetReference {
    pub kind: HtmlAssetKind,
    pub value: String,
}

#[derive(Debug, Default)]
pub struct HtmlEntryReferences {
    pub assets: Vec<HtmlAssetReference>,
    pub inline_scripts: Vec<String>,
    pub inline_handlers: Vec<String>,
    pub base_href: Option<String>,
    pub inline_scripts_truncated: bool,
    pub inline_handlers_truncated: bool,
}

#[derive(Default)]
struct ReferenceSinkState {
    references: HtmlEntryReferences,
    inline_script: Option<usize>,
}

#[derive(Default)]
struct ReferenceSink(RefCell<ReferenceSinkState>);

impl TokenSink for ReferenceSink {
    type Handle = ();

    fn process_token(&self, token: Token, _: u64) -> TokenSinkResult<()> {
        let Token::TagToken(tag) = token else {
            if let Token::CharacterTokens(text) = token {
                let mut state = self.0.borrow_mut();
                if let Some(index) = state.inline_script {
                    state.references.inline_scripts[index].push_str(&text);
                }
            }
            return TokenSinkResult::Continue;
        };
        let attribute = |name: &str| {
            tag.attrs
                .iter()
                .find(|attr| attr.name.local.as_ref() == name)
                .map(|attr| attr.value.to_string())
        };
        let mut state = self.0.borrow_mut();
        let references = &mut state.references;
        if tag.kind == TagKind::EndTag {
            if tag.name.as_ref() == "script" {
                state.inline_script = None;
            }
            return TokenSinkResult::Continue;
        }
        for attr in &tag.attrs {
            let name = attr.name.local.as_ref();
            if is_event_handler_attribute(name) {
                if references.assets.len()
                    + references.inline_scripts.len()
                    + references.inline_handlers.len()
                    < MAX_HTML_REFERENCES
                {
                    references.inline_handlers.push(attr.value.to_string());
                } else {
                    references.inline_handlers_truncated = true;
                }
            }
        }
        match tag.name.as_ref() {
            "script" => {
                if let Some(value) = attribute("src") {
                    if references.assets.len() <= MAX_HTML_REFERENCES {
                        references.assets.push(HtmlAssetReference {
                            kind: HtmlAssetKind::Script,
                            value,
                        });
                    }
                    state.inline_script = None;
                } else {
                    if references.assets.len()
                        + references.inline_scripts.len()
                        + references.inline_handlers.len()
                        < MAX_HTML_REFERENCES
                    {
                        references.inline_scripts.push(String::new());
                        state.inline_script = Some(references.inline_scripts.len() - 1);
                    } else {
                        references.inline_scripts_truncated = true;
                        state.inline_script = None;
                    }
                }
                return TokenSinkResult::RawData(RawKind::ScriptData);
            }
            "link"
                if attribute("rel").is_some_and(|rel| {
                    rel.split_ascii_whitespace()
                        .any(|word| word.eq_ignore_ascii_case("stylesheet"))
                }) =>
            {
                if let Some(value) = attribute("href") {
                    if references.assets.len() <= MAX_HTML_REFERENCES {
                        references.assets.push(HtmlAssetReference {
                            kind: HtmlAssetKind::Stylesheet,
                            value,
                        });
                    }
                }
            }
            "base" if references.base_href.is_none() => references.base_href = attribute("href"),
            "style" | "xmp" | "iframe" | "noembed" | "noframes" | "noscript" => {
                return TokenSinkResult::RawData(RawKind::Rawtext)
            }
            "title" | "textarea" => return TokenSinkResult::RawData(RawKind::Rcdata),
            "plaintext" => return TokenSinkResult::Plaintext,
            _ => {}
        }
        TokenSinkResult::Continue
    }
}

fn is_event_handler_attribute(name: &str) -> bool {
    matches!(
        name,
        "onabort"
            | "onanimationcancel"
            | "onanimationend"
            | "onanimationiteration"
            | "onanimationstart"
            | "onauxclick"
            | "onbeforeinput"
            | "onbeforematch"
            | "onbeforetoggle"
            | "onblur"
            | "oncancel"
            | "oncanplay"
            | "oncanplaythrough"
            | "onchange"
            | "onclick"
            | "onclose"
            | "oncompositionend"
            | "oncompositionstart"
            | "oncompositionupdate"
            | "oncontextmenu"
            | "oncopy"
            | "oncut"
            | "ondblclick"
            | "ondrag"
            | "ondragend"
            | "ondragenter"
            | "ondragleave"
            | "ondragover"
            | "ondragstart"
            | "ondrop"
            | "ondurationchange"
            | "onemptied"
            | "onended"
            | "onerror"
            | "onfocus"
            | "onformdata"
            | "oninput"
            | "oninvalid"
            | "onkeydown"
            | "onkeypress"
            | "onkeyup"
            | "onload"
            | "onloadeddata"
            | "onloadedmetadata"
            | "onloadstart"
            | "onmousedown"
            | "onmouseenter"
            | "onmouseleave"
            | "onmousemove"
            | "onmouseout"
            | "onmouseover"
            | "onmouseup"
            | "onpaste"
            | "onpause"
            | "onplay"
            | "onplaying"
            | "onpointercancel"
            | "onpointerdown"
            | "onpointerenter"
            | "onpointerleave"
            | "onpointermove"
            | "onpointerout"
            | "onpointerover"
            | "onpointerup"
            | "onprogress"
            | "onratechange"
            | "onreset"
            | "onresize"
            | "onscroll"
            | "onsecuritypolicyviolation"
            | "onseeked"
            | "onseeking"
            | "onselect"
            | "onslotchange"
            | "onstalled"
            | "onsubmit"
            | "onsuspend"
            | "ontimeupdate"
            | "ontoggle"
            | "ontouchcancel"
            | "ontouchend"
            | "ontouchmove"
            | "ontouchstart"
            | "ontransitioncancel"
            | "ontransitionend"
            | "ontransitionrun"
            | "ontransitionstart"
            | "onvolumechange"
            | "onwaiting"
            | "onwheel"
    )
}

/// Extracts actual HTML references, ignoring comments, quoted attributes and inline JS strings.
/// Callers must bound the input bytes before invoking the tokenizer.
pub fn html_entry_references(html: &str) -> HtmlEntryReferences {
    let input = BufferQueue::default();
    input.push_back(html.into());
    let tokenizer = Tokenizer::new(ReferenceSink::default(), Default::default());
    let _ = tokenizer.feed(&input);
    tokenizer.end();
    tokenizer.sink.0.into_inner().references
}

pub fn is_source_entry_path(value: &str) -> bool {
    let path = value
        .split(['?', '#'])
        .next()
        .unwrap_or(value)
        .to_ascii_lowercase();
    if is_uncompiled_script_path(value) {
        return true;
    }
    let mut source_path = path.trim_start_matches('/');
    while source_path.starts_with("./") || source_path.starts_with("../") {
        source_path = source_path.split_once('/').unwrap().1;
    }
    matches!(
        source_path,
        "src/main.js" | "src/index.js" | "src/main.mjs" | "src/index.mjs"
    )
}

/// Preloads are executable JS even under src/. Only source language extensions
/// require compilation; frontend src/main.js conventions apply to HTML entries.
pub fn is_uncompiled_script_path(value: &str) -> bool {
    let path = value
        .split(['?', '#'])
        .next()
        .unwrap_or(value)
        .to_ascii_lowercase();
    [".ts", ".tsx", ".jsx", ".vue", ".svelte"]
        .iter()
        .any(|extension| path.ends_with(extension))
}

/// Decode a local HTML URL path before confinement; encoded traversal must obey
/// exactly the same root boundary as a literal path. Query/fragment are not files.
pub fn local_html_reference_path(value: &str) -> anyhow::Result<String> {
    let path = value.split(['?', '#']).next().unwrap_or(value);
    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let digits = bytes
                .get(index + 1..index + 3)
                .ok_or_else(|| anyhow::anyhow!("Invalid percent-encoded HTML asset path"))?;
            let high = (digits[0] as char)
                .to_digit(16)
                .ok_or_else(|| anyhow::anyhow!("Invalid percent-encoded HTML asset path"))?;
            let low = (digits[1] as char)
                .to_digit(16)
                .ok_or_else(|| anyhow::anyhow!("Invalid percent-encoded HTML asset path"))?;
            decoded.push((high * 16 + low) as u8);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(Into::into)
}

pub fn is_remote_entry(value: &str) -> bool {
    let value = value.trim();
    value
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("http://"))
        || value
            .get(..8)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
        || value.starts_with("//")
}
