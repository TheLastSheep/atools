use super::Database;
use crate::error::Result;
use crate::task_run::{Artifact, ResultAction, TaskIssue, TaskRun, TaskRunInitiator, TaskRunInitiatorType, TaskRunStatus, TaskValidation};
use rusqlite::params;
use serde_json::{self, Value};

impl Database {
    // ---- Task runs ----

    pub fn upsert_task_run(&self, run: &TaskRun) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT OR REPLACE INTO task_runs
            (id, capability_id, initiator_type, client_id, status, input, output, summary,
             progress, artifacts, warnings, errors, actions, memory_ids, metrics, validation,
             audit_id, retry_of, created_at, updated_at, started_at, finished_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                    ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
            "#,
            params![
                run.id,
                run.capability_id,
                task_run_initiator_type_to_str(run.initiator.kind),
                run.initiator.client_id,
                run.status.as_str(),
                serde_json::to_string(&run.input)?,
                serde_json::to_string(&run.output)?,
                run.summary,
                run.progress.map(i64::from),
                serde_json::to_string(&run.artifacts)?,
                serde_json::to_string(&run.warnings)?,
                serde_json::to_string(&run.errors)?,
                serde_json::to_string(&run.actions)?,
                serde_json::to_string(&run.memory_ids)?,
                serde_json::to_string(&run.metrics)?,
                serde_json::to_string(&run.validation)?,
                run.audit_id,
                run.retry_of,
                run.created_at,
                run.updated_at,
                run.started_at,
                run.finished_at,
            ],
        )?;
        Ok(())
    }

    pub fn get_task_run(&self, id: &str) -> Result<Option<TaskRun>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT id, capability_id, initiator_type, client_id, status, input, output, summary,
                   progress, artifacts, warnings, errors, actions, memory_ids, metrics, validation,
                   audit_id, retry_of, created_at, updated_at, started_at, finished_at
            FROM task_runs
            WHERE id = ?1
            "#,
        )?;
        let mut rows = stmt.query(params![id])?;
        rows.next()?
            .map(task_run_from_row)
            .transpose()
            .map_err(Into::into)
    }

    pub fn list_task_runs(&self, limit: usize) -> Result<Vec<TaskRun>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT id, capability_id, initiator_type, client_id, status, input, output, summary,
                   progress, artifacts, warnings, errors, actions, memory_ids, metrics, validation,
                   audit_id, retry_of, created_at, updated_at, started_at, finished_at
            FROM task_runs
            ORDER BY created_at DESC, id DESC
            LIMIT ?1
            "#,
        )?;
        let runs = stmt
            .query_map(params![limit.clamp(1, 5000) as i64], task_run_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(runs)
    }

}
fn task_run_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskRun> {
    let initiator_type: String = row.get(2)?;
    let status: String = row.get(4)?;
    let input: String = row.get(5)?;
    let output: String = row.get(6)?;
    let progress: Option<i64> = row.get(8)?;
    let artifacts: String = row.get(9)?;
    let warnings: String = row.get(10)?;
    let errors: String = row.get(11)?;
    let actions: String = row.get(12)?;
    let memory_ids: String = row.get(13)?;
    let metrics: String = row.get(14)?;
    let validation: String = row.get(15)?;

    Ok(TaskRun {
        id: row.get(0)?,
        capability_id: row.get(1)?,
        initiator: TaskRunInitiator {
            kind: task_run_initiator_type_from_str(&initiator_type),
            client_id: row.get(3)?,
        },
        status: TaskRunStatus::from_storage(&status),
        input: serde_json::from_str(&input).unwrap_or(Value::Null),
        output: serde_json::from_str(&output).unwrap_or(Value::Null),
        summary: row.get(7)?,
        progress: progress.map(|value| value.clamp(0, 100) as u8),
        artifacts: serde_json::from_str::<Vec<Artifact>>(&artifacts).unwrap_or_default(),
        warnings: serde_json::from_str::<Vec<TaskIssue>>(&warnings).unwrap_or_default(),
        errors: serde_json::from_str::<Vec<TaskIssue>>(&errors).unwrap_or_default(),
        actions: serde_json::from_str::<Vec<ResultAction>>(&actions).unwrap_or_default(),
        memory_ids: serde_json::from_str::<Vec<String>>(&memory_ids).unwrap_or_default(),
        metrics: serde_json::from_str(&metrics).unwrap_or(Value::Null),
        validation: serde_json::from_str::<TaskValidation>(&validation).unwrap_or_default(),
        audit_id: row.get(16)?,
        retry_of: row.get(17)?,
        created_at: row.get(18)?,
        updated_at: row.get(19)?,
        started_at: row.get(20)?,
        finished_at: row.get(21)?,
    })
}

pub(super) fn task_run_initiator_type_to_str(value: TaskRunInitiatorType) -> &'static str {
    match value {
        TaskRunInitiatorType::Human => "human",
        TaskRunInitiatorType::Agent => "agent",
        TaskRunInitiatorType::Automation => "automation",
    }
}

fn task_run_initiator_type_from_str(value: &str) -> TaskRunInitiatorType {
    match value {
        "human" => TaskRunInitiatorType::Human,
        "automation" => TaskRunInitiatorType::Automation,
        _ => TaskRunInitiatorType::Agent,
    }
}

