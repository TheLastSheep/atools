use super::Database;
use crate::agent::{AgentToolGrant, PermissionScope, ToolDefinition};
use crate::error::Result;
use rusqlite::params;
use serde_json;

impl Database {
    // ---- Agent tool registry and grants ----

    pub fn sync_agent_tools(&self, tools: &[ToolDefinition]) -> Result<()> {
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare(
                r#"
                INSERT INTO agent_tools
                (name, description, input_schema, output_schema, scopes, enabled_by_default, enabled, source, plugin_id, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                ON CONFLICT(name) DO UPDATE SET
                    description = excluded.description,
                    input_schema = excluded.input_schema,
                    output_schema = excluded.output_schema,
                    scopes = excluded.scopes,
                    enabled_by_default = excluded.enabled_by_default,
                    source = excluded.source,
                    plugin_id = excluded.plugin_id,
                    updated_at = excluded.updated_at
                "#,
            )?;
            for tool in tools {
                stmt.execute(params![
                    tool.name,
                    tool.description,
                    serde_json::to_string(&tool.input_schema)?,
                    tool.output_schema
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()?,
                    serde_json::to_string(&tool.scopes)?,
                    tool.enabled_by_default,
                    tool.enabled,
                    tool.source,
                    tool.plugin_id,
                    crate::utils::now_iso(),
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_agent_tools(&self) -> Result<Vec<ToolDefinition>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT name, description, input_schema, output_schema, scopes, enabled_by_default, enabled, source, plugin_id
            FROM agent_tools
            ORDER BY source ASC, name ASC
            "#,
        )?;

        let tools = stmt
            .query_map([], agent_tool_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(tools)
    }

    pub fn get_agent_tool(&self, name: &str) -> Result<Option<ToolDefinition>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT name, description, input_schema, output_schema, scopes, enabled_by_default, enabled, source, plugin_id
            FROM agent_tools
            WHERE name = ?1
            "#,
        )?;

        let result = stmt.query_row(params![name], agent_tool_from_row);
        match result {
            Ok(tool) => Ok(Some(tool)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn set_agent_tool_enabled(&self, name: &str, enabled: bool) -> Result<bool> {
        let conn = self.conn.lock();
        let rows = conn.execute(
            "UPDATE agent_tools SET enabled = ?2, updated_at = ?3 WHERE name = ?1",
            params![name, enabled, crate::utils::now_iso()],
        )?;
        Ok(rows > 0)
    }

    pub fn delete_agent_tools_by_source_except(
        &self,
        source: &str,
        keep_names: &[String],
    ) -> Result<usize> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT name FROM agent_tools WHERE source = ?1")?;
        let existing = stmt
            .query_map(params![source], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let keep = keep_names.iter().collect::<std::collections::BTreeSet<_>>();
        let mut deleted = 0usize;
        for name in existing {
            if keep.contains(&name) {
                continue;
            }
            deleted += conn.execute("DELETE FROM agent_tools WHERE name = ?1", params![name])?;
        }
        Ok(deleted)
    }

    pub fn grant_agent_tool(&self, client_id: &str, tool_name: &str) -> Result<()> {
        let conn = self.conn.lock();
        let now = crate::utils::now_iso();
        conn.execute(
            r#"
            INSERT INTO agent_tool_grants (client_id, tool_name, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?3)
            ON CONFLICT(client_id, tool_name) DO UPDATE SET updated_at = excluded.updated_at
            "#,
            params![client_id, tool_name, now],
        )?;
        Ok(())
    }

    pub fn revoke_agent_tool(&self, client_id: &str, tool_name: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let rows = conn.execute(
            "DELETE FROM agent_tool_grants WHERE client_id = ?1 AND tool_name = ?2",
            params![client_id, tool_name],
        )?;
        Ok(rows > 0)
    }

    pub fn is_agent_tool_granted(&self, client_id: &str, tool_name: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT 1 FROM agent_tool_grants WHERE client_id = ?1 AND tool_name = ?2 LIMIT 1",
        )?;
        let result = stmt.query_row(params![client_id, tool_name], |_| Ok(()));
        match result {
            Ok(()) => Ok(true),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    pub fn list_agent_tool_grants(&self) -> Result<Vec<AgentToolGrant>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT client_id, tool_name, created_at, updated_at
            FROM agent_tool_grants
            ORDER BY updated_at DESC, client_id ASC, tool_name ASC
            "#,
        )?;
        let grants = stmt
            .query_map([], |row| {
                Ok(AgentToolGrant {
                    client_id: row.get(0)?,
                    tool_name: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(grants)
    }
}
fn agent_tool_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ToolDefinition> {
    let input_schema: String = row.get(2)?;
    let output_schema: Option<String> = row.get(3)?;
    let scopes: String = row.get(4)?;
    let input_schema = serde_json::from_str(&input_schema).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let output_schema = output_schema
        .map(|value| {
            serde_json::from_str(&value).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    3,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })
        })
        .transpose()?;
    let scopes: Vec<PermissionScope> = serde_json::from_str(&scopes).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(e))
    })?;

    Ok(ToolDefinition {
        name: row.get(0)?,
        description: row.get(1)?,
        input_schema,
        output_schema,
        scopes,
        enabled_by_default: row.get(5)?,
        enabled: row.get(6)?,
        source: row.get(7)?,
        plugin_id: row.get(8)?,
    })
}
