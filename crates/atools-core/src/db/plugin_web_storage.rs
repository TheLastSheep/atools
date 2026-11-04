//! Persistent, plugin-isolated Web Storage values stored as UTF-16 code units.
//!
//! This store is deliberately separate from `plugin_data`/`dbStorage`: browser
//! `localStorage` has string-only semantics and must preserve arbitrary DOMStrings.

use std::fmt;

use rusqlite::{params, OptionalExtension, TransactionBehavior};

use super::Database;

pub const PLUGIN_WEB_STORAGE_MAX_KEY_BYTES: usize = 2 * 1024;
pub const PLUGIN_WEB_STORAGE_MAX_VALUE_BYTES: usize = 128 * 1024;
pub const PLUGIN_WEB_STORAGE_MAX_ENTRIES: u64 = 4096;
pub const PLUGIN_WEB_STORAGE_MAX_KEYS_BYTES: u64 = 256 * 1024;
pub const PLUGIN_WEB_STORAGE_MAX_TOTAL_BYTES: u64 = 5 * 1024 * 1024;
pub const PLUGIN_WEB_STORAGE_KEYS_OUTPUT_BUDGET_BYTES: usize = 512 * 1024;
/// Conservative JSON wire budget for one paginated entries response.
pub const PLUGIN_WEB_STORAGE_ENTRIES_PAGE_BUDGET_BYTES: usize = 384 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginWebStorageEntry {
    pub key: Vec<u16>,
    pub value: Vec<u16>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginWebStorageEntriesPage {
    pub entries: Vec<PluginWebStorageEntry>,
    pub next_offset: Option<u32>,
}

/// Stable errors that never include plugin keys, values, or SQLite internals.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PluginWebStorageError {
    QuotaExceeded,
    InvalidInput,
    StorageUnavailable,
}

impl fmt::Display for PluginWebStorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::QuotaExceeded => "Web Storage quota exceeded",
            Self::InvalidInput => "Invalid Web Storage input",
            Self::StorageUnavailable => "Web Storage is unavailable",
        })
    }
}

impl std::error::Error for PluginWebStorageError {}

/// Describes whether a localStorage mutation changed the stored value.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginWebStorageChange {
    pub key: Option<Vec<u16>>,
    pub old_value: Option<Vec<u16>>,
    pub new_value: Option<Vec<u16>>,
    pub changed: bool,
}

impl Database {
    pub fn plugin_web_storage_get(
        &self,
        plugin_id: &str,
        key: &[u16],
    ) -> Result<Option<Vec<u16>>, PluginWebStorageError> {
        validate_plugin_id(plugin_id)?;
        let key = encode_units(key);
        validate_key_bytes(&key)?;
        let conn = self.conn.lock();
        let value: Option<Vec<u8>> = conn
            .query_row(
                "SELECT value FROM plugin_web_storage WHERE plugin_id = ?1 AND key = ?2",
                params![plugin_id, key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| PluginWebStorageError::StorageUnavailable)?;
        value.map(|bytes| decode_units(&bytes)).transpose()
    }

    pub fn plugin_web_storage_length(&self, plugin_id: &str) -> Result<u32, PluginWebStorageError> {
        validate_plugin_id(plugin_id)?;
        let conn = self.conn.lock();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM plugin_web_storage WHERE plugin_id = ?1",
                [plugin_id],
                |row| row.get(0),
            )
            .map_err(|_| PluginWebStorageError::StorageUnavailable)?;
        u32::try_from(count).map_err(|_| PluginWebStorageError::StorageUnavailable)
    }

    /// Returns the key at a zero-based insertion-order index, or `None` when absent.
    pub fn plugin_web_storage_key(
        &self,
        plugin_id: &str,
        index: u32,
    ) -> Result<Option<Vec<u16>>, PluginWebStorageError> {
        validate_plugin_id(plugin_id)?;
        let conn = self.conn.lock();
        let key: Option<Vec<u8>> = conn
            .query_row(
                "SELECT key FROM plugin_web_storage WHERE plugin_id = ?1 ORDER BY rowid LIMIT 1 OFFSET ?2",
                params![plugin_id, i64::from(index)],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| PluginWebStorageError::StorageUnavailable)?;
        key.map(|bytes| decode_units(&bytes)).transpose()
    }

    /// Returns keys in insertion order, bounded by the public encoded-output budget.
    pub fn plugin_web_storage_keys(
        &self,
        plugin_id: &str,
    ) -> Result<Vec<Vec<u16>>, PluginWebStorageError> {
        validate_plugin_id(plugin_id)?;
        let conn = self.conn.lock();
        let mut statement = conn
            .prepare_cached(
                "SELECT key FROM plugin_web_storage WHERE plugin_id = ?1 ORDER BY rowid",
            )
            .map_err(|_| PluginWebStorageError::StorageUnavailable)?;
        let rows = statement
            .query_map([plugin_id], |row| row.get::<_, Vec<u8>>(0))
            .map_err(|_| PluginWebStorageError::StorageUnavailable)?;
        let mut keys = Vec::new();
        let mut encoded_bytes = 0usize;
        for row in rows {
            let bytes = row.map_err(|_| PluginWebStorageError::StorageUnavailable)?;
            let row_cost = bytes
                .len()
                .checked_add(std::mem::size_of::<u32>())
                .ok_or(PluginWebStorageError::StorageUnavailable)?;
            encoded_bytes = encoded_bytes
                .checked_add(row_cost)
                .filter(|size| *size <= PLUGIN_WEB_STORAGE_KEYS_OUTPUT_BUDGET_BYTES)
                .ok_or(PluginWebStorageError::StorageUnavailable)?;
            keys.push(decode_units(&bytes)?);
        }
        Ok(keys)
    }

    /// Reads one bounded insertion-order page. Pages are independent reads: no
    /// lock or SQLite snapshot is retained between calls, so concurrent writes
    /// can shift offsets and cause a later page to skip or repeat entries.
    pub fn plugin_web_storage_entries(
        &self,
        plugin_id: &str,
        offset: u32,
    ) -> Result<PluginWebStorageEntriesPage, PluginWebStorageError> {
        validate_plugin_id(plugin_id)?;
        let conn = self.conn.lock();
        let mut statement = conn
            .prepare_cached(
                "SELECT key, value FROM plugin_web_storage WHERE plugin_id = ?1 ORDER BY rowid LIMIT ?2 OFFSET ?3",
            )
            .map_err(|_| PluginWebStorageError::StorageUnavailable)?;
        let rows = statement
            .query_map(
                params![
                    plugin_id,
                    PLUGIN_WEB_STORAGE_MAX_ENTRIES as i64,
                    i64::from(offset)
                ],
                |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, Vec<u8>>(1)?)),
            )
            .map_err(|_| PluginWebStorageError::StorageUnavailable)?;
        let mut entries = Vec::new();
        let mut wire_cost = 128usize;
        let mut has_more = false;
        for row in rows {
            let (key, value) = row.map_err(|_| PluginWebStorageError::StorageUnavailable)?;
            let row_cost = base64_len(key.len())
                .checked_add(base64_len(value.len()))
                .and_then(|size| size.checked_add(32))
                .ok_or(PluginWebStorageError::StorageUnavailable)?;
            if wire_cost.saturating_add(row_cost) > PLUGIN_WEB_STORAGE_ENTRIES_PAGE_BUDGET_BYTES {
                has_more = true;
                break;
            }
            wire_cost += row_cost;
            entries.push(PluginWebStorageEntry {
                key: decode_units(&key)?,
                value: decode_units(&value)?,
            });
        }
        let next_offset = if has_more {
            Some(
                offset
                    .checked_add(entries.len() as u32)
                    .ok_or(PluginWebStorageError::StorageUnavailable)?,
            )
        } else {
            None
        };
        Ok(PluginWebStorageEntriesPage {
            entries,
            next_offset,
        })
    }

    pub fn plugin_web_storage_set(
        &self,
        plugin_id: &str,
        key: &[u16],
        value: &[u16],
    ) -> Result<PluginWebStorageChange, PluginWebStorageError> {
        validate_plugin_id(plugin_id)?;
        let key = encode_units(key);
        let value = encode_units(value);
        validate_key_bytes(&key)?;
        if value.len() > PLUGIN_WEB_STORAGE_MAX_VALUE_BYTES {
            return Err(PluginWebStorageError::QuotaExceeded);
        }

        let mut conn = self.conn.lock();
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| PluginWebStorageError::StorageUnavailable)?;
        let old_value: Option<Vec<u8>> = transaction
            .query_row(
                "SELECT value FROM plugin_web_storage WHERE plugin_id = ?1 AND key = ?2",
                params![plugin_id, &key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| PluginWebStorageError::StorageUnavailable)?;

        if old_value.as_deref() == Some(value.as_slice()) {
            transaction
                .commit()
                .map_err(|_| PluginWebStorageError::StorageUnavailable)?;
            return change(Some(key), old_value, Some(value), false);
        }

        let (count, key_bytes, total_bytes) = usage(&transaction, plugin_id)?;
        let old_len = old_value.as_ref().map_or(0, Vec::len) as u64;
        let is_new_key = old_value.is_none();
        let new_key_increment = if is_new_key { key.len() as u64 } else { 0 };
        let new_count = count + u64::from(is_new_key as u8);
        let new_key_bytes = key_bytes
            .checked_add(new_key_increment)
            .ok_or(PluginWebStorageError::QuotaExceeded)?;
        let new_total_bytes = total_bytes
            .checked_sub(old_len)
            .and_then(|bytes| bytes.checked_add(value.len() as u64))
            .and_then(|bytes| bytes.checked_add(new_key_increment))
            .ok_or(PluginWebStorageError::QuotaExceeded)?;
        if new_count > PLUGIN_WEB_STORAGE_MAX_ENTRIES
            || new_key_bytes > PLUGIN_WEB_STORAGE_MAX_KEYS_BYTES
            || new_total_bytes > PLUGIN_WEB_STORAGE_MAX_TOTAL_BYTES
        {
            return Err(PluginWebStorageError::QuotaExceeded);
        }

        transaction
            .execute(
                "INSERT INTO plugin_web_storage(plugin_id, key, value) VALUES (?1, ?2, ?3) ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value",
                params![plugin_id, key, value],
            )
            .map_err(|_| PluginWebStorageError::StorageUnavailable)?;
        transaction
            .commit()
            .map_err(|_| PluginWebStorageError::StorageUnavailable)?;
        change(Some(key), old_value, Some(value), true)
    }

    pub fn plugin_web_storage_remove(
        &self,
        plugin_id: &str,
        key: &[u16],
    ) -> Result<PluginWebStorageChange, PluginWebStorageError> {
        validate_plugin_id(plugin_id)?;
        let key = encode_units(key);
        validate_key_bytes(&key)?;
        let mut conn = self.conn.lock();
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| PluginWebStorageError::StorageUnavailable)?;
        let old_value: Option<Vec<u8>> = transaction
            .query_row(
                "SELECT value FROM plugin_web_storage WHERE plugin_id = ?1 AND key = ?2",
                params![plugin_id, &key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| PluginWebStorageError::StorageUnavailable)?;
        if old_value.is_some() {
            transaction
                .execute(
                    "DELETE FROM plugin_web_storage WHERE plugin_id = ?1 AND key = ?2",
                    params![plugin_id, key],
                )
                .map_err(|_| PluginWebStorageError::StorageUnavailable)?;
        }
        transaction
            .commit()
            .map_err(|_| PluginWebStorageError::StorageUnavailable)?;
        let changed = old_value.is_some();
        change(Some(key), old_value, None, changed)
    }

    pub fn plugin_web_storage_clear(
        &self,
        plugin_id: &str,
    ) -> Result<PluginWebStorageChange, PluginWebStorageError> {
        validate_plugin_id(plugin_id)?;
        let mut conn = self.conn.lock();
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| PluginWebStorageError::StorageUnavailable)?;
        let changed = transaction
            .execute(
                "DELETE FROM plugin_web_storage WHERE plugin_id = ?1",
                [plugin_id],
            )
            .map_err(|_| PluginWebStorageError::StorageUnavailable)?
            > 0;
        transaction
            .commit()
            .map_err(|_| PluginWebStorageError::StorageUnavailable)?;
        Ok(PluginWebStorageChange {
            key: None,
            old_value: None,
            new_value: None,
            changed,
        })
    }
}

fn validate_plugin_id(plugin_id: &str) -> Result<(), PluginWebStorageError> {
    if plugin_id.trim().is_empty() {
        Err(PluginWebStorageError::InvalidInput)
    } else {
        Ok(())
    }
}

fn validate_key_bytes(key: &[u8]) -> Result<(), PluginWebStorageError> {
    if key.len() > PLUGIN_WEB_STORAGE_MAX_KEY_BYTES {
        Err(PluginWebStorageError::QuotaExceeded)
    } else {
        Ok(())
    }
}

fn encode_units(units: &[u16]) -> Vec<u8> {
    units.iter().flat_map(|unit| unit.to_le_bytes()).collect()
}

fn base64_len(bytes: usize) -> usize {
    bytes.div_ceil(3) * 4
}

fn decode_units(bytes: &[u8]) -> Result<Vec<u16>, PluginWebStorageError> {
    if !bytes.len().is_multiple_of(2) {
        return Err(PluginWebStorageError::StorageUnavailable);
    }
    Ok(bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect())
}

fn usage(
    transaction: &rusqlite::Transaction<'_>,
    plugin_id: &str,
) -> Result<(u64, u64, u64), PluginWebStorageError> {
    let (count, keys, total): (i64, i64, i64) = transaction
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(length(key)), 0), COALESCE(SUM(length(key) + length(value)), 0) FROM plugin_web_storage WHERE plugin_id = ?1",
            [plugin_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| PluginWebStorageError::StorageUnavailable)?;
    Ok((
        u64::try_from(count).map_err(|_| PluginWebStorageError::StorageUnavailable)?,
        u64::try_from(keys).map_err(|_| PluginWebStorageError::StorageUnavailable)?,
        u64::try_from(total).map_err(|_| PluginWebStorageError::StorageUnavailable)?,
    ))
}

fn change(
    key: Option<Vec<u8>>,
    old_value: Option<Vec<u8>>,
    new_value: Option<Vec<u8>>,
    changed: bool,
) -> Result<PluginWebStorageChange, PluginWebStorageError> {
    Ok(PluginWebStorageChange {
        key: key.as_deref().map(decode_units).transpose()?,
        old_value: old_value.as_deref().map(decode_units).transpose()?,
        new_value: new_value.as_deref().map(decode_units).transpose()?,
        changed,
    })
}
