//! Bounded source metadata for the unchanged renderer's command target catalog.
use super::Database;
use crate::{AToolsError, Result};
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::Value;

pub const RENDERER_COMMAND_CATALOG_MAX_METADATA_BYTES: usize = 8 * 1024 * 1024;
pub const RENDERER_COMMAND_CATALOG_MAX_RECORD_BYTES: usize = 512 * 1024;
pub const RENDERER_COMMAND_CATALOG_MAX_PLUGINS: usize = 2048;
pub const RENDERER_COMMAND_CATALOG_MAX_FEATURES: usize = 20_000;
pub const RENDERER_COMMAND_CATALOG_MAX_PLUGIN_ROWS: usize = 16_384;
pub const RENDERER_COMMAND_CATALOG_MAX_LOCAL_SHORTCUTS_BYTES: usize = 128 * 1024;
pub const RENDERER_COMMAND_CATALOG_MAX_LOCAL_SHORTCUTS: usize = 4096;

const LOCAL_SHORTCUTS_KEY: &str = "ztools-renderer:local-shortcuts";

#[derive(Clone, Debug, PartialEq)]
pub struct RendererCommandCatalogSnapshot {
    /// Installed plugin records in the same updated-at order as `list_plugins`.
    /// Each value keeps the original manifest fields, uses the installed canonical
    /// plugin name, and adds installed metadata; dynamic declarations follow static
    /// features in the current Core code order.
    pub plugins: Vec<Value>,
    /// Raw local-shortcuts value from the renderer namespace, if it exists.
    pub local_shortcuts: Option<Value>,
}

impl Database {
    /// Reads all currently stored renderer command metadata from one bounded SQLite snapshot.
    /// Disabled plugins remain in the metadata, matching the pinned renderer's `getAllPlugins`;
    /// this function neither starts a plugin runtime nor changes execution availability.
    pub fn read_renderer_command_catalog(&self) -> Result<RendererCommandCatalogSnapshot> {
        let mut connection = self.conn.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
        preflight(&transaction)?;

        let mut plugins = Vec::new();
        let mut plugin_positions = std::collections::HashMap::new();
        let mut feature_count = 0usize;
        let mut command_rows = 0usize;
        {
            let mut statement = transaction.prepare_cached(
                "SELECT id,name,version,path,enabled,config FROM plugins ORDER BY updated_at DESC",
            )?;
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                let id: String = row.get(0)?;
                let canonical_name: String = row.get(1)?;
                let version: String = row.get(2)?;
                let path: String = row.get(3)?;
                let enabled: bool = row.get(4)?;
                let config: String = row.get(5)?;
                let manifest: Value = serde_json::from_str(&config)
                    .map_err(|_| catalog_error("plugin metadata is invalid"))?;
                let mut metadata = manifest.clone();
                let object = metadata
                    .as_object_mut()
                    .ok_or_else(|| catalog_error("plugin metadata is not an object"))?;
                if !object.contains_key("features") {
                    object.insert("features".into(), Value::Array(Vec::new()));
                }
                let features = object
                    .get_mut("features")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| catalog_error("plugin features are not an array"))?;
                feature_count = feature_count
                    .checked_add(features.len())
                    .ok_or_else(|| catalog_error("feature count overflow"))?;
                if feature_count > RENDERER_COMMAND_CATALOG_MAX_FEATURES {
                    return Err(catalog_error("too many feature records"));
                }
                command_rows = command_rows
                    .checked_add(count_command_rows(features))
                    .ok_or_else(|| catalog_error("command row count overflow"))?;
                if command_rows > RENDERER_COMMAND_CATALOG_MAX_PLUGIN_ROWS {
                    return Err(catalog_error("too many plugin command rows"));
                }
                object.insert("id".into(), Value::String(id.clone()));
                object.insert("name".into(), Value::String(canonical_name));
                object.insert("path".into(), Value::String(path));
                object.insert("version".into(), Value::String(version));
                object.insert("enabled".into(), Value::Bool(enabled));
                plugin_positions.insert(id, plugins.len());
                plugins.push(metadata);
            }
        }

        {
            let mut statement = transaction.prepare_cached(
                "SELECT d.plugin_id,d.declaration FROM plugin_dynamic_features d
                 INNER JOIN plugins p ON p.id=d.plugin_id ORDER BY d.plugin_id,d.code",
            )?;
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                let plugin_id: String = row.get(0)?;
                let declaration: String = row.get(1)?;
                let feature: Value = serde_json::from_str(&declaration)
                    .map_err(|_| catalog_error("dynamic feature metadata is invalid"))?;
                let plugin_index = *plugin_positions
                    .get(&plugin_id)
                    .ok_or_else(|| catalog_error("dynamic feature owner is missing"))?;
                let features = plugins[plugin_index]
                    .get_mut("features")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| catalog_error("plugin features are unavailable"))?;
                feature_count = feature_count
                    .checked_add(1)
                    .ok_or_else(|| catalog_error("feature count overflow"))?;
                if feature_count > RENDERER_COMMAND_CATALOG_MAX_FEATURES {
                    return Err(catalog_error("too many feature records"));
                }
                command_rows = command_rows
                    .checked_add(count_command_rows(std::slice::from_ref(&feature)))
                    .ok_or_else(|| catalog_error("command row count overflow"))?;
                if command_rows > RENDERER_COMMAND_CATALOG_MAX_PLUGIN_ROWS {
                    return Err(catalog_error("too many plugin command rows"));
                }
                features.push(feature);
            }
        }

        let local_shortcuts = read_local_shortcuts(&transaction)?;
        transaction.commit()?;
        Ok(RendererCommandCatalogSnapshot {
            plugins,
            local_shortcuts,
        })
    }
}

fn preflight(transaction: &Transaction<'_>) -> Result<()> {
    let plugin_bytes = bounded_source_bytes(
        transaction,
        "SELECT octet_length(id)+octet_length(name)+octet_length(version)+octet_length(path)
                +octet_length(config)+octet_length(created_at)+octet_length(updated_at)
         FROM plugins LIMIT ?1",
        RENDERER_COMMAND_CATALOG_MAX_PLUGINS,
        "too many installed plugins",
    )?;
    let dynamic_bytes = bounded_source_bytes(
        transaction,
        "SELECT octet_length(d.plugin_id)+octet_length(d.code)+octet_length(d.declaration)
         FROM plugin_dynamic_features d INNER JOIN plugins p ON p.id=d.plugin_id LIMIT ?1",
        RENDERER_COMMAND_CATALOG_MAX_FEATURES,
        "too many dynamic features",
    )?;
    let total = plugin_bytes
        .checked_add(dynamic_bytes)
        .ok_or_else(|| catalog_error("metadata size overflow"))?;
    if total > RENDERER_COMMAND_CATALOG_MAX_METADATA_BYTES {
        return Err(catalog_error("metadata exceeds 8 MiB"));
    }

    let shortcut_bytes: Option<i64> = transaction
        .query_row(
            "SELECT octet_length(value) FROM settings WHERE key=?1",
            [LOCAL_SHORTCUTS_KEY],
            |row| row.get(0),
        )
        .optional()?;
    if shortcut_bytes.is_some_and(|bytes| {
        usize::try_from(bytes).map_or(true, |bytes| {
            bytes > RENDERER_COMMAND_CATALOG_MAX_LOCAL_SHORTCUTS_BYTES
        })
    }) {
        return Err(catalog_error("local shortcuts exceed 128 KiB"));
    }
    Ok(())
}

fn bounded_source_bytes(
    transaction: &Transaction<'_>,
    query: &str,
    maximum_rows: usize,
    too_many_error: &str,
) -> Result<usize> {
    let mut statement = transaction.prepare_cached(query)?;
    let mut rows = statement.query([maximum_rows.saturating_add(1) as i64])?;
    let mut count = 0usize;
    let mut total = 0usize;
    while let Some(row) = rows.next()? {
        count += 1;
        if count > maximum_rows {
            return Err(catalog_error(too_many_error));
        }
        let record_bytes = nonnegative(row.get(0)?)?;
        if record_bytes > RENDERER_COMMAND_CATALOG_MAX_RECORD_BYTES {
            return Err(catalog_error("a metadata record exceeds 512 KiB"));
        }
        total = total
            .checked_add(record_bytes)
            .ok_or_else(|| catalog_error("metadata size overflow"))?;
        if total > RENDERER_COMMAND_CATALOG_MAX_METADATA_BYTES {
            return Err(catalog_error("metadata exceeds 8 MiB"));
        }
    }
    Ok(total)
}

fn read_local_shortcuts(transaction: &Transaction<'_>) -> Result<Option<Value>> {
    let raw: Option<String> = transaction
        .query_row(
            "SELECT CASE WHEN octet_length(value)<=?1 THEN value ELSE NULL END
             FROM settings WHERE key=?2",
            params![
                RENDERER_COMMAND_CATALOG_MAX_LOCAL_SHORTCUTS_BYTES as i64,
                LOCAL_SHORTCUTS_KEY,
            ],
            |row| row.get(0),
        )
        .optional()?;
    raw.map(|raw| {
        let value: Value = serde_json::from_str(&raw)
            .map_err(|_| catalog_error("local shortcuts are invalid JSON"))?;
        if value
            .as_array()
            .is_some_and(|shortcuts| shortcuts.len() > RENDERER_COMMAND_CATALOG_MAX_LOCAL_SHORTCUTS)
        {
            return Err(catalog_error("too many local shortcuts"));
        }
        Ok(value)
    })
    .transpose()
}

fn count_command_rows(features: &[Value]) -> usize {
    features
        .iter()
        .filter_map(|feature| feature.get("cmds").and_then(Value::as_array))
        .flatten()
        .filter(|command| command.is_string() || command.is_object())
        .count()
}

fn nonnegative(value: i64) -> Result<usize> {
    usize::try_from(value).map_err(|_| catalog_error("invalid metadata size"))
}

fn catalog_error(message: &str) -> AToolsError {
    AToolsError::Config(format!(
        "Renderer command catalog budget exceeded: {message}"
    ))
}

#[cfg(test)]
#[path = "renderer_command_catalog_tests.rs"]
mod tests;
