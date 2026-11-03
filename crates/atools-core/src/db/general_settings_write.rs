//! Shared bounded transaction seam for all `settings-general` patches.

use std::{
    collections::BTreeMap,
    io::{self, Write},
};

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;
use serde_json::{Map, Value};

use super::Database;
use crate::error::{AToolsError, Result};

#[path = "general_settings_renderer_shortcuts.rs"]
mod renderer_shortcuts;

const SETTINGS_KEY: &str = "settings-general";
/// Default for the original General page's tray visibility preference.
pub const DEFAULT_SHOW_TRAY_ICON: bool = true;
const MAX_GENERAL_BYTES: usize = 64 * 1024;
const MAX_PATCH_FIELDS: usize = 128;
const MAX_KEY_BYTES: usize = 128;
const MAX_JSON_DEPTH: usize = 32;
const MAX_WIRE_BYTES: usize = 64 * 1024;
const RESERVED_RECEIPT_BYTES: usize = 1024;

/// Opaque snapshot-bound write prepared before any external native operation.
#[must_use = "a prepared settings write must be committed to persist its changes"]
pub struct GeneralSettingsWritePlan {
    before: Option<String>,
    after: String,
}

impl GeneralSettingsWritePlan {
    /// Returns the exact raw snapshot observed during preparation.
    pub fn before(&self) -> Option<&str> {
        self.before.as_deref()
    }

    /// Returns the validated serialized settings value prepared for commit.
    pub fn after(&self) -> &str {
        &self.after
    }
}

#[derive(Serialize)]
struct MutationRequest<'a> {
    expected: Option<&'a str>,
    changes: &'a BTreeMap<String, Value>,
}

#[derive(Serialize)]
struct ReadResponse<'a> {
    version: u8,
    raw: &'a Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteResponse<'a> {
    version: u8,
    raw: &'a str,
    notification_delivered: bool,
    effects_applied: Vec<&'static str>,
    ai_invalidated: bool,
}

struct BudgetWriter {
    limit: usize,
    bytes: usize,
    exceeded: bool,
}

impl Write for BudgetWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let Some(next) = self.bytes.checked_add(buffer.len()) else {
            self.exceeded = true;
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "serialized budget exceeded",
            ));
        };
        if next > self.limit {
            self.exceeded = true;
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "serialized budget exceeded",
            ));
        }
        self.bytes = next;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Database {
    /// Captures the exact current snapshot and prepares a validated, non-writing patch.
    pub fn prepare_general_settings_write(
        &self,
        expected: Option<&str>,
        changes: &BTreeMap<String, Value>,
    ) -> Result<GeneralSettingsWritePlan> {
        validate_request(expected, changes)?;
        let before = read_current_general_settings(self)?;
        if before.as_deref() != expected {
            return Err(conflict());
        }
        let after = merge_patch(before.as_deref(), changes)?;
        ensure_write_response_budget(&after)?;
        Ok(GeneralSettingsWritePlan { before, after })
    }

    /// Commits a prepared patch only if its captured raw snapshot is still current.
    pub fn commit_general_settings_write(&self, plan: GeneralSettingsWritePlan) -> Result<String> {
        ensure_stored_size(&plan.after)?;
        parse_settings(Some(&plan.after))?;
        ensure_write_response_budget(&plan.after)?;

        let mut connection = self.conn.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = read_stored_raw(&transaction)?;
        parse_settings(current.as_deref())?;
        if current != plan.before {
            return Err(conflict());
        }
        commit_after(transaction, plan.after)
    }

    /// Reads the latest snapshot, applies the patch, and commits under one IMMEDIATE transaction.
    pub fn patch_general_settings_current(
        &self,
        changes: &BTreeMap<String, Value>,
    ) -> Result<String> {
        validate_request(None, changes)?;
        let mut connection = self.conn.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = read_stored_raw(&transaction)?;
        let after = merge_patch(current.as_deref(), changes)?;
        ensure_write_response_budget(&after)?;
        commit_after(transaction, after)
    }
}

pub(in crate::db) fn read_current_general_settings(db: &Database) -> Result<Option<String>> {
    let mut connection = db.conn.lock();
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
    let raw = read_stored_raw(&transaction)?;
    parse_settings(raw.as_deref())?;
    ensure_read_response_budget(&raw)?;
    transaction.commit()?;
    Ok(raw)
}

/// Prepare a renderer-owned nested shortcut patch against the same exact-raw CAS snapshot.
pub(in crate::db) fn prepare_renderer_shortcut_patch(
    db: &Database,
    expected: Option<&str>,
    changes: &BTreeMap<String, Value>,
) -> Result<GeneralSettingsWritePlan> {
    validate_request(expected, changes)?;
    let before = read_current_general_settings(db)?;
    if before.as_deref() != expected {
        return Err(conflict());
    }
    let after = renderer_shortcuts::merge(before.as_deref(), changes)?;
    ensure_write_response_budget(&after)?;
    Ok(GeneralSettingsWritePlan { before, after })
}

fn read_stored_raw(transaction: &Transaction<'_>) -> Result<Option<String>> {
    let byte_length = transaction
        .query_row(
            "SELECT length(CAST(value AS BLOB)) FROM settings WHERE key = ?1",
            params![SETTINGS_KEY],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    let Some(byte_length) = byte_length else {
        return Ok(None);
    };
    let byte_length = usize::try_from(byte_length)
        .map_err(|_| invalid("Stored General settings size is invalid"))?;
    if byte_length > MAX_GENERAL_BYTES {
        return Err(invalid("Stored General settings exceed the 64 KiB limit"));
    }

    let raw = transaction.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![SETTINGS_KEY],
        |row| row.get::<_, String>(0),
    )?;
    ensure_stored_size(&raw)?;
    Ok(Some(raw))
}

fn validate_request(expected: Option<&str>, changes: &BTreeMap<String, Value>) -> Result<()> {
    if expected.is_some_and(|raw| raw.len() > MAX_GENERAL_BYTES) {
        return Err(invalid("Expected General settings exceed the 64 KiB limit"));
    }
    if changes.is_empty() {
        return Err(invalid("General settings patch must not be empty"));
    }
    if changes.len() > MAX_PATCH_FIELDS {
        return Err(invalid("General settings patch exceeds 128 fields"));
    }
    for (key, value) in changes {
        validate_key(key)?;
        validate_nested_value(value, 1)?;
    }

    let request = MutationRequest { expected, changes };
    measure_serialized(
        &request,
        MAX_WIRE_BYTES,
        "General settings request exceeds 64 KiB",
    )?;
    Ok(())
}

fn validate_key(key: &str) -> Result<()> {
    if key.is_empty() || key.len() > MAX_KEY_BYTES {
        return Err(invalid("General settings keys must be 1–128 UTF-8 bytes"));
    }
    if matches!(key, "__proto__" | "prototype" | "constructor") {
        return Err(invalid("General settings contains a forbidden object key"));
    }
    Ok(())
}

fn validate_nested_value(value: &Value, depth: usize) -> Result<()> {
    if depth > MAX_JSON_DEPTH {
        return Err(invalid("General settings JSON exceeds the nesting limit"));
    }
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                validate_key(key)?;
                validate_nested_value(value, depth + 1)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                validate_nested_value(value, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn parse_settings(raw: Option<&str>) -> Result<Map<String, Value>> {
    let Some(raw) = raw else {
        return Ok(Map::new());
    };
    ensure_stored_size(raw)?;
    let value: Value = serde_json::from_str(raw)
        .map_err(|_| invalid("Stored General settings are not valid JSON"))?;
    let settings = value
        .as_object()
        .cloned()
        .ok_or_else(|| invalid("Stored General settings must be a JSON object"))?;
    for value in settings.values() {
        validate_stored_depth(value, 1)?;
    }
    Ok(settings)
}

fn validate_stored_depth(value: &Value, depth: usize) -> Result<()> {
    if depth > MAX_JSON_DEPTH {
        return Err(invalid("Stored General settings exceed the nesting limit"));
    }
    match value {
        Value::Object(object) => {
            for value in object.values() {
                validate_stored_depth(value, depth + 1)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                validate_stored_depth(value, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn merge_patch(current: Option<&str>, changes: &BTreeMap<String, Value>) -> Result<String> {
    let mut settings = parse_settings(current)?;
    for (key, value) in changes {
        settings.insert(key.clone(), value.clone());
    }
    let value = Value::Object(settings);
    let raw = serde_json::to_string(&value)?;
    ensure_stored_size(&raw)?;
    Ok(raw)
}

fn ensure_stored_size(raw: &str) -> Result<()> {
    if raw.len() <= MAX_GENERAL_BYTES {
        Ok(())
    } else {
        Err(invalid("General settings exceed the 64 KiB limit"))
    }
}

fn ensure_read_response_budget(raw: &Option<String>) -> Result<()> {
    let response = ReadResponse { version: 1, raw };
    measure_serialized(
        &response,
        MAX_WIRE_BYTES,
        "General settings response exceeds the 64 KiB limit",
    )?;
    Ok(())
}

fn ensure_write_response_budget(raw: &str) -> Result<()> {
    let response = WriteResponse {
        version: 1,
        raw,
        notification_delivered: false,
        effects_applied: Vec::new(),
        ai_invalidated: false,
    };
    measure_serialized(
        &response,
        MAX_WIRE_BYTES - RESERVED_RECEIPT_BYTES,
        "General settings response exceeds the 64 KiB limit",
    )?;
    Ok(())
}

fn measure_serialized<T: Serialize>(
    value: &T,
    limit: usize,
    message: &'static str,
) -> Result<usize> {
    let mut writer = BudgetWriter {
        limit,
        bytes: 0,
        exceeded: false,
    };
    match serde_json::to_writer(&mut writer, value) {
        Ok(()) => Ok(writer.bytes),
        Err(_error) if writer.exceeded => Err(invalid(message)),
        Err(error) => Err(error.into()),
    }
}

fn commit_after(transaction: Transaction<'_>, raw: String) -> Result<String> {
    transaction.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![SETTINGS_KEY, raw],
    )?;
    transaction.commit()?;
    Ok(raw)
}

fn conflict() -> AToolsError {
    invalid("General settings changed; reload before applying the patch")
}

fn invalid(message: &str) -> AToolsError {
    AToolsError::Config(message.to_owned())
}

#[cfg(test)]
#[path = "general_settings_write_tests.rs"]
mod tests;
