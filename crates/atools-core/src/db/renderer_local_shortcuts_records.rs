//! Shortcut DTO validation and bounded array serialization.

use serde_json::value::RawValue;

use super::{invalid, raw, RendererLocalShortcut};
use crate::error::Result;

pub(super) const MAX_SHORTCUTS: usize = 4096;
pub(super) const MAX_STORED_BYTES: usize = 128 * 1024;
pub(super) const MAX_JSON_DEPTH: usize = 8;
pub(super) const MAX_JSON_NODES: usize = 32_768;
pub(super) const MAX_ID_BYTES: usize = 256;
pub(super) const MAX_PATH_BYTES: usize = 16 * 1024;
pub(super) const MAX_NAME_BYTES: usize = 4 * 1024;
pub(super) const MAX_ALIAS_BYTES: usize = 4 * 1024;
const MAX_ICON_BYTES: usize = 64 * 1024;
const MAX_PINYIN_BYTES: usize = 16 * 1024;
const MAX_KEYWORDS: usize = 128;
const MAX_KEYWORD_BYTES: usize = 512;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(super) fn parse_shortcut_snapshot(
    raw_value: Option<&str>,
) -> Result<Vec<RendererLocalShortcut>> {
    let Some(raw) = raw_value else {
        return Ok(Vec::new());
    };
    if raw.len() > MAX_STORED_BYTES {
        return Err(invalid("stored data exceeds 128 KiB"));
    }
    raw::count_json_nodes(raw, 1)?;
    let shortcuts: Vec<RendererLocalShortcut> = serde_json::from_str(raw)
        .map_err(|_| invalid("stored data must be a local-shortcuts array"))?;
    if shortcuts.len() > MAX_SHORTCUTS {
        return Err(invalid("stored array exceeds 4096 entries"));
    }
    for shortcut in &shortcuts {
        validate_shortcut(shortcut)?;
    }
    Ok(shortcuts)
}

pub(super) fn parse_stored_array(raw_value: Option<&str>) -> Result<(Vec<Box<RawValue>>, usize)> {
    let Some(raw) = raw_value else {
        return Ok((Vec::new(), 1));
    };
    if raw.len() > MAX_STORED_BYTES {
        return Err(invalid("stored data exceeds 128 KiB"));
    }
    let node_count = raw::count_json_nodes(raw, 1)?;
    let rows: Vec<Box<RawValue>> = serde_json::from_str(raw)
        .map_err(|_| invalid("stored data must be a local-shortcuts array"))?;
    if rows.len() > MAX_SHORTCUTS {
        return Err(invalid("stored array exceeds 4096 entries"));
    }
    for row in &rows {
        parse_shortcut(row.get())?;
    }
    Ok((rows, node_count))
}

pub(super) fn parse_shortcut(raw: &str) -> Result<RendererLocalShortcut> {
    let shortcut: RendererLocalShortcut =
        serde_json::from_str(raw).map_err(|_| invalid("record fields are invalid"))?;
    validate_shortcut(&shortcut)?;
    Ok(shortcut)
}

pub(super) fn validate_shortcut(shortcut: &RendererLocalShortcut) -> Result<()> {
    validate_id(&shortcut.id)?;
    validate_string(&shortcut.name, "name", MAX_NAME_BYTES, true)?;
    validate_path(&shortcut.path)?;
    if shortcut.added_at > MAX_SAFE_INTEGER {
        return Err(invalid("addedAt exceeds the JavaScript safe integer range"));
    }
    validate_optional_string(shortcut.alias.as_deref(), "alias", MAX_ALIAS_BYTES)?;
    validate_optional_string(shortcut.icon.as_deref(), "icon", MAX_ICON_BYTES)?;
    validate_optional_string(shortcut.pinyin.as_deref(), "pinyin", MAX_PINYIN_BYTES)?;
    validate_optional_string(
        shortcut.pinyin_abbr.as_deref(),
        "pinyinAbbr",
        MAX_PINYIN_BYTES,
    )?;
    if let Some(keywords) = &shortcut.keywords {
        if keywords.len() > MAX_KEYWORDS {
            return Err(invalid("keywords exceed 128 entries"));
        }
        for keyword in keywords {
            validate_string(keyword, "keyword", MAX_KEYWORD_BYTES, false)?;
        }
    }
    Ok(())
}

pub(super) fn validate_id(id: &str) -> Result<()> {
    validate_string(id, "id", MAX_ID_BYTES, true)
}

pub(super) fn validate_path(path: &str) -> Result<()> {
    validate_string(path, "path", MAX_PATH_BYTES, true)
}

pub(super) fn validate_string(
    value: &str,
    field: &'static str,
    max_bytes: usize,
    non_empty: bool,
) -> Result<()> {
    if (non_empty && value.is_empty()) || value.len() > max_bytes {
        return Err(invalid(format!("{field} is invalid")));
    }
    Ok(())
}

fn validate_optional_string(value: Option<&str>, field: &'static str, limit: usize) -> Result<()> {
    if let Some(value) = value {
        validate_string(value, field, limit, false)?;
    }
    Ok(())
}

pub(super) fn normalize_and_derive_pinyin(shortcut: &mut RendererLocalShortcut) {
    shortcut.alias = shortcut
        .alias
        .take()
        .map(|alias| alias.trim().to_owned())
        .filter(|alias| !alias.is_empty());
    let display = shortcut.alias.as_deref().unwrap_or(&shortcut.name);
    shortcut.pinyin = Some(crate::matcher::to_pinyin_full(display));
    shortcut.pinyin_abbr = Some(crate::matcher::to_pinyin_initials(display));
}

pub(super) fn encode_shortcut(shortcut: &RendererLocalShortcut) -> Result<String> {
    let size = super::super::bounded_json::serialized_size(shortcut, MAX_STORED_BYTES)
        .ok_or_else(|| invalid("shortcut exceeds 128 KiB"))?;
    let encoded =
        serde_json::to_string(shortcut).map_err(|_| invalid("shortcut serialization failed"))?;
    if encoded.len() != size {
        return Err(invalid("shortcut serialized size changed after validation"));
    }
    Ok(encoded)
}

pub(super) fn encode_array(rows: &[Box<RawValue>]) -> Result<String> {
    if rows.len() > MAX_SHORTCUTS {
        return Err(invalid("array exceeds 4096 entries"));
    }
    let size = super::super::bounded_json::serialized_size(rows, MAX_STORED_BYTES)
        .ok_or_else(|| invalid("array exceeds 128 KiB"))?;
    let encoded = serde_json::to_string(rows).map_err(|_| invalid("array serialization failed"))?;
    if encoded.len() != size {
        return Err(invalid("array serialized size changed after validation"));
    }
    Ok(encoded)
}
