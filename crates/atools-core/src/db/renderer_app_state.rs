use std::collections::BTreeMap;

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::Database;
use crate::error::{AToolsError, Result};
use renderer_app_state_records::{
    new_app_record, record_launch, record_matches, remove_app_records, reorder_app_pins,
};

#[path = "renderer_app_state_records.rs"]
mod renderer_app_state_records;

const HISTORY_KEY: &str = "command-history";
const PINS_KEY: &str = "pinned-commands";
const HISTORY_STORAGE_KEY: &str = "ztools-renderer:command-history";
const PINS_STORAGE_KEY: &str = "ztools-renderer:pinned-commands";
const REVISION_KEY: &str = "ztools-renderer:app-state-revision";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_ARRAY_ITEMS: usize = 4096;
const MAX_ARRAY_BYTES: usize = 128 * 1024;
const MAX_PATH_BYTES: usize = 16 * 1024;
const MAX_NAME_BYTES: usize = 4096;

/// Stable `Config` message returned when a guarded app-state write is rejected.
pub const RENDERER_APP_STATE_GUARD_REJECTED: &str =
    "Renderer app state mutation rejected by session guard";

#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(rename_all = "kebab-case")]
pub enum RendererDirectSubtype {
    #[default]
    App,
    LocalShortcut,
}

impl RendererDirectSubtype {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::App => "app",
            Self::LocalShortcut => "local-shortcut",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct RendererAppIdentity {
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub sub_type: RendererDirectSubtype,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RendererAppStateMutation {
    RecordLaunch {
        app: RendererAppIdentity,
        now_ms: i64,
    },
    RemoveHistory {
        path: String,
        name: Option<String>,
    },
    Pin {
        app: RendererAppIdentity,
    },
    Unpin {
        path: String,
        name: Option<String>,
    },
    ReorderPins {
        apps: Vec<RendererAppIdentity>,
    },
    ClearPins,
    ClearHistory,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RendererAppStateSnapshot {
    pub version: u8,
    pub revision: u64,
    pub values: BTreeMap<String, Option<String>>,
    pub changed: Vec<String>,
}

impl Database {
    pub fn read_renderer_app_state(&self) -> Result<RendererAppStateSnapshot> {
        let mut connection = self.conn.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
        let (history, pins, revision) = read_state(&transaction)?;
        parse_array(history.as_deref())?;
        parse_array(pins.as_deref())?;
        transaction.commit()?;
        Ok(snapshot(history, pins, revision, Vec::new()))
    }

    pub fn apply_renderer_app_state(
        &self,
        mutation: RendererAppStateMutation,
    ) -> Result<RendererAppStateSnapshot> {
        self.apply_renderer_app_state_guarded(mutation, || true)
    }

    /// Applies an app-state mutation only if `guard` remains true once SQLite
    /// has granted an Immediate transaction, before any state is read or written.
    pub fn apply_renderer_app_state_guarded<F>(
        &self,
        mutation: RendererAppStateMutation,
        guard: F,
    ) -> Result<RendererAppStateSnapshot>
    where
        F: FnOnce() -> bool,
    {
        let mut connection = self.conn.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !guard() {
            return Err(AToolsError::Config(
                RENDERER_APP_STATE_GUARD_REJECTED.to_owned(),
            ));
        }

        let (history_raw, pins_raw, revision) = read_state(&transaction)?;
        let mut history = parse_array(history_raw.as_deref())?;
        let mut pins = parse_array(pins_raw.as_deref())?;
        let mut history_changed = false;
        let mut pins_changed = false;

        match mutation {
            RendererAppStateMutation::RecordLaunch { app, now_ms } => {
                validate_identity(&app)?;
                if !(0..=MAX_SAFE_INTEGER as i64).contains(&now_ms) {
                    return Err(invalid("launch timestamp is outside the safe range"));
                }
                record_launch(&mut history, &app, now_ms)?;
                history_changed = true;
            }
            RendererAppStateMutation::RemoveHistory { path, name } => {
                validate_filter(&path, name.as_deref())?;
                history_changed = remove_app_records(&mut history, &path, name.as_deref(), false);
            }
            RendererAppStateMutation::Pin { app } => {
                validate_identity(&app)?;
                if !pins.iter().any(|value| {
                    record_matches(value, &app.path, Some(&app.name), true, Some(app.sub_type))
                }) {
                    pins.push(new_app_record(&app));
                    pins_changed = true;
                }
            }
            RendererAppStateMutation::Unpin { path, name } => {
                validate_filter(&path, name.as_deref())?;
                pins_changed = remove_app_records(&mut pins, &path, name.as_deref(), true);
            }
            RendererAppStateMutation::ReorderPins { apps } => {
                reorder_app_pins(&mut pins, &apps)?;
                // The original renderer consumes one acknowledgement to clear its
                // optimistic-update flag, including when the order is unchanged.
                pins_changed = true;
            }
            RendererAppStateMutation::ClearPins => {
                pins_changed = pins_raw.is_none()
                    || pins
                        .iter()
                        .any(renderer_app_state_records::is_direct_record);
                pins.retain(|value| !renderer_app_state_records::is_direct_record(value));
            }
            RendererAppStateMutation::ClearHistory => {
                history_changed = history_raw.is_none()
                    || history
                        .iter()
                        .any(renderer_app_state_records::is_direct_record);
                history.retain(|value| !renderer_app_state_records::is_direct_record(value));
            }
        }

        let mut changed = Vec::new();
        let next_history = if history_changed {
            changed.push(HISTORY_KEY.to_owned());
            Some(serialize_array(&history)?)
        } else {
            history_raw
        };
        let next_pins = if pins_changed {
            changed.push(PINS_KEY.to_owned());
            Some(serialize_array(&pins)?)
        } else {
            pins_raw
        };

        let next_revision = if changed.is_empty() {
            revision
        } else {
            let next = revision
                .checked_add(1)
                .filter(|value| *value <= MAX_SAFE_INTEGER)
                .ok_or_else(|| invalid("revision limit exceeded"))?;
            transaction.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
                params![REVISION_KEY, next.to_string()],
            )?;
            if history_changed {
                put_setting(
                    &transaction,
                    HISTORY_STORAGE_KEY,
                    next_history.as_deref().unwrap(),
                )?;
            }
            if pins_changed {
                put_setting(
                    &transaction,
                    PINS_STORAGE_KEY,
                    next_pins.as_deref().unwrap(),
                )?;
            }
            next
        };

        transaction.commit()?;
        Ok(snapshot(next_history, next_pins, next_revision, changed))
    }
}

fn read_state(transaction: &Transaction<'_>) -> Result<(Option<String>, Option<String>, u64)> {
    let history = read_setting(transaction, HISTORY_STORAGE_KEY)?;
    let pins = read_setting(transaction, PINS_STORAGE_KEY)?;
    let revision = read_revision(transaction)?;
    Ok((history, pins, revision))
}

fn read_setting(transaction: &Transaction<'_>, key: &str) -> Result<Option<String>> {
    let byte_length = transaction
        .query_row(
            "SELECT length(CAST(value AS BLOB)) FROM settings WHERE key = ?1",
            params![key],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if let Some(byte_length) = byte_length {
        let byte_length =
            usize::try_from(byte_length).map_err(|_| invalid("stored value size is invalid"))?;
        if byte_length > MAX_ARRAY_BYTES {
            return Err(invalid("stored array exceeds the byte budget"));
        }
        let value = transaction.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )?;
        if value.len() > MAX_ARRAY_BYTES {
            return Err(invalid("stored array exceeds the byte budget"));
        }
        Ok(Some(value))
    } else {
        Ok(None)
    }
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
    let value = transaction
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![REVISION_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    match value {
        None => Ok(0),
        Some(value) => {
            let revision = value
                .parse::<u64>()
                .map_err(|_| invalid("revision metadata is invalid"))?;
            if revision > MAX_SAFE_INTEGER {
                return Err(invalid("revision metadata is outside the safe range"));
            }
            Ok(revision)
        }
    }
}

fn parse_array(raw: Option<&str>) -> Result<Vec<Value>> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    if raw.len() > MAX_ARRAY_BYTES {
        return Err(invalid("stored array exceeds the byte budget"));
    }
    let values: Vec<Value> =
        serde_json::from_str(raw).map_err(|_| invalid("stored array JSON is invalid"))?;
    if values.len() > MAX_ARRAY_ITEMS {
        return Err(invalid("stored array exceeds the item budget"));
    }
    if values.iter().any(|value| !value.is_object()) {
        return Err(invalid("stored array contains a non-object record"));
    }
    validate_array_size(&values)?;
    Ok(values)
}

fn serialize_array(values: &[Value]) -> Result<String> {
    if values.len() > MAX_ARRAY_ITEMS {
        return Err(invalid("array exceeds the item budget"));
    }
    let serialized =
        serde_json::to_string(values).map_err(|_| invalid("array serialization failed"))?;
    validate_serialized_size(serialized.len())?;
    Ok(serialized)
}

fn validate_array_size(values: &[Value]) -> Result<()> {
    let serialized =
        serde_json::to_string(values).map_err(|_| invalid("array serialization failed"))?;
    validate_serialized_size(serialized.len())
}

fn validate_serialized_size(bytes: usize) -> Result<()> {
    if bytes > MAX_ARRAY_BYTES {
        return Err(invalid("array exceeds the byte budget"));
    }
    Ok(())
}

fn snapshot(
    history: Option<String>,
    pins: Option<String>,
    revision: u64,
    changed: Vec<String>,
) -> RendererAppStateSnapshot {
    let values = BTreeMap::from([
        (HISTORY_KEY.to_owned(), history),
        (PINS_KEY.to_owned(), pins),
    ]);
    RendererAppStateSnapshot {
        version: 1,
        revision,
        values,
        changed,
    }
}

fn validate_identity(app: &RendererAppIdentity) -> Result<()> {
    validate_filter(&app.path, Some(&app.name))
}

fn validate_filter(path: &str, name: Option<&str>) -> Result<()> {
    if path.is_empty() || path.len() > MAX_PATH_BYTES {
        return Err(invalid("app path is invalid"));
    }
    if name.is_some_and(|name| name.is_empty() || name.len() > MAX_NAME_BYTES) {
        return Err(invalid("app name is invalid"));
    }
    Ok(())
}

fn put_setting(transaction: &Transaction<'_>, key: &str, value: &str) -> Result<()> {
    transaction.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![key, value],
    )?;
    Ok(())
}

fn invalid(message: &'static str) -> AToolsError {
    AToolsError::Config(format!("Renderer app state {message}"))
}

#[cfg(test)]
#[path = "renderer_app_state_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "renderer_app_state_guarded_tests.rs"]
mod guarded_tests;

#[cfg(test)]
#[path = "renderer_app_state_direct_tests.rs"]
mod direct_tests;
