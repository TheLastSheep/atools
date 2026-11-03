//! Current-context-only NSPasteboard read, with limits applied before Rust copies payload bytes.
use crate::pasteboard_runtime::NativePasteboardSnapshot;
#[cfg(target_os = "macos")]
use crate::pasteboard_runtime::{
    NativePasteboardRepresentation, CURRENT_CONTEXT_MAX_FILES,
    CURRENT_CONTEXT_MAX_IMAGE_INPUT_BYTES, CURRENT_CONTEXT_MAX_PATH_BYTES,
    CURRENT_CONTEXT_MAX_RESPONSE_BYTES, CURRENT_CONTEXT_MAX_TEXT_BYTES,
};
#[cfg(target_os = "macos")]
const BUDGET: &str = "CLIPBOARD_CONTEXT_BUDGET: clipboard content exceeds its limit";
#[cfg(target_os = "macos")]
const INVALID: &str = "CLIPBOARD_CONTEXT_UNAVAILABLE: clipboard content is invalid";
#[cfg(target_os = "macos")]
const MAX_FILE_URL_BYTES: usize = CURRENT_CONTEXT_MAX_PATH_BYTES * 3 + 32;
#[cfg(not(target_os = "macos"))]
const UNAVAILABLE: &str = "CLIPBOARD_CONTEXT_UNAVAILABLE: current clipboard is unsupported";

#[cfg(target_os = "macos")]
pub(super) fn current_change_count() -> Result<Option<i64>, String> {
    use objc2_app_kit::NSPasteboard;
    Ok(Some(NSPasteboard::generalPasteboard().changeCount() as i64))
}

#[cfg(not(target_os = "macos"))]
pub(super) fn current_change_count() -> Result<Option<i64>, String> {
    Err(UNAVAILABLE.into())
}

#[cfg(target_os = "macos")]
pub(super) fn snapshot_current_context() -> Result<Option<NativePasteboardSnapshot>, String> {
    let pasteboard = objc2_app_kit::NSPasteboard::generalPasteboard();
    snapshot_from_pasteboard(&pasteboard)
}

#[cfg(target_os = "macos")]
pub(super) fn snapshot_from_pasteboard(
    pasteboard: &objc2_app_kit::NSPasteboard,
) -> Result<Option<NativePasteboardSnapshot>, String> {
    use objc2_app_kit::{
        NSPasteboardTypeFileURL, NSPasteboardTypePNG, NSPasteboardTypeString, NSPasteboardTypeTIFF,
    };
    use objc2_foundation::{NSString, NSUTF8StringEncoding};

    let change_count = pasteboard.changeCount() as i64;
    let copied_at = atools_core::utils::now_iso();
    let mut representations = Vec::new();

    if let Some(paths) = read_file_paths(&pasteboard, unsafe { NSPasteboardTypeFileURL })? {
        representations.push(NativePasteboardRepresentation::Files(paths));
    } else if let Some(image) = read_image(
        &pasteboard,
        unsafe { NSPasteboardTypePNG },
        &NSString::from_str("public.jpeg"),
        unsafe { NSPasteboardTypeTIFF },
    )? {
        representations.push(image);
    } else if let Some(text) = pasteboard.stringForType(unsafe { NSPasteboardTypeString }) {
        if text.lengthOfBytesUsingEncoding(NSUTF8StringEncoding) as usize
            > CURRENT_CONTEXT_MAX_TEXT_BYTES
        {
            return Err(BUDGET.into());
        }
        representations.push(NativePasteboardRepresentation::Text(text.to_string()));
    }

    // Reject a mixed read if the clipboard changed while the selected representation was copied.
    if pasteboard.changeCount() as i64 != change_count {
        return Ok(None);
    }
    Ok(Some(NativePasteboardSnapshot {
        change_count,
        copied_at,
        source_app: None,
        is_confidential: false,
        is_transient: false,
        representations,
    }))
}

#[cfg(not(target_os = "macos"))]
pub(super) fn snapshot_current_context() -> Result<Option<NativePasteboardSnapshot>, String> {
    Err(UNAVAILABLE.into())
}

#[cfg(all(test, target_os = "macos"))]
#[path = "pasteboard_native_current_context_tests.rs"]
mod tests;

#[cfg(target_os = "macos")]
fn read_file_paths(
    pasteboard: &objc2_app_kit::NSPasteboard,
    file_url_type: &objc2_foundation::NSString,
) -> Result<Option<Vec<String>>, String> {
    use objc2_foundation::{NSUTF8StringEncoding, NSURL};

    let Some(items) = pasteboard.pasteboardItems() else {
        return Ok(None);
    };
    if items.len() > CURRENT_CONTEXT_MAX_FILES {
        return Err(BUDGET.into());
    }

    let mut paths = Vec::new();
    let mut total_bytes = 0usize;
    let mut total_encoded_bytes = 0usize;
    for item in items.iter() {
        let Some(raw_url) = item.stringForType(file_url_type) else {
            continue;
        };
        let encoded_len = raw_url.lengthOfBytesUsingEncoding(NSUTF8StringEncoding) as usize;
        if encoded_len > MAX_FILE_URL_BYTES {
            return Err(BUDGET.into());
        }
        total_encoded_bytes = total_encoded_bytes
            .checked_add(encoded_len)
            .filter(|total| *total <= CURRENT_CONTEXT_MAX_RESPONSE_BYTES)
            .ok_or(BUDGET)?;
        let url = NSURL::URLWithString(&raw_url).ok_or(INVALID)?;
        if !url.isFileURL() {
            return Err(INVALID.into());
        }
        let path = url.path().ok_or(INVALID)?.to_string();
        if path.is_empty() || path.len() > CURRENT_CONTEXT_MAX_PATH_BYTES {
            return Err(BUDGET.into());
        }
        total_bytes = total_bytes
            .checked_add(path.len())
            .filter(|total| *total <= CURRENT_CONTEXT_MAX_RESPONSE_BYTES)
            .ok_or(BUDGET)?;
        paths.push(path);
    }
    Ok((!paths.is_empty()).then_some(paths))
}

#[cfg(target_os = "macos")]
fn read_image(
    pasteboard: &objc2_app_kit::NSPasteboard,
    png_type: &objc2_foundation::NSString,
    jpeg_type: &objc2_foundation::NSString,
    tiff_type: &objc2_foundation::NSString,
) -> Result<Option<NativePasteboardRepresentation>, String> {
    for (pasteboard_type, media_type) in [
        (png_type, "image/png"),
        (jpeg_type, "image/jpeg"),
        (tiff_type, "image/tiff"),
    ] {
        let Some(data) = pasteboard.dataForType(pasteboard_type) else {
            continue;
        };
        if data.len() > CURRENT_CONTEXT_MAX_IMAGE_INPUT_BYTES {
            return Err(BUDGET.into());
        }
        {
            // NSPasteboard returns an immutable NSData retained for this read. Check its header
            // before allocating the owned copy, including the shared side/pixel decompression
            // limits. The borrowed slice never outlives `data` and is not mutated here.
            let bytes = unsafe { data.as_bytes_unchecked() };
            crate::launcher_media::image::validate_encoded(bytes, media_type).map_err(|error| {
                if error.starts_with("IMAGE_INPUT_BUDGET:") {
                    BUDGET.to_string()
                } else {
                    INVALID.to_string()
                }
            })?;
        }
        return Ok(Some(NativePasteboardRepresentation::Image {
            bytes: data.to_vec(),
            media_type: media_type.into(),
        }));
    }
    Ok(None)
}
