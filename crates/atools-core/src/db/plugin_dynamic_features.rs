//! Persistent dynamic features feed the existing launcher/MCP feature catalog.
use super::{
    feature_catalog, plugin_dynamic_features_contract as contract,
    plugin_dynamic_features_index as index,
};
use crate::{AToolsError, Database, Result};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;

pub(super) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS plugin_dynamic_features (
         plugin_id TEXT NOT NULL, code TEXT NOT NULL UNIQUE, declaration TEXT NOT NULL,
         PRIMARY KEY(plugin_id,code),
         FOREIGN KEY(plugin_id) REFERENCES plugins(id) ON DELETE CASCADE);",
    )?;
    Ok(())
}

impl Database {
    /// Only dynamic declarations are returned, retaining their original JSON fields.
    /// Disabled or uninstalled plugins cannot read or mutate declarations.
    pub fn plugin_dynamic_features(
        &self,
        plugin_id: &str,
        codes: Option<&[String]>,
    ) -> Result<Vec<Value>> {
        contract::validate_plugin(plugin_id)?;
        if let Some(codes) = codes {
            contract::validate_codes(codes)?;
        }
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        require_enabled(&tx, plugin_id)?;
        validate_usage(&tx, plugin_id)?;
        let mut result = Vec::new();
        {
            let mut stmt = tx.prepare_cached(
                "SELECT code,declaration FROM plugin_dynamic_features WHERE plugin_id=?1 ORDER BY code",
            )?;
            let mut rows = stmt.query([plugin_id])?;
            while let Some(row) = rows.next()? {
                let code: String = row.get(0)?;
                let declaration: String = row.get(1)?;
                if codes.is_none_or(|codes| codes.contains(&code)) {
                    result
                        .push(serde_json::from_str(&declaration).map_err(|_| contract::invalid())?);
                }
            }
        }
        tx.commit()?;
        Ok(result)
    }

    pub fn plugin_dynamic_features_set(&self, plugin_id: &str, features: &[Value]) -> Result<bool> {
        self.plugin_dynamic_features_set_with_change(plugin_id, features)
            .map(|result| result.0)
    }

    /// (API success, actual change). Identical JSON and empty sets are successful no-ops.
    pub fn plugin_dynamic_features_set_with_change(
        &self,
        plugin_id: &str,
        features: &[Value],
    ) -> Result<(bool, bool)> {
        contract::validate_plugin(plugin_id)?;
        let declarations = contract::declarations(features)?;
        let mut conn = self.conn.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_enabled(&tx, plugin_id)?;
        let static_codes = manifest_codes(&tx, plugin_id)?;
        let mut changed = false;
        for declaration in declarations {
            let feature = &declaration.feature;
            if static_codes.iter().any(|code| code == &feature.code) {
                return Err(contract::conflict());
            }
            index::ensure_dynamic_owner(&tx, plugin_id, &feature.code)?;
            let previous: Option<String> = tx.query_row(
                "SELECT declaration FROM plugin_dynamic_features WHERE plugin_id=?1 AND code=?2",
                params![plugin_id, feature.code], |row| row.get(0),
            ).optional()?;
            let indexed: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM features WHERE plugin_id=?1 AND code=?2)",
                params![plugin_id, feature.code],
                |row| row.get(0),
            )?;
            if previous.as_deref() != Some(&declaration.json) || !indexed {
                tx.execute(
                    "INSERT INTO plugin_dynamic_features(plugin_id,code,declaration) VALUES(?1,?2,?3)
                     ON CONFLICT(plugin_id,code) DO UPDATE SET declaration=excluded.declaration",
                    params![plugin_id, feature.code, declaration.json],
                )?;
                index::insert(&tx, plugin_id, feature)?;
                changed = true;
            }
        }
        let bank = if changed {
            validate_usage(&tx, plugin_id)?;
            Some(feature_catalog::validate_mutation(
                &tx,
                &self.feature_catalog.lock(),
            )?)
        } else {
            None
        };
        tx.commit()?;
        if changed {
            self.feature_catalog.lock().publish_mutation(bank);
        }
        Ok((true, changed))
    }

    pub fn plugin_dynamic_features_remove(
        &self,
        plugin_id: &str,
        codes: &[String],
    ) -> Result<bool> {
        self.plugin_dynamic_features_remove_with_change(plugin_id, codes)
            .map(|result| result.0)
    }

    /// Unknown codes are no-ops; another declaration's code rejects the whole batch.
    pub fn plugin_dynamic_features_remove_with_change(
        &self,
        plugin_id: &str,
        codes: &[String],
    ) -> Result<(bool, bool)> {
        contract::validate_plugin(plugin_id)?;
        contract::validate_codes(codes)?;
        let mut conn = self.conn.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_enabled(&tx, plugin_id)?;
        let static_codes = manifest_codes(&tx, plugin_id)?;
        let mut changed = false;
        for code in codes {
            if static_codes.contains(code) {
                return Err(contract::conflict());
            }
            index::ensure_dynamic_owner(&tx, plugin_id, code)?;
            if tx.execute(
                "DELETE FROM plugin_dynamic_features WHERE plugin_id=?1 AND code=?2",
                params![plugin_id, code],
            )? > 0
            {
                tx.execute(
                    "DELETE FROM features WHERE plugin_id=?1 AND code=?2",
                    params![plugin_id, code],
                )?;
                changed = true;
            }
        }
        // Removals cannot exceed a catalog budget and must permit recovery from
        // legacy oversized catalogs, so only inserts/replacements rebuild here.
        tx.commit()?;
        if changed {
            self.feature_catalog.lock().invalidate();
        }
        Ok((changed, changed))
    }
}

#[derive(serde::Deserialize)]
struct StaticManifest {
    #[serde(default, deserialize_with = "bounded_static_codes")]
    features: Vec<StaticCode>,
}
#[derive(serde::Deserialize)]
struct StaticCode {
    code: String,
}

fn bounded_static_codes<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Vec<StaticCode>, D::Error> {
    struct Codes;
    impl<'de> serde::de::Visitor<'de> for Codes {
        type Value = Vec<StaticCode>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a bounded static feature array")
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut sequence: A,
        ) -> std::result::Result<Self::Value, A::Error> {
            let mut codes = Vec::new();
            while let Some(code) = sequence.next_element()? {
                if codes.len() >= crate::feature_catalog::MAX_FEATURE_CATALOG_FEATURES {
                    return Err(serde::de::Error::custom(
                        "Static feature declaration budget exceeded",
                    ));
                }
                codes.push(code);
            }
            Ok(codes)
        }
    }
    deserializer.deserialize_seq(Codes)
}

fn require_enabled(conn: &Connection, plugin_id: &str) -> Result<()> {
    let enabled: Option<bool> = conn
        .query_row(
            "SELECT enabled FROM plugins WHERE id=?1",
            [plugin_id],
            |row| row.get(0),
        )
        .optional()?;
    if enabled != Some(true) {
        return Err(AToolsError::Plugin(
            "Dynamic features require an enabled installed plugin".into(),
        ));
    }
    Ok(())
}

fn manifest_codes(conn: &Connection, plugin_id: &str) -> Result<Vec<String>> {
    let bytes: usize = conn.query_row(
        "SELECT octet_length(config) FROM plugins WHERE id=?1",
        [plugin_id],
        |row| row.get(0),
    )?;
    if bytes > crate::feature_catalog::MAX_FEATURE_CATALOG_METADATA_BYTES {
        return Err(contract::quota());
    }
    let json: String = conn.query_row(
        "SELECT config FROM plugins WHERE id=?1",
        [plugin_id],
        |row| row.get(0),
    )?;
    let manifest: StaticManifest = serde_json::from_str(&json).map_err(|_| contract::invalid())?;
    Ok(manifest
        .features
        .into_iter()
        .map(|feature| feature.code)
        .collect())
}

fn validate_usage(conn: &Connection, plugin_id: &str) -> Result<()> {
    let (count, bytes, largest): (usize, usize, usize) = conn.query_row(
        "SELECT count(*),coalesce(sum(octet_length(declaration)),0),coalesce(max(octet_length(declaration)),0) FROM plugin_dynamic_features WHERE plugin_id=?1",
        [plugin_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    )?;
    if count > contract::MAX_FEATURES
        || bytes > contract::MAX_TOTAL_BYTES
        || largest > contract::MAX_FEATURE_BYTES
    {
        return Err(contract::quota());
    }
    Ok(())
}
