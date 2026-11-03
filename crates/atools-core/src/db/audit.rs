use super::Database;
use crate::agent::{AuditLogEntry, AuditLogPage, AuditLogQuery, AuditStatus};
use crate::error::Result;
use rusqlite::params;
use serde_json;

impl Database {
    // ---- Audit log ----

    pub fn insert_audit_entry(&self, entry: &AuditLogEntry) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT OR REPLACE INTO audit_log
            (id, timestamp, client_id, tool_name, input, output, status, duration_ms, error)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            params![
                entry.id,
                entry.timestamp,
                entry.client_id,
                entry.tool_name,
                serde_json::to_string(&entry.input)?,
                serde_json::to_string(&entry.output)?,
                audit_status_to_str(&entry.status),
                entry.duration_ms as i64,
                entry.error,
            ],
        )?;
        Ok(())
    }

    pub fn list_audit_entries(&self, limit: usize) -> Result<Vec<AuditLogEntry>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT id, timestamp, client_id, tool_name, input, output, status, duration_ms, error
            FROM audit_log
            ORDER BY timestamp DESC
            LIMIT ?1
            "#,
        )?;

        let entries = stmt
            .query_map(params![limit as i64], audit_entry_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(entries)
    }

    pub fn query_audit_entries(&self, query: &AuditLogQuery) -> Result<Vec<AuditLogEntry>> {
        Ok(self.query_audit_entries_page(query)?.entries)
    }

    pub fn query_audit_entries_page(&self, query: &AuditLogQuery) -> Result<AuditLogPage> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT id, timestamp, client_id, tool_name, input, output, status, duration_ms, error
            FROM audit_log
            ORDER BY timestamp DESC
            "#,
        )?;
        let limit = query.limit.clamp(1, 5000);
        let offset = query.offset.min(usize::MAX - limit);
        let entries = stmt
            .query_map([], audit_entry_from_row)?
            .filter_map(|entry| match entry {
                Ok(entry) if audit_entry_matches_query(&entry, query) => Some(Ok(entry)),
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            })
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let total = entries.len();
        let entries = entries.into_iter().skip(offset).take(limit).collect();
        Ok(AuditLogPage {
            entries,
            total,
            limit,
            offset,
        })
    }

    pub fn clear_audit_entries(&self) -> Result<usize> {
        let conn = self.conn.lock();
        Ok(conn.execute("DELETE FROM audit_log", [])?)
    }

    pub fn prune_audit_entries(
        &self,
        older_than: Option<&str>,
        keep_latest: Option<usize>,
    ) -> Result<usize> {
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        let mut deleted = 0;

        if let Some(cutoff) = older_than.map(str::trim).filter(|value| !value.is_empty()) {
            deleted += tx.execute(
                "DELETE FROM audit_log WHERE timestamp < ?1",
                params![cutoff],
            )?;
        }

        if let Some(limit) = keep_latest {
            deleted += tx.execute(
                r#"
                DELETE FROM audit_log
                WHERE id NOT IN (
                    SELECT id FROM audit_log
                    ORDER BY timestamp DESC, id DESC
                    LIMIT ?1
                )
                "#,
                params![limit as i64],
            )?;
        }

        tx.commit()?;
        Ok(deleted)
    }

    pub fn delete_audit_entries_for_client(&self, client_id: &str) -> Result<usize> {
        let conn = self.conn.lock();
        Ok(conn.execute(
            "DELETE FROM audit_log WHERE client_id = ?1",
            params![client_id],
        )?)
    }

    pub fn export_audit_entries_jsonl(&self, limit: usize) -> Result<String> {
        let entries = self.list_audit_entries(limit)?;
        export_audit_entries_jsonl(entries)
    }

    pub fn export_audit_entries_jsonl_filtered(&self, query: &AuditLogQuery) -> Result<String> {
        let entries = self.query_audit_entries(query)?;
        export_audit_entries_jsonl(entries)
    }
}
fn export_audit_entries_jsonl(entries: Vec<AuditLogEntry>) -> Result<String> {
    let mut output = String::new();
    for entry in entries {
        output.push_str(&serde_json::to_string(&entry)?);
        output.push('\n');
    }
    Ok(output)
}
fn audit_entry_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AuditLogEntry> {
    let input: String = row.get(4)?;
    let output: String = row.get(5)?;
    let status: String = row.get(6)?;
    let duration_ms: i64 = row.get(7)?;

    Ok(AuditLogEntry {
        id: row.get(0)?,
        timestamp: row.get(1)?,
        client_id: row.get(2)?,
        tool_name: row.get(3)?,
        input: serde_json::from_str(&input).unwrap_or(serde_json::Value::Null),
        output: serde_json::from_str(&output).unwrap_or(serde_json::Value::Null),
        status: audit_status_from_str(&status),
        duration_ms: duration_ms.max(0) as u64,
        error: row.get(8)?,
    })
}

fn audit_entry_matches_query(entry: &AuditLogEntry, query: &AuditLogQuery) -> bool {
    if let Some(status) = query
        .status
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "all")
    {
        if !audit_status_matches_filter(&entry.status, status) {
            return false;
        }
    }
    if let Some(tool_name) = query
        .tool_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "all")
    {
        if entry.tool_name != tool_name {
            return false;
        }
    }
    if let Some(client_id) = query
        .client_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "all")
    {
        if entry.client_id != client_id {
            return false;
        }
    }
    if let Some(text) = query
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let needle = text.to_lowercase();
        if !audit_entry_search_text(entry).contains(&needle) {
            return false;
        }
    }
    true
}

fn audit_status_matches_filter(status: &AuditStatus, filter: &str) -> bool {
    match filter {
        "success" => matches!(status, AuditStatus::Allowed | AuditStatus::Confirmed),
        "allowed" => matches!(status, AuditStatus::Allowed),
        "confirmed" => matches!(status, AuditStatus::Confirmed),
        "denied" => matches!(status, AuditStatus::Denied),
        "error" => matches!(status, AuditStatus::Error),
        _ => audit_status_to_str(status) == filter,
    }
}

fn audit_entry_search_text(entry: &AuditLogEntry) -> String {
    [
        entry.id.as_str(),
        entry.timestamp.as_str(),
        entry.client_id.as_str(),
        entry.tool_name.as_str(),
        audit_status_to_str(&entry.status),
        entry.error.as_deref().unwrap_or_default(),
        &serde_json::to_string(&entry.input).unwrap_or_default(),
        &serde_json::to_string(&entry.output).unwrap_or_default(),
    ]
    .join("\n")
    .to_lowercase()
}

fn audit_status_to_str(status: &AuditStatus) -> &'static str {
    match status {
        AuditStatus::Allowed => "allowed",
        AuditStatus::Confirmed => "confirmed",
        AuditStatus::Denied => "denied",
        AuditStatus::Error => "error",
    }
}

fn audit_status_from_str(status: &str) -> AuditStatus {
    match status {
        "allowed" => AuditStatus::Allowed,
        "confirmed" => AuditStatus::Confirmed,
        "denied" => AuditStatus::Denied,
        "error" => AuditStatus::Error,
        _ => AuditStatus::Error,
    }
}
