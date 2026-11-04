use super::{feature_catalog, Database};
use crate::error::{AToolsError, Result};
use crate::models::{Feature, FeatureEntry};
use rusqlite::params;
use serde_json;

impl Database {
    // ---- Feature indexing ----

    /// Replaces a plugin's static index entries while retaining dynamic declarations.
    ///
    /// This is typically called when a plugin is installed or updated.
    pub fn index_features(&self, plugin_id: &str, features: &[Feature]) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        Self::replace_features(&tx, plugin_id, features)?;
        let enabled: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM plugins WHERE id=?1 AND enabled=1)",
            [plugin_id],
            |row| row.get(0),
        )?;
        let bank = if enabled {
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

    /// Retrieves all indexed features across all plugins, joined with plugin metadata.
    pub fn all_features(&self) -> Result<Vec<FeatureEntry>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            r#"
            SELECT f.code, f.plugin_id, p.name AS plugin_name, f.label, f.icon, f.explain, f.cmds, f.main_push, f.priority
            FROM features f
            JOIN plugins p ON f.plugin_id = p.id
            WHERE p.enabled = 1
            ORDER BY f.priority DESC, f.code ASC
            "#,
        )?;

        let features = stmt
            .query_map([], |row| {
                let cmds_str: String = row.get(6)?;
                let cmds: Vec<_> = serde_json::from_str(&cmds_str).unwrap_or_default();
                Ok(FeatureEntry {
                    code: row.get(0)?,
                    plugin_id: row.get(1)?,
                    plugin_name: row.get(2)?,
                    label: row.get(3)?,
                    icon: row.get(4)?,
                    explain: row.get(5)?,
                    cmds,
                    main_push: row.get(7)?,
                    priority: row.get(8)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(features)
    }

    /// Retrieves all indexed features for a single plugin (`O(k)` via `idx_features_plugin`).
    pub fn features_by_plugin(&self, plugin_id: &str) -> Result<Vec<FeatureEntry>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            r#"
            SELECT f.code, f.plugin_id, p.name AS plugin_name, f.label, f.icon, f.explain, f.cmds, f.main_push, f.priority
            FROM features f
            JOIN plugins p ON f.plugin_id = p.id
            WHERE f.plugin_id = ?1
            ORDER BY f.priority DESC, f.code ASC
            "#,
        )?;

        let features = stmt
            .query_map(params![plugin_id], |row| {
                let cmds_str: String = row.get(6)?;
                let cmds: Vec<_> = serde_json::from_str(&cmds_str).unwrap_or_default();
                Ok(FeatureEntry {
                    code: row.get(0)?,
                    plugin_id: row.get(1)?,
                    plugin_name: row.get(2)?,
                    label: row.get(3)?,
                    icon: row.get(4)?,
                    explain: row.get(5)?,
                    cmds,
                    main_push: row.get(7)?,
                    priority: row.get(8)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(features)
    }

    /// Deletes a single feature entry for a plugin in `O(1)` time.
    pub fn delete_feature(&self, plugin_id: &str, code: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let mut stmt =
            conn.prepare_cached("DELETE FROM features WHERE plugin_id = ?1 AND code = ?2")?;
        let rows = stmt.execute(params![plugin_id, code])?;
        if rows > 0 {
            self.feature_catalog.lock().invalidate();
        }
        Ok(rows > 0)
    }

    /// Looks up a single feature by its code.
    ///
    /// # Errors
    ///
    /// Returns `AToolsError::FeatureNotFound` if no feature matches the code.
    pub fn get_feature(&self, code: &str) -> Result<FeatureEntry> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            r#"
            SELECT f.code, f.plugin_id, p.name AS plugin_name, f.label, f.icon, f.explain, f.cmds, f.main_push, f.priority
            FROM features f
            JOIN plugins p ON f.plugin_id = p.id
            WHERE f.code = ?1
            "#,
        )?;

        let feature = stmt
            .query_row(params![code], |row| {
                let cmds_str: String = row.get(6)?;
                let cmds: Vec<_> = serde_json::from_str(&cmds_str).unwrap_or_default();
                Ok(FeatureEntry {
                    code: row.get(0)?,
                    plugin_id: row.get(1)?,
                    plugin_name: row.get(2)?,
                    label: row.get(3)?,
                    icon: row.get(4)?,
                    explain: row.get(5)?,
                    cmds,
                    main_push: row.get(7)?,
                    priority: row.get(8)?,
                })
            })
            .map_err(|_| AToolsError::FeatureNotFound(code.to_string()))?;

        Ok(feature)
    }
}
