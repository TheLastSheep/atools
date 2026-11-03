//! Lossless persistence for the original renderer's local launch shortcuts.

#[cfg(test)]
#[path = "renderer_local_shortcuts_tests.rs"]
mod tests;

#[path = "renderer_local_shortcuts_records.rs"]
mod records;

#[path = "renderer_local_shortcuts_raw.rs"]
mod raw;

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use super::Database;
use crate::error::{AToolsError, Result};

pub const RENDERER_LOCAL_SHORTCUTS_KEY: &str = "ztools-renderer:local-shortcuts";
const REVISION_KEY: &str = "ztools-renderer:local-shortcuts-revision";
const MAX_REVISION: u64 = 9_007_199_254_740_991;

pub const RENDERER_LOCAL_SHORTCUTS_GUARD_REJECTED: &str =
    "Renderer local shortcuts mutation rejected by session guard";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RendererLocalShortcutType {
    File,
    Folder,
    App,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererLocalShortcut {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub kind: RendererLocalShortcutType,
    pub added_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keywords: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinyin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinyin_abbr: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RendererLocalShortcutIdentity {
    pub id: String,
    pub path: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RendererLocalShortcutMutation {
    Add {
        record: RendererLocalShortcut,
    },
    SetAlias {
        id: String,
        alias: String,
    },
    Remove {
        id: String,
    },
    RemoveMissing {
        expected: Vec<RendererLocalShortcutIdentity>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RendererLocalShortcutWrite {
    pub changed: bool,
    pub revision: u64,
}

impl Database {
    /// Reads the fixed local-shortcut setting without rewriting its raw rows.
    pub fn read_renderer_local_shortcuts(&self) -> Result<Vec<RendererLocalShortcut>> {
        let mut connection = self.conn.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
        let raw = read_raw(&transaction)?;
        let shortcuts = records::parse_shortcut_snapshot(raw.as_deref())?;
        transaction.commit()?;
        Ok(shortcuts)
    }

    /// Applies a guarded mutation against the latest value in an Immediate transaction.
    pub fn apply_renderer_local_shortcut_guarded<F>(
        &self,
        mutation: RendererLocalShortcutMutation,
        guard: F,
    ) -> Result<RendererLocalShortcutWrite>
    where
        F: FnOnce() -> bool,
    {
        let mut connection = self.conn.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !guard() {
            return Err(AToolsError::Config(
                RENDERER_LOCAL_SHORTCUTS_GUARD_REJECTED.to_owned(),
            ));
        }

        let current_raw = read_raw(&transaction)?;
        let (mut rows, mut node_count) = records::parse_stored_array(current_raw.as_deref())?;
        let revision = read_revision(&transaction)?;
        let changed = match mutation {
            RendererLocalShortcutMutation::Add { record } => {
                append_shortcut(&mut rows, &mut node_count, record)?
            }
            RendererLocalShortcutMutation::SetAlias { id, alias } => {
                update_alias(&mut rows, &mut node_count, &id, &alias)?
            }
            RendererLocalShortcutMutation::Remove { id } => {
                remove_id(&mut rows, &mut node_count, &id)?
            }
            RendererLocalShortcutMutation::RemoveMissing { expected } => {
                remove_missing(&mut rows, &mut node_count, &expected)?
            }
        };

        if !changed {
            transaction.commit()?;
            return Ok(RendererLocalShortcutWrite { changed, revision });
        }

        let encoded = records::encode_array(&rows)?;
        let next_revision = revision
            .checked_add(1)
            .filter(|value| *value <= MAX_REVISION)
            .ok_or_else(|| invalid("revision limit exceeded"))?;
        put_setting(&transaction, RENDERER_LOCAL_SHORTCUTS_KEY, &encoded)?;
        put_setting(&transaction, REVISION_KEY, &next_revision.to_string())?;
        transaction.commit()?;
        Ok(RendererLocalShortcutWrite {
            changed: true,
            revision: next_revision,
        })
    }
}

fn append_shortcut(
    rows: &mut Vec<Box<RawValue>>,
    node_count: &mut usize,
    mut record: RendererLocalShortcut,
) -> Result<bool> {
    records::validate_shortcut(&record)?;
    records::normalize_and_derive_pinyin(&mut record);
    records::validate_shortcut(&record)?;
    if rows.len() >= records::MAX_SHORTCUTS {
        return Err(invalid("array exceeds 4096 entries"));
    }
    for row in rows.iter() {
        if records::parse_shortcut(row.get())?.path == record.path {
            return Err(invalid("path already exists"));
        }
    }

    let encoded = records::encode_shortcut(&record)?;
    let added_nodes = raw::count_record_nodes(&encoded)?;
    *node_count = node_count
        .checked_add(added_nodes)
        .filter(|count| *count <= records::MAX_JSON_NODES)
        .ok_or_else(|| invalid("array exceeds 32768 JSON nodes"))?;
    rows.push(RawValue::from_string(encoded).map_err(|_| invalid("shortcut JSON is invalid"))?);
    Ok(true)
}

fn update_alias(
    rows: &mut [Box<RawValue>],
    node_count: &mut usize,
    id: &str,
    alias: &str,
) -> Result<bool> {
    records::validate_id(id)?;
    records::validate_string(alias, "alias", records::MAX_ALIAS_BYTES, false)?;
    let normalized_alias = alias.trim();
    let normalized_alias = (!normalized_alias.is_empty()).then_some(normalized_alias);

    let Some((index, current)) = rows
        .iter()
        .enumerate()
        .find_map(|(index, row)| match records::parse_shortcut(row.get()) {
            Ok(shortcut) if shortcut.id == id => Some(Ok((index, shortcut))),
            Ok(_) => None,
            Err(error) => Some(Err(error)),
        })
        .transpose()?
    else {
        return Ok(false);
    };

    let display_name = normalized_alias.unwrap_or(&current.name);
    let pinyin = crate::matcher::to_pinyin_full(display_name);
    let pinyin_abbr = crate::matcher::to_pinyin_initials(display_name);
    let mut updated = current.clone();
    updated.alias = normalized_alias.map(str::to_owned);
    updated.pinyin = Some(pinyin.clone());
    updated.pinyin_abbr = Some(pinyin_abbr.clone());
    records::validate_shortcut(&updated)?;

    if current.alias.as_deref() == updated.alias.as_deref()
        && current.pinyin.as_deref() == Some(pinyin.as_str())
        && current.pinyin_abbr.as_deref() == Some(pinyin_abbr.as_str())
    {
        return Ok(false);
    }

    let old_nodes = raw::count_record_nodes(rows[index].get())?;
    let encoded = raw::replace_display_fields(
        rows[index].get(),
        updated.alias.as_deref(),
        &pinyin,
        &pinyin_abbr,
    )?;
    let new_nodes = raw::count_record_nodes(&encoded)?;
    *node_count = node_count
        .checked_sub(old_nodes)
        .and_then(|count| count.checked_add(new_nodes))
        .filter(|count| *count <= records::MAX_JSON_NODES)
        .ok_or_else(|| invalid("array exceeds 32768 JSON nodes"))?;
    rows[index] =
        RawValue::from_string(encoded).map_err(|_| invalid("updated shortcut JSON is invalid"))?;
    Ok(true)
}

fn remove_id(rows: &mut Vec<Box<RawValue>>, node_count: &mut usize, id: &str) -> Result<bool> {
    records::validate_id(id)?;
    retain_rows(rows, node_count, |shortcut| shortcut.id != id)
}

fn remove_missing(
    rows: &mut Vec<Box<RawValue>>,
    node_count: &mut usize,
    expected: &[RendererLocalShortcutIdentity],
) -> Result<bool> {
    if expected.len() > records::MAX_SHORTCUTS {
        return Err(invalid("expected list exceeds 4096 entries"));
    }
    let mut identities = std::collections::HashSet::with_capacity(expected.len());
    let mut identity_bytes = 0usize;
    for item in expected {
        records::validate_id(&item.id)?;
        records::validate_path(&item.path)?;
        identity_bytes = identity_bytes
            .checked_add(item.id.len())
            .and_then(|bytes| bytes.checked_add(item.path.len()))
            .filter(|bytes| *bytes <= records::MAX_STORED_BYTES)
            .ok_or_else(|| invalid("expected identities exceed 128 KiB"))?;
        identities.insert((item.id.as_str(), item.path.as_str()));
    }
    retain_rows(rows, node_count, |shortcut| {
        !identities.contains(&(shortcut.id.as_str(), shortcut.path.as_str()))
    })
}

fn retain_rows<F>(
    rows: &mut Vec<Box<RawValue>>,
    node_count: &mut usize,
    mut keep: F,
) -> Result<bool>
where
    F: FnMut(&RendererLocalShortcut) -> bool,
{
    let old_len = rows.len();
    let mut retained = Vec::with_capacity(rows.len());
    let mut removed_nodes = 0usize;
    for row in rows.drain(..) {
        let shortcut = records::parse_shortcut(row.get())?;
        if keep(&shortcut) {
            retained.push(row);
        } else {
            removed_nodes = removed_nodes
                .checked_add(raw::count_record_nodes(row.get())?)
                .ok_or_else(|| invalid("JSON node count overflow"))?;
        }
    }
    let changed = retained.len() != old_len;
    if changed {
        *node_count = node_count
            .checked_sub(removed_nodes)
            .ok_or_else(|| invalid("JSON node count underflow"))?;
        *rows = retained;
    } else {
        *rows = retained;
    }
    Ok(changed)
}

fn read_raw(transaction: &Transaction<'_>) -> Result<Option<String>> {
    let byte_length = transaction
        .query_row(
            "SELECT length(CAST(value AS BLOB)) FROM settings WHERE key = ?1",
            params![RENDERER_LOCAL_SHORTCUTS_KEY],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    let Some(byte_length) = byte_length else {
        return Ok(None);
    };
    let byte_length =
        usize::try_from(byte_length).map_err(|_| invalid("stored size is invalid"))?;
    if byte_length > records::MAX_STORED_BYTES {
        return Err(invalid("stored data exceeds 128 KiB"));
    }
    let raw = transaction.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![RENDERER_LOCAL_SHORTCUTS_KEY],
        |row| row.get::<_, String>(0),
    )?;
    if raw.len() != byte_length {
        return Err(invalid("stored size changed during read"));
    }
    Ok(Some(raw))
}

fn read_revision(transaction: &Transaction<'_>) -> Result<u64> {
    let byte_length = transaction
        .query_row(
            "SELECT length(CAST(value AS BLOB)) FROM settings WHERE key = ?1",
            params![REVISION_KEY],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if byte_length.is_some_and(|length| !(1..=20).contains(&length)) {
        return Err(invalid("revision metadata size is invalid"));
    }
    let raw = transaction
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![REVISION_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    match raw {
        None => Ok(0),
        Some(value) => {
            let revision = value
                .parse::<u64>()
                .map_err(|_| invalid("revision metadata is invalid"))?;
            if revision > MAX_REVISION {
                return Err(invalid("revision metadata exceeds the safe range"));
            }
            Ok(revision)
        }
    }
}

fn put_setting(transaction: &Transaction<'_>, key: &str, value: &str) -> Result<()> {
    transaction.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn invalid(message: impl Into<String>) -> AToolsError {
    AToolsError::Config(format!("Renderer local shortcuts {}", message.into()))
}
