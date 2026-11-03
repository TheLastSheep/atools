//! Bounded, exact HTML clipboard content shared with an optional plain-text form.
use serde::Serialize;
use serde_json::{Map, Value};

pub(crate) const MAX_HTML_CONTENT_BYTES: usize = 256 * 1024;
pub(crate) const MAX_HTML_WIRE_BYTES: usize = 512 * 1024;
const INVALID: &str = "Invalid clipboard HTML content";
const CONTENT_LIMIT: &str = "Clipboard HTML and text exceed 256 KiB";
const WIRE_LIMIT: &str = "Clipboard HTML request exceeds 512 KiB";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HtmlWriteRequest {
    html: String,
    text: Option<String>,
}

#[derive(Serialize)]
struct HtmlWire<'a> {
    kind: &'static str,
    html: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<&'a str>,
}

impl HtmlWriteRequest {
    pub(crate) fn parse(fields: &Map<String, Value>) -> Result<Self, String> {
        if fields.len() < 2
            || fields.len() > 3
            || fields
                .keys()
                .any(|key| !matches!(key.as_str(), "kind" | "html" | "text"))
            || fields.get("kind").and_then(Value::as_str) != Some("html")
        {
            return Err(INVALID.into());
        }
        let html = fields.get("html").and_then(Value::as_str).ok_or(INVALID)?;
        let text = match fields.get("text") {
            None => None,
            Some(Value::String(value)) => Some(value.as_str()),
            Some(_) => return Err(INVALID.into()),
        };
        let content_bytes = html
            .len()
            .checked_add(text.map_or(0, str::len))
            .ok_or(CONTENT_LIMIT)?;
        if content_bytes > MAX_HTML_CONTENT_BYTES {
            return Err(CONTENT_LIMIT.into());
        }
        let wire = HtmlWire {
            kind: "html",
            html,
            text,
        };
        if serde_json::to_vec(&wire).map_err(|_| INVALID)?.len() > MAX_HTML_WIRE_BYTES {
            return Err(WIRE_LIMIT.into());
        }
        Ok(Self {
            html: html.to_owned(),
            text: text.map(str::to_owned),
        })
    }

    pub(crate) fn html(&self) -> &str {
        &self.html
    }

    pub(crate) fn text(&self) -> Option<&str> {
        self.text.as_deref()
    }
}

#[cfg(target_os = "macos")]
pub(super) fn mac_write_html(
    name: Option<&str>,
    html: &str,
    text: Option<&str>,
) -> Result<(), String> {
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{
        NSPasteboardItem, NSPasteboardTypeHTML, NSPasteboardTypeString, NSPasteboardWriting,
    };
    use objc2_foundation::{NSArray, NSString};

    let item = NSPasteboardItem::new();
    if !item.setString_forType(&NSString::from_str(html), unsafe { NSPasteboardTypeHTML }) {
        return Err("Native HTML clipboard item could not be prepared".into());
    }
    if let Some(text) = text {
        if !item.setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString }) {
            return Err("Native text clipboard item could not be prepared".into());
        }
    }
    let object: &ProtocolObject<dyn NSPasteboardWriting> = ProtocolObject::from_ref(&*item);
    let objects = NSArray::from_slice(&[object]);
    let pasteboard = native_pasteboard(name)?;
    pasteboard.clearContents();
    if pasteboard.writeObjects(&objects) {
        Ok(())
    } else {
        Err("Native HTML clipboard write failed".into())
    }
}

#[cfg(target_os = "macos")]
fn native_pasteboard(
    name: Option<&str>,
) -> Result<objc2::rc::Retained<objc2_app_kit::NSPasteboard>, String> {
    use objc2::{msg_send, ClassType};
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::NSString;

    // Cocoa's service may return nil in sandboxed/launchd contexts despite the
    // generated non-null binding; receiving nil through that binding would panic.
    let pasteboard: Option<objc2::rc::Retained<NSPasteboard>> = match name {
        Some(name) => unsafe {
            msg_send![NSPasteboard::class(), pasteboardWithName: &*NSString::from_str(name)]
        },
        None => unsafe { msg_send![NSPasteboard::class(), generalPasteboard] },
    };
    pasteboard.ok_or_else(|| "Native clipboard pasteboard is unavailable".into())
}

#[cfg(all(target_os = "macos", test))]
pub(super) fn mac_clear_named(name: &str) {
    if let Ok(pasteboard) = native_pasteboard(Some(name)) {
        pasteboard.clearContents();
    }
}

#[cfg(all(target_os = "macos", test))]
pub(super) fn mac_read_html_text(name: &str) -> Result<(Option<String>, Option<String>), String> {
    use objc2_app_kit::{NSPasteboardTypeHTML, NSPasteboardTypeString};

    let pasteboard = native_pasteboard(Some(name))?;
    let html = pasteboard
        .stringForType(unsafe { NSPasteboardTypeHTML })
        .map(|value| value.to_string());
    let text = pasteboard
        .stringForType(unsafe { NSPasteboardTypeString })
        .map(|value| value.to_string());
    Ok((html, text))
}
