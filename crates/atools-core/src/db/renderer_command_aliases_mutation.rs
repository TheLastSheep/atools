//! SQLite transaction and semantic bucket merge for renderer command aliases.

use std::collections::{BTreeSet, HashMap};

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{Map, Value};

use super::normalize::{
    buckets_to_value, ensure_value_budget, normalize_desired, normalize_root, recognize_record,
    validate_command_id, AliasBuckets, AliasEntry, MAX_PROJECTION_BYTES, MAX_STORED_BYTES,
    SETTINGS_KEY,
};
use super::Database;
use crate::error::{AToolsError, Result};

#[derive(Clone, Debug, PartialEq)]
pub struct RendererCommandAliasesSnapshot {
    pub raw: Option<String>,
    pub value: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RendererCommandAliasesWrite {
    pub raw: Option<String>,
    pub value: Value,
    pub changed: bool,
}

pub(super) fn read(database: &Database) -> Result<RendererCommandAliasesSnapshot> {
    let mut connection = database.conn.lock();
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
    let raw = read_raw(&transaction)?;
    let value = match raw.as_deref() {
        None => Value::Null,
        Some(_) => buckets_to_value(&read_buckets(raw.as_deref())?)?,
    };
    transaction.commit()?;
    Ok(RendererCommandAliasesSnapshot { raw, value })
}

pub(super) fn mutate(
    database: &Database,
    expected: Option<&str>,
    desired: &Value,
) -> Result<RendererCommandAliasesWrite> {
    mutate_guarded(database, expected, desired, || true)
}

pub(super) fn mutate_guarded<F>(
    database: &Database,
    expected: Option<&str>,
    desired: &Value,
    guard: F,
) -> Result<RendererCommandAliasesWrite>
where
    F: FnOnce() -> bool,
{
    if expected.is_some_and(|raw| raw.len() > MAX_STORED_BYTES) {
        return Err(invalid("Expected renderer command aliases exceed 128 KiB"));
    }
    let desired_buckets = normalize_desired(desired)?;

    let mut connection = database.conn.lock();
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if !guard() {
        return Err(invalid(
            "Renderer command alias session closed before transaction start",
        ));
    }
    let current_raw = read_raw(&transaction)?;
    if current_raw.as_deref() != expected {
        return Err(invalid(
            "Renderer command aliases changed since the supplied snapshot",
        ));
    }

    let current_buckets = read_buckets(current_raw.as_deref())?;
    if current_buckets == desired_buckets {
        transaction.commit()?;
        let value = match current_raw.as_deref() {
            None => Value::Null,
            Some(_) => buckets_to_value(&current_buckets)?,
        };
        return Ok(RendererCommandAliasesWrite {
            raw: current_raw,
            value,
            changed: false,
        });
    }

    let mut root = match current_raw.as_deref() {
        Some(raw) => serde_json::from_str::<Value>(raw)?
            .as_object()
            .cloned()
            .ok_or_else(|| invalid("Renderer command aliases must be a JSON object"))?,
        None => Map::new(),
    };
    merge_changed_buckets(&mut root, &current_buckets, &desired_buckets)?;

    let updated_raw = if root.is_empty() {
        None
    } else {
        let encoded = Value::Object(root).to_string();
        if encoded.len() > MAX_STORED_BYTES {
            return Err(invalid("Stored renderer command aliases exceed 128 KiB"));
        }
        Some(encoded)
    };
    let updated_buckets = read_buckets(updated_raw.as_deref())?;
    if updated_buckets != desired_buckets {
        return Err(invalid(
            "Renderer alias merge did not produce the requested projection",
        ));
    }
    let updated_value = match updated_raw.as_deref() {
        None => Value::Null,
        Some(_) => buckets_to_value(&updated_buckets)?,
    };
    ensure_value_budget(
        &updated_value,
        MAX_PROJECTION_BYTES,
        "Renderer alias projection exceeds 512 KiB",
    )?;

    match updated_raw.as_deref() {
        Some(raw) => {
            transaction.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![SETTINGS_KEY, raw],
            )?;
        }
        None => {
            transaction.execute("DELETE FROM settings WHERE key = ?1", params![SETTINGS_KEY])?;
        }
    }
    transaction.commit()?;

    Ok(RendererCommandAliasesWrite {
        raw: updated_raw,
        value: updated_value,
        changed: true,
    })
}

fn read_buckets(raw: Option<&str>) -> Result<AliasBuckets> {
    let Some(raw) = raw else {
        return Ok(AliasBuckets::new());
    };
    if raw.len() > MAX_STORED_BYTES {
        return Err(invalid("Stored renderer command aliases exceed 128 KiB"));
    }
    let root: Value = serde_json::from_str(raw)?;
    normalize_root(&root)
}

fn read_raw(transaction: &Transaction<'_>) -> Result<Option<String>> {
    let size = transaction
        .query_row(
            "SELECT length(CAST(value AS BLOB)) FROM settings WHERE key = ?1",
            params![SETTINGS_KEY],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    let Some(size) = size else {
        return Ok(None);
    };
    let size = usize::try_from(size)
        .map_err(|_| invalid("Stored renderer command alias size is invalid"))?;
    if size > MAX_STORED_BYTES {
        return Err(invalid("Stored renderer command aliases exceed 128 KiB"));
    }
    let raw = transaction.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![SETTINGS_KEY],
        |row| row.get::<_, String>(0),
    )?;
    if raw.len() != size {
        return Err(invalid(
            "Stored renderer command alias size changed during read",
        ));
    }
    Ok(Some(raw))
}

fn merge_changed_buckets(
    root: &mut Map<String, Value>,
    current: &AliasBuckets,
    desired: &AliasBuckets,
) -> Result<()> {
    let command_ids = current
        .keys()
        .chain(desired.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    for command_id in command_ids {
        let current_entries = current.get(&command_id);
        let desired_entries = desired.get(&command_id);
        if current_entries == desired_entries {
            continue;
        }
        validate_command_id(&command_id)?;

        match root.get(&command_id) {
            Some(Value::Array(records)) => {
                match merge_bucket(
                    records,
                    desired_entries.map_or(&[][..], |entries| entries.as_slice()),
                )? {
                    Some(value) => {
                        root.insert(command_id, value);
                    }
                    None => {
                        root.remove(&command_id);
                    }
                }
            }
            Some(_) => {
                return Err(invalid(
                    "Desired aliases conflict with an opaque renderer alias bucket",
                ));
            }
            None => {
                if let Some(entries) = desired_entries {
                    root.insert(command_id, new_bucket(entries));
                }
            }
        }
    }
    Ok(())
}

fn merge_bucket(existing: &[Value], desired: &[AliasEntry]) -> Result<Option<Value>> {
    let mut recognized = HashMap::<String, Vec<Value>>::new();
    let mut opaque = Vec::<Value>::new();
    for record in existing {
        match recognize_record(record)? {
            Some(entry) => recognized
                .entry(entry.alias)
                .or_default()
                .push(record.clone()),
            None => opaque.push(record.clone()),
        }
    }

    let mut merged = Vec::new();
    for wanted in desired {
        match recognized.remove(&wanted.alias) {
            Some(mut records) => {
                let previous_icon = records
                    .last()
                    .and_then(|record| recognize_record(record).ok().flatten())
                    .and_then(|entry| entry.icon);
                if previous_icon != wanted.icon {
                    replace_last_icon(&mut records, wanted)?;
                }
                merged.extend(records);
            }
            None => merged.push(new_record(wanted)),
        }
    }
    merged.extend(opaque);
    if merged.is_empty() {
        Ok(None)
    } else {
        Ok(Some(Value::Array(merged)))
    }
}

fn replace_last_icon(records: &mut [Value], wanted: &AliasEntry) -> Result<()> {
    let Some(last) = records.last_mut() else {
        return Err(invalid("Renderer alias record is missing"));
    };
    match last {
        Value::Object(object) => match &wanted.icon {
            Some(icon) => {
                object.insert("icon".to_owned(), Value::String(icon.clone()));
            }
            None => {
                object.remove("icon");
            }
        },
        Value::String(_) => {
            *last = new_record(wanted);
        }
        _ => return Err(invalid("Renderer alias record is invalid")),
    }
    Ok(())
}

fn new_bucket(entries: &[AliasEntry]) -> Value {
    Value::Array(entries.iter().map(new_record).collect())
}

fn new_record(entry: &AliasEntry) -> Value {
    let mut record = Map::new();
    record.insert("alias".to_owned(), Value::String(entry.alias.clone()));
    if let Some(icon) = &entry.icon {
        record.insert("icon".to_owned(), Value::String(icon.clone()));
    }
    Value::Object(record)
}

fn invalid(message: &str) -> AToolsError {
    AToolsError::Config(message.to_owned())
}
