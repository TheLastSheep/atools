//! SQL-selected and bounded document reads for plugin bridges.

use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};

use super::plugin_data_contract::{
    invalid, serialized_size, validate_document, validate_id, validate_limit,
    PLUGIN_DATA_MAX_DOCUMENT_BYTES, PLUGIN_DATA_MAX_KEYS, PLUGIN_DATA_MAX_RESPONSE_BYTES,
};
use super::{Database, PluginDataQuery};
use crate::error::Result;
use crate::models::Document;

impl Database {
    pub fn plugin_data_get_bounded(&self, plugin_id: &str, id: &str) -> Result<Option<Document>> {
        validate_id(plugin_id)?;
        validate_id(id)?;
        let conn = self.conn.lock();
        read_one(&conn, plugin_id, id)
    }

    /// SQL applies ownership, selector and LIMIT before materializing JSON. A
    /// matching result beyond the requested limit is an explicit error, not a
    /// silently truncated list. At most limit+1 rows are inspected.
    pub fn plugin_data_all_bounded(
        &self,
        plugin_id: &str,
        query: &PluginDataQuery,
        limit: Option<usize>,
    ) -> Result<Vec<Document>> {
        validate_id(plugin_id)?;
        let limit = validate_limit(limit)?;
        let mut arguments = vec![rusqlite::types::Value::Text(plugin_id.into())];
        let columns = projection("");
        let sql = match query {
            PluginDataQuery::All => format!(
                "SELECT {columns} FROM plugin_data WHERE plugin_id=?1 ORDER BY _id LIMIT ?2"
            ),
            PluginDataQuery::Prefix(prefix) => {
                serialized_size(prefix, PLUGIN_DATA_MAX_DOCUMENT_BYTES)?;
                arguments.push(prefix.clone().into());
                // Range bounds use the (plugin_id,_id) index; byte-based substr
                // retains literal prefix semantics, including %, _ and NUL.
                let upper = prefix_upper_bound(prefix);
                if let Some(upper) = upper {
                    arguments.push(upper.into());
                    format!("SELECT {columns} FROM plugin_data WHERE plugin_id=?1 AND _id>=?2 AND _id<?3 AND substr(CAST(_id AS BLOB),1,length(CAST(?2 AS BLOB)))=CAST(?2 AS BLOB) ORDER BY _id LIMIT ?4")
                } else {
                    format!("SELECT {columns} FROM plugin_data WHERE plugin_id=?1 AND _id>=?2 AND substr(CAST(_id AS BLOB),1,length(CAST(?2 AS BLOB)))=CAST(?2 AS BLOB) ORDER BY _id LIMIT ?3")
                }
            }
            PluginDataQuery::Keys(keys) => {
                if keys.len() > PLUGIN_DATA_MAX_KEYS {
                    return Err(invalid("at most 128 document keys allowed"));
                }
                for key in keys {
                    validate_id(key)?;
                }
                serialized_size(keys, PLUGIN_DATA_MAX_RESPONSE_BYTES)?;
                if keys.is_empty() {
                    return Ok(Vec::new());
                }
                let values = keys
                    .iter()
                    .enumerate()
                    .map(|(index, key)| {
                        arguments.push(key.clone().into());
                        format!("(?{}, {})", index + 2, index)
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                format!("WITH requested(id,ordinal) AS (VALUES {values}) SELECT {} FROM requested r JOIN plugin_data d ON d.plugin_id=?1 AND d._id=r.id ORDER BY r.ordinal LIMIT ?{}", projection("d."), keys.len() + 2)
            }
        };
        arguments.push(((limit + 1) as i64).into());
        let conn = self.conn.lock();
        let mut statement = conn.prepare_cached(&sql)?;
        let mut rows = statement.query(params_from_iter(arguments))?;
        let mut documents = Vec::new();
        let mut bytes = 2; // JSON array brackets.
        while let Some(row) = rows.next()? {
            if documents.len() == limit {
                return Err(invalid("matching documents exceed requested limit"));
            }
            let doc = read_row(row)?;
            bytes += serialized_size(&doc, PLUGIN_DATA_MAX_DOCUMENT_BYTES)?
                + usize::from(!documents.is_empty());
            if bytes > PLUGIN_DATA_MAX_RESPONSE_BYTES {
                return Err(invalid("document response exceeds 512KiB budget"));
            }
            documents.push(doc);
        }
        Ok(documents)
    }
}

pub(super) fn read_one(conn: &Connection, plugin: &str, id: &str) -> Result<Option<Document>> {
    let mut statement = conn.prepare_cached(&format!(
        "SELECT {} FROM plugin_data WHERE plugin_id=?1 AND _id=?2",
        projection("")
    ))?;
    let mut rows = statement.query(params![plugin, id])?;
    rows.next()?.map(read_row).transpose()
}

fn read_row(row: &Row<'_>) -> Result<Document> {
    // Oversized cells were never projected by SQLite in the first place.
    let stored_bytes: usize = row.get(3)?;
    if stored_bytes > PLUGIN_DATA_MAX_DOCUMENT_BYTES {
        return Err(invalid("stored document exceeds 256KiB budget"));
    }
    let doc = Document {
        id: row.get(0)?,
        rev: Some(row.get(2)?),
        data: serde_json::from_str(&row.get::<_, String>(1)?)?,
    };
    validate_document(&doc)?;
    Ok(doc)
}

fn projection(prefix: &str) -> String {
    // octet_length on a direct column uses SQLite's stored byte count rather
    // than materializing/decoding arbitrarily large legacy TEXT values.
    let size =
        format!("octet_length({prefix}_id)+octet_length({prefix}data)+octet_length({prefix}rev)");
    let fields = ["_id", "data", "rev"].map(|field| {
        format!("CASE WHEN ({size})<={PLUGIN_DATA_MAX_DOCUMENT_BYTES} THEN {prefix}{field} END")
    });
    format!("{},({size})", fields.join(","))
}

fn prefix_upper_bound(prefix: &str) -> Option<String> {
    let mut chars = prefix.chars().collect::<Vec<_>>();
    while let Some(last) = chars.pop() {
        let next = (last as u32 + 1..=0x10ffff).find_map(char::from_u32);
        if let Some(next) = next {
            chars.push(next);
            return Some(chars.into_iter().collect());
        }
    }
    None
}

pub(super) fn current_revision(
    conn: &Connection,
    plugin: &str,
    id: &str,
) -> Result<Option<String>> {
    let row: Option<(Option<String>, usize)> = conn.query_row(
        "SELECT CASE WHEN octet_length(rev)<=262144 THEN rev END,octet_length(rev) FROM plugin_data WHERE plugin_id=?1 AND _id=?2",
        params![plugin, id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    match row {
        Some((_, bytes)) if bytes > PLUGIN_DATA_MAX_DOCUMENT_BYTES => {
            Err(invalid("stored revision exceeds byte budget"))
        }
        Some((revision, _)) => Ok(revision),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_legacy_cells_are_null_in_the_sql_projection() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE plugin_data(plugin_id TEXT,_id TEXT,data TEXT,rev TEXT)")
            .unwrap();
        let huge = "x".repeat(PLUGIN_DATA_MAX_DOCUMENT_BYTES + 1);
        for column in ["_id", "data", "rev"] {
            conn.execute("DELETE FROM plugin_data", []).unwrap();
            conn.execute(
                "INSERT INTO plugin_data VALUES('a','id','{}','revision')",
                [],
            )
            .unwrap();
            conn.execute(
                &format!("UPDATE plugin_data SET {column}=?1"),
                params![huge],
            )
            .unwrap();
            conn.query_row(
                &format!("SELECT {} FROM plugin_data", projection("")),
                [],
                |row| {
                    for index in 0..3 {
                        assert_eq!(row.get_ref(index)?, rusqlite::types::ValueRef::Null);
                    }
                    assert!(row.get::<_, usize>(3)? > PLUGIN_DATA_MAX_DOCUMENT_BYTES);
                    Ok(())
                },
            )
            .unwrap();
        }
    }
}
