//! One global feature-code index, shared by static and dynamic declarations.
use super::plugin_dynamic_features_contract::conflict;
use crate::{Feature, Result};
use rusqlite::{params, Connection, OptionalExtension};

pub(super) fn insert(conn: &Connection, plugin_id: &str, feature: &Feature) -> Result<()> {
    conn.prepare_cached(
        "INSERT OR REPLACE INTO features
         (code,plugin_id,label,icon,explain,cmds,main_push,priority,label_declared)
         VALUES (?1,?2,?3,?4,?5,?6,?7,0,?8)",
    )?
    .execute(params![
        feature.code,
        plugin_id,
        feature.label.as_deref().unwrap_or(&feature.code),
        feature.icon,
        feature.explain,
        serde_json::to_string(&feature.cmds)?,
        feature.main_push,
        feature
            .label
            .as_deref()
            .is_some_and(|label| !label.trim().is_empty())
    ])?;
    Ok(())
}

pub(super) fn replace_static(
    conn: &Connection,
    plugin_id: &str,
    features: &[Feature],
) -> Result<()> {
    // Reindex may retain the historical static/static last-writer behavior, but
    // must never consume a dynamically owned code, including another plugin's.
    for feature in features {
        let reserved: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM plugin_dynamic_features WHERE code=?1)",
            [&feature.code],
            |row| row.get(0),
        )?;
        if reserved {
            return Err(conflict());
        }
    }
    conn.execute(
        "DELETE FROM features WHERE plugin_id=?1 AND NOT EXISTS (
         SELECT 1 FROM plugin_dynamic_features d WHERE d.plugin_id=features.plugin_id AND d.code=features.code)",
        [plugin_id],
    )?;
    for feature in features {
        insert(conn, plugin_id, feature)?;
    }
    Ok(())
}

pub(super) fn ensure_dynamic_owner(conn: &Connection, plugin_id: &str, code: &str) -> Result<()> {
    let indexed_owner: Option<String> = conn
        .query_row(
            "SELECT plugin_id FROM features WHERE code=?1",
            [code],
            |row| row.get(0),
        )
        .optional()?;
    let dynamic_owner: Option<String> = conn
        .query_row(
            "SELECT plugin_id FROM plugin_dynamic_features WHERE code=?1",
            [code],
            |row| row.get(0),
        )
        .optional()?;
    if indexed_owner
        .as_deref()
        .is_some_and(|owner| owner != plugin_id)
        || dynamic_owner
            .as_deref()
            .is_some_and(|owner| owner != plugin_id)
        || (indexed_owner.is_some() && dynamic_owner.as_deref() != Some(plugin_id))
    {
        return Err(conflict());
    }
    Ok(())
}
