use super::Database;
use crate::error::{AToolsError, Result};
use crate::memory::{validate_memory_content, MemoryApproval, MemoryItem, MemoryScope, MemoryType};
use rusqlite::{params, Connection};
use serde_json::{self, Value};

impl Database {
    // ---- Execution memory ----

    pub fn upsert_memory_item(&self, item: &MemoryItem) -> Result<()> {
        validate_memory_content(&item.content)?;
        if !(0.0..=1.0).contains(&item.confidence) {
            return Err(AToolsError::Config(
                "Memory confidence must be between 0 and 1".to_string(),
            ));
        }
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT OR REPLACE INTO memory_items
            (id, type, scope, scope_workspace, scope_skill, scope_tool, scope_application,
             scope_domain, content, source_run_id, confidence, approval, enabled, use_count,
             success_count, last_used_at, expires_at, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                    ?15, ?16, ?17, ?18, ?19)
            "#,
            params![
                item.id,
                memory_type_to_str(item.kind),
                serde_json::to_string(&item.scope)?,
                item.scope.workspace,
                item.scope.skill,
                item.scope.tool,
                item.scope.application,
                item.scope.domain,
                serde_json::to_string(&item.content)?,
                item.source_run_id,
                item.confidence,
                memory_approval_to_str(item.approval),
                item.enabled,
                item.use_count as i64,
                item.success_count as i64,
                item.last_used_at,
                item.expires_at,
                item.created_at,
                item.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn get_memory_item(&self, id: &str) -> Result<Option<MemoryItem>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT id, type, scope, content, source_run_id, confidence, approval, enabled,
                   use_count, success_count, last_used_at, expires_at, created_at, updated_at
            FROM memory_items WHERE id = ?1
            "#,
        )?;
        let mut rows = stmt.query(params![id])?;
        rows.next()?
            .map(memory_item_from_row)
            .transpose()
            .map_err(Into::into)
    }

    pub fn list_memory_items(
        &self,
        include_disabled: bool,
        limit: usize,
    ) -> Result<Vec<MemoryItem>> {
        let conn = self.conn.lock();
        let sql = if include_disabled {
            r#"
            SELECT id, type, scope, content, source_run_id, confidence, approval, enabled,
                   use_count, success_count, last_used_at, expires_at, created_at, updated_at
            FROM memory_items ORDER BY updated_at DESC, id DESC LIMIT ?1
            "#
        } else {
            r#"
            SELECT id, type, scope, content, source_run_id, confidence, approval, enabled,
                   use_count, success_count, last_used_at, expires_at, created_at, updated_at
            FROM memory_items WHERE enabled = 1 ORDER BY updated_at DESC, id DESC LIMIT ?1
            "#
        };
        let mut stmt = conn.prepare(sql)?;
        let items = stmt
            .query_map(params![limit.clamp(1, 5000) as i64], memory_item_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(items)
    }

    pub fn find_memory_items(
        &self,
        context: &MemoryScope,
        limit: usize,
    ) -> Result<Vec<MemoryItem>> {
        let now = crate::utils::now_iso();
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT id, type, scope, content, source_run_id, confidence, approval, enabled,
                   use_count, success_count, last_used_at, expires_at, created_at, updated_at
            FROM memory_items
            WHERE enabled = 1
              AND (expires_at IS NULL OR expires_at > ?6)
              AND (scope_workspace IS NULL OR (?1 IS NOT NULL AND scope_workspace = ?1))
              AND (scope_skill IS NULL OR (?2 IS NOT NULL AND scope_skill = ?2))
              AND (scope_tool IS NULL OR (?3 IS NOT NULL AND scope_tool = ?3))
              AND (scope_application IS NULL OR (?4 IS NOT NULL AND scope_application = ?4))
              AND (scope_domain IS NULL OR (?5 IS NOT NULL AND scope_domain = ?5))
            ORDER BY
              ((scope_workspace IS NOT NULL) + (scope_skill IS NOT NULL) +
               (scope_tool IS NOT NULL) + (scope_application IS NOT NULL) +
               (scope_domain IS NOT NULL)) DESC,
              confidence DESC,
              updated_at DESC,
              id ASC
            LIMIT ?7
            "#,
        )?;
        let items = stmt
            .query_map(
                params![
                    context.workspace.as_deref(),
                    context.skill.as_deref(),
                    context.tool.as_deref(),
                    context.application.as_deref(),
                    context.domain.as_deref(),
                    now,
                    limit.clamp(1, 100) as i64,
                ],
                memory_item_from_row,
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(items)
    }

    pub fn set_memory_item_enabled(&self, id: &str, enabled: bool) -> Result<bool> {
        let conn = self.conn.lock();
        Ok(conn.execute(
            "UPDATE memory_items SET enabled = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, enabled, crate::utils::now_iso()],
        )? > 0)
    }

    pub fn record_memory_use(&self, ids: &[String]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let now = crate::utils::now_iso();
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        for id in ids {
            tx.execute(
                r#"
                UPDATE memory_items
                SET use_count = use_count + 1,
                    last_used_at = ?2,
                    updated_at = ?2
                WHERE id = ?1
                "#,
                params![id, now],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn record_memory_success(&self, ids: &[String]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        for id in ids {
            tx.execute(
                "UPDATE memory_items SET success_count = success_count + 1 WHERE id = ?1",
                params![id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn delete_memory_item(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock();
        Ok(conn.execute("DELETE FROM memory_items WHERE id = ?1", params![id])? > 0)
    }

    pub fn clear_memory_items(&self) -> Result<usize> {
        let conn = self.conn.lock();
        Ok(conn.execute("DELETE FROM memory_items", [])?)
    }

    pub fn export_memory_items_json(&self) -> Result<String> {
        Ok(serde_json::to_string_pretty(
            &self.list_memory_items(true, 5000)?,
        )?)
    }

}
pub(super) fn ensure_memory_scope_columns(conn: &Connection) -> Result<()> {
    let existing = {
        let mut stmt = conn.prepare("PRAGMA table_info(memory_items)")?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<std::result::Result<std::collections::BTreeSet<_>, _>>()?;
        columns
    };
    for column in [
        "scope_workspace",
        "scope_skill",
        "scope_tool",
        "scope_application",
        "scope_domain",
    ] {
        if !existing.contains(column) {
            conn.execute(
                &format!("ALTER TABLE memory_items ADD COLUMN {column} TEXT"),
                [],
            )?;
        }
    }

    // Backfill databases created before structured scope columns were introduced.
    conn.execute_batch(
        r#"
        UPDATE memory_items SET
            scope_workspace = json_extract(scope, '$.workspace'),
            scope_skill = json_extract(scope, '$.skill'),
            scope_tool = json_extract(scope, '$.tool'),
            scope_application = json_extract(scope, '$.application'),
            scope_domain = json_extract(scope, '$.domain')
        WHERE scope_workspace IS NULL
          AND scope_skill IS NULL
          AND scope_tool IS NULL
          AND scope_application IS NULL
          AND scope_domain IS NULL
          AND scope <> '{}';
        "#,
    )?;
    Ok(())
}

fn memory_item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryItem> {
    let kind: String = row.get(1)?;
    let scope: String = row.get(2)?;
    let content: String = row.get(3)?;
    let approval: String = row.get(6)?;
    let use_count: i64 = row.get(8)?;
    let success_count: i64 = row.get(9)?;
    Ok(MemoryItem {
        id: row.get(0)?,
        kind: memory_type_from_str(&kind),
        scope: serde_json::from_str(&scope).unwrap_or_default(),
        content: serde_json::from_str(&content).unwrap_or(Value::Null),
        source_run_id: row.get(4)?,
        confidence: row.get::<_, f64>(5)?.clamp(0.0, 1.0),
        approval: memory_approval_from_str(&approval),
        enabled: row.get(7)?,
        use_count: use_count.max(0) as u64,
        success_count: success_count.max(0) as u64,
        last_used_at: row.get(10)?,
        expires_at: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

fn memory_type_to_str(value: MemoryType) -> &'static str {
    match value {
        MemoryType::Preference => "preference",
        MemoryType::WorkspaceFact => "workspace_fact",
        MemoryType::TaskRecipe => "task_recipe",
        MemoryType::Correction => "correction",
        MemoryType::FailureRecovery => "failure_recovery",
    }
}

fn memory_type_from_str(value: &str) -> MemoryType {
    match value {
        "workspace_fact" => MemoryType::WorkspaceFact,
        "task_recipe" => MemoryType::TaskRecipe,
        "correction" => MemoryType::Correction,
        "failure_recovery" => MemoryType::FailureRecovery,
        _ => MemoryType::Preference,
    }
}

fn memory_approval_to_str(value: MemoryApproval) -> &'static str {
    match value {
        MemoryApproval::Explicit => "explicit",
        MemoryApproval::ConfirmedCandidate => "confirmed_candidate",
        MemoryApproval::Temporary => "temporary",
    }
}

fn memory_approval_from_str(value: &str) -> MemoryApproval {
    match value {
        "confirmed_candidate" => MemoryApproval::ConfirmedCandidate,
        "temporary" => MemoryApproval::Temporary,
        _ => MemoryApproval::Explicit,
    }
}

