//! Nullable provenance preserves old databases without rewriting their feature rows.
use rusqlite::{Connection, Result};

pub(super) fn migrate(conn: &Connection) -> Result<()> {
    // A second process opening the same database must recheck under the write lock.
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| {
        let mut columns = conn.prepare("PRAGMA table_info(features)")?;
        let names = columns
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>>>()?;
        if !names.iter().any(|name| name == "label_declared") {
            conn.execute_batch("ALTER TABLE features ADD COLUMN label_declared INTEGER")?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute_batch("COMMIT"),
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}
