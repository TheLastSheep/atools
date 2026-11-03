//! Bounded, exact reads of native clipboard format metadata and bytes.
use super::clipboard::ClipboardAccess;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

pub(super) const MAX_FORMAT_NAME_BYTES: usize = 256;
pub(super) const MAX_FORMAT_DATA_BYTES: usize = 256 * 1024;
pub(super) const MAX_FORMAT_RESPONSE_BYTES: usize = 512 * 1024;
const INVALID_FORMAT: &str = "Clipboard format is invalid";
const DATA_LIMIT: &str = "Clipboard format data exceeds 256 KiB";
const RESPONSE_LIMIT: &str = "Clipboard format response exceeds 512 KiB";

pub(super) fn validate_format(format: &str) -> Result<(), String> {
    if format.is_empty()
        || format.len() > MAX_FORMAT_NAME_BYTES
        || !format.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
    {
        return Err(INVALID_FORMAT.into());
    }
    Ok(())
}

pub(super) fn exact_has_format(
    backend: &dyn ClipboardAccess,
    format: &str,
) -> Result<Value, String> {
    validate_format(format)?;
    backend.has_format(format).map(Value::Bool)
}

pub(super) fn exact_read_format(
    backend: &dyn ClipboardAccess,
    format: &str,
) -> Result<Value, String> {
    validate_format(format)?;
    let bytes = backend.read_format(format)?;
    if bytes.len() > MAX_FORMAT_DATA_BYTES {
        return Err(DATA_LIMIT.into());
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let envelope =
        serde_json::to_vec(&json!({ "ok": true, "result": text })).map_err(|_| RESPONSE_LIMIT)?;
    if envelope.len() > MAX_FORMAT_RESPONSE_BYTES {
        return Err(RESPONSE_LIMIT.into());
    }
    Ok(Value::String(text))
}

pub(super) fn exact_read_format_buffer(
    backend: &dyn ClipboardAccess,
    format: &str,
) -> Result<Value, String> {
    validate_format(format)?;
    let bytes = backend.read_format(format)?;
    if bytes.len() > MAX_FORMAT_DATA_BYTES {
        return Err(DATA_LIMIT.into());
    }
    let value = json!({
        "base64": STANDARD.encode(&bytes),
        "byteLength": bytes.len()
    });
    let envelope =
        serde_json::to_vec(&json!({ "ok": true, "result": &value })).map_err(|_| RESPONSE_LIMIT)?;
    if envelope.len() > MAX_FORMAT_RESPONSE_BYTES {
        return Err(RESPONSE_LIMIT.into());
    }
    Ok(value)
}

#[cfg(target_os = "macos")]
pub(super) fn mac_has_format(name: Option<&str>, format: &str) -> Result<bool, String> {
    use objc2_foundation::NSString;

    let pasteboard = native_pasteboard(name)?;
    let format_type = NSString::from_str(format);
    Ok(pasteboard
        .types()
        .is_some_and(|types| types.containsObject(&format_type)))
}

#[cfg(target_os = "macos")]
pub(super) fn mac_read_format(name: Option<&str>, format: &str) -> Result<Vec<u8>, String> {
    use objc2_foundation::NSString;

    let pasteboard = native_pasteboard(name)?;
    let format_type = NSString::from_str(format);
    let Some(data) = pasteboard.dataForType(&format_type) else {
        return Ok(Vec::new());
    };
    // dataForType may materialize an OS-provided value before this length check.
    if data.len() > MAX_FORMAT_DATA_BYTES {
        return Err(DATA_LIMIT.into());
    }
    Ok(data.to_vec())
}

#[cfg(target_os = "macos")]
pub(super) fn native_pasteboard(
    name: Option<&str>,
) -> Result<objc2::rc::Retained<objc2_app_kit::NSPasteboard>, String> {
    use objc2::{msg_send, ClassType};
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::NSString;

    // Cocoa can return nil when its service is unavailable; the generated
    // non-null binding would panic, so model that result explicitly.
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
