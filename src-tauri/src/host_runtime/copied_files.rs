//! Copied file URL metadata only; no file contents, trimming or path-bearing errors.
use super::clipboard::ClipboardAccess;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

pub const MAX_FILES: usize = 128;
pub const MAX_PATH_BYTES: usize = 8 * 1024;
pub const MAX_TOTAL_PATH_BYTES: usize = 64 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const INVALID: &str = "Native clipboard file metadata is unavailable";
const BUDGET: &str = "Clipboard files exceed the response budget";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CopiedFile {
    pub name: String,
    pub path: String,
    pub is_file: bool,
    pub is_directory: bool,
}
fn check_path(path: &str, total: &mut usize) -> Result<(), String> {
    if path.len() > MAX_PATH_BYTES {
        return Err(BUDGET.into());
    }
    *total = total.checked_add(path.len()).ok_or(BUDGET)?;
    if *total > MAX_TOTAL_PATH_BYTES {
        return Err(BUDGET.into());
    }
    if path.is_empty() || path.contains('\0') || !Path::new(path).is_absolute() {
        return Err(INVALID.into());
    }
    Ok(())
}
pub fn exact_files(backend: &dyn ClipboardAccess) -> Result<Value, String> {
    let files = backend.read_files()?;
    if files.len() > MAX_FILES {
        return Err(BUDGET.into());
    }
    let mut total = 0;
    for file in &files {
        check_path(&file.path, &mut total)?;
        if file.name.is_empty()
            || file.name.len() > MAX_PATH_BYTES
            || file.name.contains('\0')
            || file.is_file == file.is_directory
        {
            return Err(INVALID.into());
        }
    }
    let value = serde_json::to_value(files).map_err(|_| INVALID)?;
    // Include the actual HTTP envelope so its bookkeeping cannot bypass the cap.
    if serde_json::to_vec(&json!({"ok":true,"result":value}))
        .map_err(|_| INVALID)?
        .len()
        > MAX_RESPONSE_BYTES
    {
        return Err(BUDGET.into());
    }
    Ok(value)
}
pub(super) fn describe_paths(paths: Vec<String>) -> Result<Vec<CopiedFile>, String> {
    if paths.len() > MAX_FILES {
        return Err(BUDGET.into());
    }
    let mut total = 0;
    for path in &paths {
        check_path(path, &mut total)?;
    }
    paths
        .into_iter()
        .map(|path| {
            let native = Path::new(&path);
            let name = native
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or(INVALID)?
                .to_string();
            let metadata = std::fs::metadata(native).map_err(|_| INVALID)?;
            if !metadata.is_file() && !metadata.is_dir() {
                return Err(INVALID.into());
            }
            Ok(CopiedFile {
                name,
                path,
                is_file: metadata.is_file(),
                is_directory: metadata.is_dir(),
            })
        })
        .collect()
}
#[cfg(target_os = "macos")]
pub(super) fn mac_read(name: Option<&str>) -> Result<Vec<CopiedFile>, String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL};
    use objc2_foundation::{NSString, NSURL};
    let pasteboard = match name {
        Some(name) => NSPasteboard::pasteboardWithName(&NSString::from_str(name)),
        None => NSPasteboard::generalPasteboard(),
    };
    let Some(items) = pasteboard.pasteboardItems() else {
        return Ok(Vec::new());
    };
    // Bound native enumeration as well as the returned file count.
    if items.len() > MAX_FILES {
        return Err(BUDGET.into());
    }
    let mut paths = Vec::new();
    let mut total = 0;
    for item in items.iter() {
        let Some(raw) = item.stringForType(unsafe { NSPasteboardTypeFileURL }) else {
            continue;
        };
        // An encoded URL can be up to three bytes per decoded path byte, plus its scheme.
        if raw.len() > MAX_PATH_BYTES * 3 + 32 {
            return Err(BUDGET.into());
        }
        let url = NSURL::URLWithString(&raw).ok_or(INVALID)?;
        if !url.isFileURL() {
            return Err(INVALID.into());
        }
        if url
            .host()
            .is_some_and(|host| !host.is_empty() && host.to_string() != "localhost")
        {
            return Err(INVALID.into());
        }
        let path = url.path().ok_or(INVALID)?.to_string();
        check_path(&path, &mut total)?;
        paths.push(path);
    }
    describe_paths(paths)
}
#[cfg(target_os = "macos")]
pub(super) fn mac_write(name: Option<&str>, paths: &[String]) -> Result<(), String> {
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSURL};
    let urls: Vec<_> = paths
        .iter()
        .map(|p| NSURL::fileURLWithPath(&NSString::from_str(p)))
        .collect();
    let objects: Vec<&ProtocolObject<dyn NSPasteboardWriting>> = urls
        .iter()
        .map(|url| ProtocolObject::from_ref(&**url))
        .collect();
    let pasteboard = name.map_or_else(NSPasteboard::generalPasteboard, |name| {
        NSPasteboard::pasteboardWithName(&NSString::from_str(name))
    });
    pasteboard.clearContents();
    if pasteboard.writeObjects(&NSArray::from_slice(&objects)) {
        Ok(())
    } else {
        Err("Native file pasteboard write failed".into())
    }
}
#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
pub(super) fn write_named(name: &str, paths: &[String]) -> Result<(), String> {
    mac_write(Some(name), paths)
}
