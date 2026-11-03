//! Fixed-key, lossless persistence for the original renderer's recommendation pins.

#[cfg(test)]
#[path = "renderer_recommendation_pins_tests.rs"]
mod tests;

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{value::RawValue, Value};

use super::bounded_json;
use super::Database;
use crate::error::{AToolsError, Result};

pub const RENDERER_RECOMMENDATION_PINS_KEY: &str = "ztools-renderer:recommendation-pinned";
pub const RENDERER_RECOMMENDATION_PINS_CONFLICT: &str =
    "Renderer recommendation pins changed since the supplied snapshot";
pub const RENDERER_RECOMMENDATION_PINS_GUARD_REJECTED: &str =
    "Renderer recommendation pins mutation rejected by session guard";

const MAX_PIN_RECORDS: usize = 4096;
const MAX_STORED_BYTES: usize = 128 * 1024;
const MAX_PATH_BYTES: usize = 16 * 1024;
const MAX_NAME_BYTES: usize = 4 * 1024;
const MAX_TYPE_BYTES: usize = 64;
const MAX_FEATURE_FIELD_BYTES: usize = 1024;
const MAX_JSON_DEPTH: usize = 8;
const MAX_JSON_NODES: usize = 8192;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RendererRecommendationPinsMutation {
    Append { pin: Value },
    Remove { index: usize },
    MoveToFront { index: usize },
    Noop,
}

// Serde's internally tagged unit-variant visitor ignores additional map
// entries, even with `deny_unknown_fields`. Keep the public enum's frozen unit
// variant API while deserializing through an empty struct variant for strictness.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum RendererRecommendationPinsMutationWire {
    Append { pin: Value },
    Remove { index: usize },
    MoveToFront { index: usize },
    Noop {},
}

impl<'de> Deserialize<'de> for RendererRecommendationPinsMutation {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(
            match RendererRecommendationPinsMutationWire::deserialize(deserializer)? {
                RendererRecommendationPinsMutationWire::Append { pin } => Self::Append { pin },
                RendererRecommendationPinsMutationWire::Remove { index } => Self::Remove { index },
                RendererRecommendationPinsMutationWire::MoveToFront { index } => {
                    Self::MoveToFront { index }
                }
                RendererRecommendationPinsMutationWire::Noop {} => Self::Noop,
            },
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RendererRecommendationPinsWrite {
    pub changed: bool,
    pub raw: Option<String>,
}

impl Database {
    /// Applies one typed mutation to the ordered recommendation-pins array.
    ///
    /// `expected_raw` is an exact byte-for-byte snapshot; `None` means that the
    /// setting is absent. Existing row JSON tokens are retained through edits.
    pub fn mutate_renderer_recommendation_pins_guarded<F>(
        &self,
        expected_raw: Option<&str>,
        mutation: RendererRecommendationPinsMutation,
        guard: F,
    ) -> Result<RendererRecommendationPinsWrite>
    where
        F: FnOnce() -> bool,
    {
        validate_expected_raw(expected_raw)?;

        let mut connection = self.conn.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !guard() {
            return Err(AToolsError::Config(
                RENDERER_RECOMMENDATION_PINS_GUARD_REJECTED.to_owned(),
            ));
        }

        let current_raw = read_raw(&transaction)?;
        let (mut records, mut node_count) = parse_stored_array(current_raw.as_deref())?;
        if current_raw.as_deref() != expected_raw {
            return Err(AToolsError::Config(
                RENDERER_RECOMMENDATION_PINS_CONFLICT.to_owned(),
            ));
        }

        match mutation {
            RendererRecommendationPinsMutation::Noop => {
                transaction.commit()?;
                return Ok(RendererRecommendationPinsWrite {
                    changed: false,
                    raw: current_raw,
                });
            }
            RendererRecommendationPinsMutation::MoveToFront { index } => {
                if index >= records.len() {
                    return Err(invalid("move index is out of range"));
                }
                if index == 0 {
                    transaction.commit()?;
                    return Ok(RendererRecommendationPinsWrite {
                        changed: false,
                        raw: current_raw,
                    });
                }
                let record = records.remove(index);
                records.insert(0, record);
            }
            RendererRecommendationPinsMutation::Remove { index } => {
                if index >= records.len() {
                    return Err(invalid("remove index is out of range"));
                }
                records.remove(index);
            }
            RendererRecommendationPinsMutation::Append { pin } => {
                if records.len() >= MAX_PIN_RECORDS {
                    return Err(invalid(format!("array exceeds {MAX_PIN_RECORDS} entries")));
                }
                validate_pin_record_fields(&pin, "appended pin")?;
                validate_json_tree(&pin, 2, &mut node_count, "recommendation pins")?;
                let encoded_pin = encode_bounded_value(&pin, "appended pin")?;
                let raw_pin = RawValue::from_string(encoded_pin)
                    .map_err(|_| invalid("appended pin JSON is invalid"))?;
                records.push(raw_pin);
            }
        }

        let encoded = encode_bounded_array(&records)?;
        transaction.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![RENDERER_RECOMMENDATION_PINS_KEY, encoded.as_str()],
        )?;
        transaction.commit()?;

        Ok(RendererRecommendationPinsWrite {
            changed: true,
            raw: Some(encoded),
        })
    }
}

/// Validates one recommendation pin without writing to the database.
///
/// Unknown `type` values and additional JSON fields are accepted, subject to
/// the same per-record field and JSON complexity limits used by storage.
pub fn validate_renderer_recommendation_pin(value: &Value) -> Result<()> {
    validate_pin_record_fields(value, "pin")?;
    let mut nodes = 0;
    validate_json_tree(value, 1, &mut nodes, "pin")?;
    count_serialized_bytes(value, "pin").map(|_| ())
}

fn validate_expected_raw(raw: Option<&str>) -> Result<()> {
    if raw.is_some_and(|value| value.len() > MAX_STORED_BYTES) {
        return Err(invalid("expected snapshot exceeds 128 KiB"));
    }
    Ok(())
}

fn read_raw(transaction: &Transaction<'_>) -> Result<Option<String>> {
    let byte_length = transaction
        .query_row(
            "SELECT length(CAST(value AS BLOB)) FROM settings WHERE key = ?1",
            params![RENDERER_RECOMMENDATION_PINS_KEY],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    let Some(byte_length) = byte_length else {
        return Ok(None);
    };
    let byte_length =
        usize::try_from(byte_length).map_err(|_| invalid("stored value size is invalid"))?;
    if byte_length > MAX_STORED_BYTES {
        return Err(invalid("stored value exceeds 128 KiB"));
    }

    let raw = transaction.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![RENDERER_RECOMMENDATION_PINS_KEY],
        |row| row.get::<_, String>(0),
    )?;
    if raw.len() != byte_length {
        return Err(invalid("stored value size changed during read"));
    }
    Ok(Some(raw))
}

fn parse_stored_array(raw: Option<&str>) -> Result<(Vec<Box<RawValue>>, usize)> {
    let Some(raw) = raw else {
        return Ok((Vec::new(), 1));
    };
    if raw.trim_matches(|character| matches!(character, ' ' | '\n' | '\r' | '\t')) == "null" {
        return Err(invalid("stored JSON null is invalid"));
    }

    let records: Vec<Box<RawValue>> = serde_json::from_str(raw)
        .map_err(|_| invalid("stored JSON must be a recommendation-pins array"))?;
    if records.len() > MAX_PIN_RECORDS {
        return Err(invalid(format!(
            "stored array exceeds {MAX_PIN_RECORDS} entries"
        )));
    }

    let mut node_count = 1; // The recommendation-pins array itself.
    for raw_record in &records {
        let value: Value = serde_json::from_str(raw_record.get())
            .map_err(|_| invalid("stored pin JSON is invalid"))?;
        validate_pin_record_fields(&value, "stored pin")?;
        validate_json_tree(&value, 2, &mut node_count, "stored recommendation pins")?;
    }
    Ok((records, node_count))
}

fn validate_pin_record_fields(value: &Value, label: &str) -> Result<()> {
    let Some(object) = value.as_object() else {
        return Err(invalid(format!("{label} must be an object")));
    };
    validate_string_field(object.get("path"), "path", MAX_PATH_BYTES, label, true)?;
    validate_string_field(object.get("name"), "name", MAX_NAME_BYTES, label, true)?;
    validate_string_field(object.get("type"), "type", MAX_TYPE_BYTES, label, true)?;
    validate_string_field(
        object.get("featureCode"),
        "featureCode",
        MAX_FEATURE_FIELD_BYTES,
        label,
        false,
    )?;
    validate_string_field(
        object.get("pluginName"),
        "pluginName",
        MAX_FEATURE_FIELD_BYTES,
        label,
        false,
    )
}

fn validate_string_field(
    value: Option<&Value>,
    field: &str,
    max_bytes: usize,
    label: &str,
    required: bool,
) -> Result<()> {
    let Some(value) = value else {
        return if required {
            Err(invalid(format!("{label} is missing {field}")))
        } else {
            Ok(())
        };
    };
    let Some(text) = value.as_str() else {
        return Err(invalid(format!("{label} field {field} must be a string")));
    };
    if text.len() > max_bytes {
        return Err(invalid(format!(
            "{label} field {field} exceeds its byte limit"
        )));
    }
    Ok(())
}

fn validate_json_tree(value: &Value, depth: usize, nodes: &mut usize, label: &str) -> Result<()> {
    if depth > MAX_JSON_DEPTH {
        return Err(invalid(format!(
            "{label} exceeds JSON depth {MAX_JSON_DEPTH}"
        )));
    }
    *nodes += 1;
    if *nodes > MAX_JSON_NODES {
        return Err(invalid(format!(
            "{label} exceeds {MAX_JSON_NODES} JSON nodes"
        )));
    }

    match value {
        Value::Array(items) => {
            for item in items {
                validate_json_tree(item, depth + 1, nodes, label)?;
            }
        }
        Value::Object(fields) => {
            for item in fields.values() {
                validate_json_tree(item, depth + 1, nodes, label)?;
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
    Ok(())
}

fn count_serialized_bytes<T: Serialize + ?Sized>(value: &T, label: &str) -> Result<usize> {
    bounded_json::serialized_size(value, MAX_STORED_BYTES)
        .ok_or_else(|| invalid(format!("{label} exceeds 128 KiB or is invalid")))
}

fn encode_bounded_value(value: &Value, label: &str) -> Result<String> {
    let serialized_bytes = count_serialized_bytes(value, label)?;
    let encoded = serde_json::to_string(value)?;
    if encoded.len() != serialized_bytes {
        return Err(invalid(format!(
            "{label} serialized size changed after validation"
        )));
    }
    Ok(encoded)
}

fn encode_bounded_array(records: &[Box<RawValue>]) -> Result<String> {
    let serialized_bytes = count_serialized_bytes(records, "recommendation-pins array")?;
    let encoded = serde_json::to_string(records)?;
    if encoded.len() != serialized_bytes {
        return Err(invalid(
            "recommendation-pins array serialized size changed after validation",
        ));
    }
    Ok(encoded)
}

fn invalid(message: impl Into<String>) -> AToolsError {
    AToolsError::Config(format!("Renderer recommendation pins {}", message.into()))
}
