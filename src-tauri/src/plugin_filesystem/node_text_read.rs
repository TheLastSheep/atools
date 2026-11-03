//! Narrow sync-compatible readFileSync adapter for the legacy Node bridge.
use super::{DocumentAccess, DocumentBytesFailure, ScopedDocumentRoot};
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};

const MAX_PATH_BYTES: usize = 8 * 1024;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024 - 256;

#[cfg(all(test, unix))]
#[path = "node_text_read_tests.rs"]
mod tests;

#[derive(Debug, PartialEq, Eq)]
enum ReadPlan {
    Unsupported,
    Path(PathBuf, String),
}

/// Handles only the exact native bridge envelope. `handled:false` delegates
/// unsupported paths and files to the original Node implementation; schema errors fail.
pub(crate) async fn handle(request: &Value) -> Result<Value, String> {
    let plan = parse_request(request).map_err(|()| native_error("EINVAL"))?;
    let ReadPlan::Path(parent, leaf) = plan else {
        return Ok(json!({"handled":false}));
    };
    #[cfg(not(unix))]
    {
        let _ = (parent, leaf);
        return Ok(json!({"handled":false}));
    }
    #[cfg(unix)]
    {
        let result = super::node_text_io::run(move |guard| {
            guard.ensure_current()?;
            read_utf8_path(&parent, &leaf)
        })
        .await?;
        Ok(result.map_or_else(
            || json!({"handled":false}),
            |value| json!({"handled":true,"value":value}),
        ))
    }
}

fn parse_request(request: &Value) -> Result<ReadPlan, ()> {
    let object = request.as_object().ok_or(())?;
    if object.len() != 2
        || object.get("method").and_then(Value::as_str) != Some("readTextPath")
        || !object.contains_key("params")
    {
        return Err(());
    }
    let params = object.get("params").and_then(Value::as_object).ok_or(())?;
    if params.len() != 1 {
        return Err(());
    }
    let path = params.get("path").and_then(Value::as_str).ok_or(())?;
    Ok(parse_absolute_path(path)
        .map(|(parent, leaf)| ReadPlan::Path(parent, leaf))
        .unwrap_or(ReadPlan::Unsupported))
}

pub(super) fn parse_absolute_path(path: &str) -> Option<(PathBuf, String)> {
    if path.len() > MAX_PATH_BYTES || !path.starts_with('/') || path.contains('\0') {
        return None;
    }
    let mut pieces = path[1..].split('/');
    let components: Vec<_> = pieces.by_ref().collect();
    if components.is_empty()
        || components
            .iter()
            .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return None;
    }
    let parsed = Path::new(path);
    if parsed
        .components()
        .any(|part| !matches!(part, Component::RootDir | Component::Normal(_)))
    {
        return None;
    }
    let leaf = components.last()?.to_string();
    let parent = parsed.parent()?;
    if leaf.is_empty() || parent.as_os_str().is_empty() {
        return None;
    }
    Some((parent.to_path_buf(), leaf))
}

#[cfg(unix)]
fn read_utf8_path(parent: &Path, leaf: &str) -> Result<Option<String>, String> {
    let root = ScopedDocumentRoot::open(parent, DocumentAccess::ReadOnly)
        .map_err(|error| native_error(error.code()))?;
    let bytes = match root.read_bytes(leaf) {
        Ok(bytes) => bytes,
        Err(DocumentBytesFailure::Unsupported(_)) => return Ok(None),
        Err(DocumentBytesFailure::Error(error)) => return Err(native_error(error.code())),
    };
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let response = json!({"handled":true,"value":text});
    if serde_json::to_vec(&response)
        .map_err(|_| native_error("EIO"))?
        .len()
        > MAX_RESPONSE_BYTES
    {
        return Ok(None);
    }
    Ok(Some(text))
}

fn native_error(code: &str) -> String {
    format!("ERR_ATOOLS_NATIVE_FS:{code}")
}
