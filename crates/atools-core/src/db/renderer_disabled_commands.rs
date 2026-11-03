//! Fixed-key persistence for the original renderer's disabled command IDs.

#[cfg(test)]
#[path = "renderer_disabled_commands_tests.rs"]
mod tests;

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::Value;

use super::Database;
use crate::error::{AToolsError, Result};

pub const RENDERER_DISABLED_COMMANDS_KEY: &str = "ztools-renderer:disable-commands";
pub const RENDERER_DISABLED_COMMANDS_GUARD_REJECTED: &str =
    "Renderer disabled commands guard rejected";
pub const RENDERER_DISABLED_COMMANDS_CONFLICT: &str =
    "Renderer disabled commands changed since the supplied snapshot";

const MAX_COMMAND_IDS: usize = 4096;
const MAX_COMMAND_ID_BYTES: usize = 16_448;
const MAX_STORED_BYTES: usize = 128 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RendererDisabledCommandsWrite {
    pub changed: bool,
}

impl Database {
    /// Compare-and-swaps the fixed renderer disabled-command setting.
    ///
    /// `expected` is `null` only when the setting is absent; stored JSON null is invalid.
    /// Both values otherwise contain the complete ordered string list, including duplicates.
    pub fn mutate_renderer_disabled_commands_guarded<F>(
        &self,
        expected: &Value,
        desired: &Value,
        guard: F,
    ) -> Result<RendererDisabledCommandsWrite>
    where
        F: FnOnce() -> bool,
    {
        validate_expected(expected)?;
        validate_command_ids(desired, "Desired renderer disabled commands")?;

        let mut connection = self.conn.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !guard() {
            return Err(AToolsError::Config(
                RENDERER_DISABLED_COMMANDS_GUARD_REJECTED.to_owned(),
            ));
        }

        let current_raw = read_raw(&transaction)?;
        let current = parse_stored_value(current_raw.as_deref())?;
        if &current != expected {
            return Err(AToolsError::Config(
                RENDERER_DISABLED_COMMANDS_CONFLICT.to_owned(),
            ));
        }

        if &current == desired {
            transaction.commit()?;
            return Ok(RendererDisabledCommandsWrite { changed: false });
        }

        let encoded = serde_json::to_string(desired)?;
        ensure_encoded_budget(&encoded, "Encoded renderer disabled commands")?;
        transaction.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![RENDERER_DISABLED_COMMANDS_KEY, encoded],
        )?;
        transaction.commit()?;

        Ok(RendererDisabledCommandsWrite { changed: true })
    }
}

fn validate_expected(expected: &Value) -> Result<()> {
    if expected.is_null() {
        return Ok(());
    }
    validate_command_ids(expected, "Expected renderer disabled commands")
}

fn validate_command_ids(value: &Value, label: &str) -> Result<()> {
    let Some(ids) = value.as_array() else {
        return Err(invalid(format!("{label} must be an array of strings")));
    };
    if ids.len() > MAX_COMMAND_IDS {
        return Err(invalid(format!(
            "{label} exceeds {MAX_COMMAND_IDS} entries"
        )));
    }
    for id in ids {
        let Some(id) = id.as_str() else {
            return Err(invalid(format!("{label} must contain only strings")));
        };
        if id.is_empty() {
            return Err(invalid(format!("{label} contains an empty command ID")));
        }
        if id.len() > MAX_COMMAND_ID_BYTES {
            return Err(invalid(format!(
                "{label} contains a command ID over {MAX_COMMAND_ID_BYTES} UTF-8 bytes"
            )));
        }
    }

    ensure_encoded_budget(
        &serde_json::to_string(value)?,
        &format!("{label} encoded storage"),
    )
}

fn read_raw(transaction: &Transaction<'_>) -> Result<Option<String>> {
    let size = transaction
        .query_row(
            "SELECT length(CAST(value AS BLOB)) FROM settings WHERE key = ?1",
            params![RENDERER_DISABLED_COMMANDS_KEY],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    let Some(size) = size else {
        return Ok(None);
    };
    let size = usize::try_from(size)
        .map_err(|_| invalid("Stored renderer disabled command size is invalid"))?;
    if size > MAX_STORED_BYTES {
        return Err(invalid("Stored renderer disabled commands exceed 128 KiB"));
    }

    let raw = transaction.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![RENDERER_DISABLED_COMMANDS_KEY],
        |row| row.get::<_, String>(0),
    )?;
    if raw.len() != size {
        return Err(invalid(
            "Stored renderer disabled command size changed during read",
        ));
    }
    Ok(Some(raw))
}

fn parse_stored_value(raw: Option<&str>) -> Result<Value> {
    let Some(raw) = raw else {
        return Ok(Value::Null);
    };
    let value: Value = serde_json::from_str(raw)?;
    validate_command_ids(&value, "Stored renderer disabled commands")?;
    Ok(value)
}

fn ensure_encoded_budget(encoded: &str, label: &str) -> Result<()> {
    if encoded.len() > MAX_STORED_BYTES {
        return Err(invalid(format!("{label} exceed 128 KiB")));
    }
    Ok(())
}

fn invalid(message: impl Into<String>) -> AToolsError {
    AToolsError::Config(message.into())
}
