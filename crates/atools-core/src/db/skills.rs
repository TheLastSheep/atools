use super::Database;
use crate::error::Result;
use crate::skill::SkillDefinition;
use rusqlite::params;
use serde_json;

impl Database {
    // ---- Skills ----

    pub fn upsert_skill(&self, skill: &SkillDefinition) -> Result<()> {
        skill.validate()?;
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT INTO skills (id, name, description, definition, enabled, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                description = excluded.description,
                definition = excluded.definition,
                enabled = excluded.enabled,
                updated_at = excluded.updated_at
            "#,
            params![
                skill.id,
                skill.name,
                skill.description,
                serde_json::to_string(skill)?,
                skill.enabled,
                skill.created_at,
                skill.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn get_skill(&self, id: &str) -> Result<Option<SkillDefinition>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT definition, enabled, created_at, updated_at FROM skills WHERE id = ?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        rows.next()?
            .map(skill_from_row)
            .transpose()
            .map_err(Into::into)
    }

    pub fn list_skills(
        &self,
        include_disabled: bool,
        limit: usize,
    ) -> Result<Vec<SkillDefinition>> {
        let conn = self.conn.lock();
        let sql = if include_disabled {
            "SELECT definition, enabled, created_at, updated_at FROM skills ORDER BY updated_at DESC, id ASC LIMIT ?1"
        } else {
            "SELECT definition, enabled, created_at, updated_at FROM skills WHERE enabled = 1 ORDER BY updated_at DESC, id ASC LIMIT ?1"
        };
        let mut stmt = conn.prepare(sql)?;
        let skills = stmt
            .query_map(params![limit.clamp(1, 5000) as i64], skill_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(skills)
    }

    pub fn set_skill_enabled(&self, id: &str, enabled: bool) -> Result<bool> {
        let Some(mut skill) = self.get_skill(id)? else {
            return Ok(false);
        };
        skill.enabled = enabled;
        skill.updated_at = crate::utils::now_iso();
        self.upsert_skill(&skill)?;
        Ok(true)
    }

    pub fn delete_skill(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock();
        Ok(conn.execute("DELETE FROM skills WHERE id = ?1", params![id])? > 0)
    }

    pub fn export_skills_json(&self) -> Result<String> {
        Ok(serde_json::to_string_pretty(
            &self.list_skills(true, 5000)?,
        )?)
    }

    pub fn storage_size_bytes(&self) -> Result<u64> {
        let conn = self.conn.lock();
        let page_count = conn.query_row("PRAGMA page_count", [], |row| row.get::<_, i64>(0))?;
        let page_size = conn.query_row("PRAGMA page_size", [], |row| row.get::<_, i64>(0))?;
        Ok(page_count.max(0) as u64 * page_size.max(0) as u64)
    }

}
fn skill_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SkillDefinition> {
    let definition: String = row.get(0)?;
    let mut skill = serde_json::from_str::<SkillDefinition>(&definition).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })?;
    skill.enabled = row.get(1)?;
    skill.created_at = row.get(2)?;
    skill.updated_at = row.get(3)?;
    Ok(skill)
}

