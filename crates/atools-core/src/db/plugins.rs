use super::{feature_catalog, plugin_dynamic_features_index, Database};
use crate::error::{AToolsError, Result};
use crate::models::{Feature, Plugin, PluginManifest};
use rusqlite::{params, Connection, TransactionBehavior};

impl Database {
    // ---- Plugin CRUD ----

    /// Saves a plugin record to the database.
    ///
    /// If a plugin with the same ID already exists, its metadata is updated in place so
    /// child rows such as plugin documents and attachments remain intact.
    pub fn save_plugin(&self, plugin: &Plugin) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        Self::upsert_plugin(&tx, plugin)?;
        let bank = if plugin.enabled {
            Some(feature_catalog::validate_mutation(
                &tx,
                &self.feature_catalog.lock(),
            )?)
        } else {
            None
        };
        tx.commit()?;
        self.feature_catalog.lock().publish_mutation(bank);
        Ok(())
    }

    /// Atomically saves plugin metadata and replaces that plugin's feature index.
    pub fn save_plugin_with_features(&self, plugin: &Plugin, features: &[Feature]) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        Self::upsert_plugin(&tx, plugin)?;
        Self::replace_features(&tx, &plugin.id, features)?;
        let bank = if plugin.enabled {
            Some(feature_catalog::validate_mutation(
                &tx,
                &self.feature_catalog.lock(),
            )?)
        } else {
            None
        };
        tx.commit()?;
        self.feature_catalog.lock().publish_mutation(bank);
        Ok(())
    }

    /// Refreshes builtin metadata and its static feature index during startup.
    ///
    /// Existing rows retain their user-managed `enabled` state and original
    /// `created_at`; new rows use both values from `plugin`. Metadata and feature
    /// replacement commit together, without replacing plugin documents or attachments.
    pub fn refresh_builtin_plugin_metadata_with_features(
        &self,
        plugin: &Plugin,
        features: &[Feature],
    ) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        Self::upsert_builtin_plugin_metadata(&tx, plugin)?;
        Self::replace_features(&tx, &plugin.id, features)?;

        let persisted_enabled: bool = tx.query_row(
            "SELECT enabled FROM plugins WHERE id = ?1",
            params![plugin.id],
            |row| row.get(0),
        )?;
        let bank = if persisted_enabled {
            Some(feature_catalog::validate_mutation(
                &tx,
                &self.feature_catalog.lock(),
            )?)
        } else {
            None
        };

        tx.commit()?;
        self.feature_catalog.lock().publish_mutation(bank);
        Ok(())
    }

    fn upsert_plugin(conn: &Connection, plugin: &Plugin) -> Result<()> {
        let config_json = serde_json::to_string(&plugin.manifest)?;
        conn.execute(
            r#"
            INSERT INTO plugins (id, name, version, path, enabled, config, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                version = excluded.version,
                path = excluded.path,
                enabled = excluded.enabled,
                config = excluded.config,
                updated_at = excluded.updated_at
            "#,
            params![
                plugin.id,
                plugin.name,
                plugin.version,
                plugin.path,
                plugin.enabled,
                config_json,
                plugin.created_at,
                plugin.updated_at,
            ],
        )?;
        Ok(())
    }

    fn upsert_builtin_plugin_metadata(conn: &Connection, plugin: &Plugin) -> Result<()> {
        let config_json = serde_json::to_string(&plugin.manifest)?;
        conn.execute(
            r#"
            INSERT INTO plugins (id, name, version, path, enabled, config, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                version = excluded.version,
                path = excluded.path,
                config = excluded.config,
                updated_at = excluded.updated_at
            "#,
            params![
                plugin.id,
                plugin.name,
                plugin.version,
                plugin.path,
                plugin.enabled,
                config_json,
                plugin.created_at,
                plugin.updated_at,
            ],
        )?;
        Ok(())
    }

    pub(super) fn replace_features(
        conn: &Connection,
        plugin_id: &str,
        features: &[Feature],
    ) -> Result<()> {
        plugin_dynamic_features_index::replace_static(conn, plugin_id, features)
    }

    /// Retrieves a plugin by its ID.
    ///
    /// # Errors
    ///
    /// Returns `AToolsError::Plugin` if the plugin is not found.
    pub fn get_plugin(&self, id: &str) -> Result<Plugin> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT id, name, version, path, enabled, config, created_at, updated_at FROM plugins WHERE id = ?1",
        )?;

        let plugin = stmt
            .query_row(params![id], |row| {
                let config_str: String = row.get(5)?;
                let manifest: PluginManifest = serde_json::from_str(&config_str).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        5,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?;
                Ok(Plugin {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    version: row.get(2)?,
                    path: row.get(3)?,
                    enabled: row.get(4)?,
                    manifest,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })
            .map_err(|_| AToolsError::Plugin(format!("Plugin not found: {}", id)))?;

        Ok(plugin)
    }

    /// Lists all installed plugins.
    pub fn list_plugins(&self) -> Result<Vec<Plugin>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT id, name, version, path, enabled, config, created_at, updated_at FROM plugins ORDER BY updated_at DESC",
        )?;

        let plugins = stmt
            .query_map([], |row| {
                let config_str: String = row.get(5)?;
                let manifest: PluginManifest = serde_json::from_str(&config_str).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        5,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?;
                Ok(Plugin {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    version: row.get(2)?,
                    path: row.get(3)?,
                    enabled: row.get(4)?,
                    manifest,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(plugins)
    }

    /// Deletes a plugin and all associated data (features, documents, attachments).
    pub fn delete_plugin(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        let rows = conn.execute("DELETE FROM plugins WHERE id = ?1", params![id])?;
        if rows == 0 {
            return Err(AToolsError::Plugin(format!("Plugin not found: {}", id)));
        }
        // Cascade deletes handle features, plugin_data, and attachments
        self.feature_catalog.lock().invalidate();
        Ok(())
    }
}
