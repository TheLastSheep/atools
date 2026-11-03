use super::Database;
use crate::error::Result;
use rusqlite::{params, params_from_iter, types::Value, TransactionBehavior};
use std::collections::{BTreeMap, BTreeSet};

const MAX_SETTINGS_BATCH_KEYS: usize = 32;
const MAX_SETTINGS_KEY_BYTES: usize = 256;
const MAX_SETTINGS_VALUE_BYTES: usize = 1024 * 1024;
const MAX_SETTINGS_TOTAL_BYTES: usize = 4 * 1024 * 1024;
const GENERAL_SETTINGS_MAX_BYTES: usize = 64 * 1024;

impl Database {
    // ---- Settings (key-value) ----

    /// Retrieves a setting value by key.
    ///
    /// Returns None if the key does not exist.
    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached("SELECT value FROM settings WHERE key = ?1")?;

        let result = stmt.query_row(params![key], |row| row.get::<_, String>(0));

        match result {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Sets a setting value.
    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock();
        let mut stmt =
            conn.prepare_cached("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)")?;
        stmt.execute(params![key, value])?;
        Ok(())
    }

    /// Deletes a setting.
    pub fn delete_setting(&self, key: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let rows = conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
        Ok(rows > 0)
    }

    /// Reads a fixed batch of settings while enforcing byte budgets before any
    /// setting value is copied out of SQLite.
    pub fn read_settings_bounded(
        &self,
        keys: &[&str],
        per_value_limit: usize,
        total_limit: usize,
    ) -> Result<BTreeMap<String, Option<String>>> {
        if keys.is_empty()
            || keys.len() > MAX_SETTINGS_BATCH_KEYS
            || per_value_limit == 0
            || per_value_limit > MAX_SETTINGS_VALUE_BYTES
            || total_limit == 0
            || per_value_limit > total_limit
            || total_limit > MAX_SETTINGS_TOTAL_BYTES
        {
            return Err(crate::error::AToolsError::Config(
                "Invalid bounded settings read limits".into(),
            ));
        }

        let mut unique_keys = BTreeSet::new();
        let mut response_bytes = 0usize;
        for key in keys {
            if key.is_empty() || key.len() > MAX_SETTINGS_KEY_BYTES || !unique_keys.insert(*key) {
                return Err(crate::error::AToolsError::Config(
                    "Invalid bounded settings read keys".into(),
                ));
            }
            response_bytes = response_bytes.checked_add(key.len()).ok_or_else(|| {
                crate::error::AToolsError::Config("Settings response budget exceeded".into())
            })?;
        }
        if response_bytes > total_limit {
            return Err(crate::error::AToolsError::Config(
                "Settings response budget exceeded".into(),
            ));
        }

        let placeholders = (2..=keys.len() + 1)
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(", ");
        let query = format!(
            "SELECT key, length(CAST(value AS BLOB)), \
             CASE WHEN length(CAST(value AS BLOB)) <= \
               CASE WHEN key = 'settings-general' THEN MIN(?1, {GENERAL_SETTINGS_MAX_BYTES}) ELSE ?1 END \
             THEN value ELSE NULL END \
             FROM settings WHERE key IN ({placeholders})"
        );

        let mut bindings = Vec::with_capacity(keys.len() + 1);
        bindings.push(Value::Integer(i64::try_from(per_value_limit).map_err(
            |_| crate::error::AToolsError::Config("Invalid bounded settings read limits".into()),
        )?));
        bindings.extend(keys.iter().map(|key| Value::Text((*key).to_owned())));

        let mut conn = self.conn.lock();
        let transaction = conn.transaction_with_behavior(TransactionBehavior::Deferred)?;
        let mut values = BTreeMap::new();
        {
            let mut statement = transaction.prepare_cached(&query)?;
            let mut rows = statement.query(params_from_iter(bindings.iter()))?;
            while let Some(row) = rows.next()? {
                let key = row.get::<_, String>(0)?;
                let value_bytes = usize::try_from(row.get::<_, i64>(1)?).map_err(|_| {
                    crate::error::AToolsError::Config("Invalid setting value size".into())
                })?;
                let key_limit = if key == "settings-general" {
                    per_value_limit.min(GENERAL_SETTINGS_MAX_BYTES)
                } else {
                    per_value_limit
                };
                if value_bytes > key_limit {
                    return Err(crate::error::AToolsError::Config(
                        "Setting value exceeds the configured byte limit".into(),
                    ));
                }
                response_bytes = response_bytes.checked_add(value_bytes).ok_or_else(|| {
                    crate::error::AToolsError::Config("Settings response budget exceeded".into())
                })?;
                if response_bytes > total_limit {
                    return Err(crate::error::AToolsError::Config(
                        "Settings response budget exceeded".into(),
                    ));
                }
                let value = row.get::<_, Option<String>>(2)?.ok_or_else(|| {
                    crate::error::AToolsError::Config("Setting value could not be read".into())
                })?;
                values.insert(key, Some(value));
            }
        }
        transaction.commit()?;

        for key in keys {
            values.entry((*key).to_owned()).or_insert(None);
        }
        Ok(values)
    }
}

#[cfg(test)]
#[path = "settings_snapshot_tests.rs"]
mod snapshot_tests;
