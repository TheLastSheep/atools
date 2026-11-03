//! Pure normalization and input validation for the renderer alias document.

use std::collections::{BTreeMap, HashMap};

use serde_json::{Map, Value};

use crate::error::{AToolsError, Result};

pub(super) const SETTINGS_KEY: &str = "ztools-renderer:command-aliases";
pub(super) const MAX_STORED_BYTES: usize = 128 * 1024;
pub(super) const MAX_PROJECTION_BYTES: usize = 512 * 1024;
pub(super) const MAX_BUCKETS: usize = 4096;
pub(super) const MAX_ALIASES: usize = 4096;
pub(super) const MAX_COMMAND_ID_BYTES: usize = 16_448;
pub(super) const MAX_ALIAS_BYTES: usize = 512;
pub(super) const MAX_ICON_BYTES: usize = 65_536;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct AliasEntry {
    pub alias: String,
    pub icon: Option<String>,
}

pub(super) type AliasBuckets = BTreeMap<String, Vec<AliasEntry>>;

/// Returns the renderer-facing alias projection without changing stored bytes.
pub fn normalize_renderer_command_aliases(raw: Option<&str>) -> Result<Value> {
    let Some(raw) = raw else {
        return Ok(Value::Null);
    };
    if raw.len() > MAX_STORED_BYTES {
        return Err(invalid("Stored renderer command aliases exceed 128 KiB"));
    }

    let root: Value = serde_json::from_str(raw)?;
    let buckets = normalize_root(&root)?;
    buckets_to_value(&buckets)
}

pub(super) fn normalize_root(root: &Value) -> Result<AliasBuckets> {
    let object = root
        .as_object()
        .ok_or_else(|| invalid("Renderer command aliases must be a JSON object"))?;
    validate_bucket_count(object.len())?;

    let mut buckets = AliasBuckets::new();
    let mut alias_count = 0usize;
    for (command_id, bucket) in object {
        validate_command_id(command_id)?;
        let Some(records) = bucket.as_array() else {
            continue;
        };
        let entries = normalize_records(records, true)?;
        alias_count = alias_count
            .checked_add(entries.len())
            .ok_or_else(|| invalid("Renderer command aliases contain too many aliases"))?;
        if alias_count > MAX_ALIASES {
            return Err(invalid("Renderer command aliases exceed 4096 aliases"));
        }
        if !entries.is_empty() {
            buckets.insert(command_id.clone(), entries);
        }
    }
    ensure_projection_budget(&buckets)?;
    Ok(buckets)
}

/// Parses the normalized value submitted by the renderer into ordered buckets.
pub(super) fn normalize_desired(value: &Value) -> Result<AliasBuckets> {
    ensure_value_budget(
        value,
        MAX_PROJECTION_BYTES,
        "Renderer alias document exceeds 512 KiB",
    )?;
    let object = value
        .as_object()
        .ok_or_else(|| invalid("Desired renderer command aliases must be a JSON object"))?;
    validate_bucket_count(object.len())?;

    let mut buckets = AliasBuckets::new();
    let mut alias_count = 0usize;
    for (command_id, bucket) in object {
        validate_command_id(command_id)?;
        let records = bucket
            .as_array()
            .ok_or_else(|| invalid("Desired renderer alias buckets must be arrays"))?;
        let entries = normalize_records(records, false)?;
        alias_count = alias_count
            .checked_add(entries.len())
            .ok_or_else(|| invalid("Renderer command aliases contain too many aliases"))?;
        if alias_count > MAX_ALIASES {
            return Err(invalid("Renderer command aliases exceed 4096 aliases"));
        }
        if !entries.is_empty() {
            buckets.insert(command_id.clone(), entries);
        }
    }
    ensure_projection_budget(&buckets)?;
    Ok(buckets)
}

pub(super) fn recognize_record(value: &Value) -> Result<Option<AliasEntry>> {
    let (alias, icon) = match value {
        Value::String(alias) => (alias.as_str(), None),
        Value::Object(object) => {
            let Some(alias) = object.get("alias").and_then(Value::as_str) else {
                return Ok(None);
            };
            let icon = object.get("icon").and_then(Value::as_str);
            (alias, icon)
        }
        _ => return Ok(None),
    };
    normalize_alias(alias, icon)
}

pub(super) fn validate_command_id(command_id: &str) -> Result<()> {
    if command_id.is_empty() || command_id.len() > MAX_COMMAND_ID_BYTES {
        return Err(invalid("Renderer command ID must be 1–16448 UTF-8 bytes"));
    }
    Ok(())
}

pub(super) fn buckets_to_value(buckets: &AliasBuckets) -> Result<Value> {
    let mut root = Map::new();
    for (command_id, entries) in buckets {
        if entries.is_empty() {
            continue;
        }
        let records = entries
            .iter()
            .map(|entry| {
                let mut record = Map::new();
                record.insert("alias".to_owned(), Value::String(entry.alias.clone()));
                if let Some(icon) = &entry.icon {
                    record.insert("icon".to_owned(), Value::String(icon.clone()));
                }
                Value::Object(record)
            })
            .collect();
        root.insert(command_id.clone(), Value::Array(records));
    }
    let value = Value::Object(root);
    ensure_value_budget(
        &value,
        MAX_PROJECTION_BYTES,
        "Renderer alias projection exceeds 512 KiB",
    )?;
    Ok(value)
}

pub(super) fn ensure_projection_budget(buckets: &AliasBuckets) -> Result<()> {
    let alias_count = buckets
        .values()
        .try_fold(0usize, |total, entries| total.checked_add(entries.len()));
    if !matches!(alias_count, Some(count) if count <= MAX_ALIASES) {
        return Err(invalid("Renderer command aliases exceed 4096 aliases"));
    }
    buckets_to_value(buckets).map(|_| ())
}

pub(super) fn ensure_value_budget(value: &Value, limit: usize, message: &str) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > limit {
        return Err(invalid(message));
    }
    Ok(())
}

fn normalize_records(records: &[Value], preserve_opaque: bool) -> Result<Vec<AliasEntry>> {
    let mut entries = Vec::<AliasEntry>::new();
    let mut positions = HashMap::<String, usize>::new();
    for value in records {
        let entry = recognize_record(value)?;
        let Some(entry) = entry else {
            if !preserve_opaque {
                return Err(invalid("Desired renderer alias record is invalid"));
            }
            continue;
        };
        if let Some(position) = positions.get(&entry.alias).copied() {
            entries[position].icon = entry.icon;
        } else {
            positions.insert(entry.alias.clone(), entries.len());
            entries.push(entry);
        }
    }
    Ok(entries)
}

fn normalize_alias(alias: &str, icon: Option<&str>) -> Result<Option<AliasEntry>> {
    if alias.len() > MAX_ALIAS_BYTES {
        return Err(invalid("Renderer aliases exceed 512 UTF-8 bytes"));
    }
    let alias = alias.trim_matches(is_javascript_trim_whitespace);
    if alias.is_empty() {
        return Ok(None);
    }
    if alias.len() > MAX_ALIAS_BYTES {
        return Err(invalid("Renderer aliases exceed 512 UTF-8 bytes"));
    }

    let icon = match icon {
        Some(icon) if icon.len() > MAX_ICON_BYTES => {
            return Err(invalid("Renderer alias icons exceed 65536 UTF-8 bytes"));
        }
        Some("") | None => None,
        Some(icon) => Some(icon.to_owned()),
    };
    Ok(Some(AliasEntry {
        alias: alias.to_owned(),
        icon,
    }))
}

fn is_javascript_trim_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

fn validate_bucket_count(count: usize) -> Result<()> {
    if count > MAX_BUCKETS {
        return Err(invalid("Renderer command aliases exceed 4096 buckets"));
    }
    Ok(())
}

fn invalid(message: &str) -> AToolsError {
    AToolsError::Config(message.to_owned())
}
