//! Atomic ownership of a pending TaskRun before an executor performs side effects.

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::Value;

use super::{task_runs::task_run_initiator_type_to_str, Database};
use crate::error::Result;
use crate::task_run::{TaskRun, TaskRunStatus};

impl Database {
    /// Save an approval grant only while the reviewed TaskRun is still the
    /// matching pending request. Cancellation and this insert serialize through
    /// one IMMEDIATE transaction on the same SQLite connection.
    pub fn grant_agent_tool_for_pending_run(
        &self,
        expected: &TaskRun,
        client_id: &str,
        tool_name: &str,
    ) -> Result<bool> {
        if expected.status != TaskRunStatus::AwaitingPermission
            || expected.capability_id != tool_name
            || expected.initiator.client_id.as_deref() != Some(client_id)
        {
            return Ok(false);
        }
        let mut connection = self.conn.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = transaction.query_row(
            "SELECT capability_id, initiator_type, client_id, status, input FROM task_runs WHERE id = ?1",
            params![expected.id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?)),
        ).optional()?;
        let Some((capability_id, initiator_type, current_client, status, input)) = current else {
            return Ok(false);
        };
        if capability_id != expected.capability_id
            || initiator_type != task_run_initiator_type_to_str(expected.initiator.kind)
            || current_client.as_deref() != Some(client_id)
            || status != TaskRunStatus::AwaitingPermission.as_str()
            || serde_json::from_str::<Value>(&input).ok().as_ref() != Some(&expected.input)
        {
            return Ok(false);
        }

        let now = crate::utils::now_iso();
        transaction.execute(
            r#"
            INSERT INTO agent_tool_grants (client_id, tool_name, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?3)
            ON CONFLICT(client_id, tool_name) DO UPDATE SET updated_at = excluded.updated_at
            "#,
            params![client_id, tool_name, now],
        )?;
        transaction.commit()?;
        Ok(true)
    }

    /// Claims an existing pending run exactly once, preserving its identity.
    ///
    /// `proposed` must already have transitioned to Running. A failed claim never
    /// inserts a run or replaces the winning executor's state. IMMEDIATE also
    /// serializes claims made through separate connections to the same database.
    pub fn claim_task_run(&self, proposed: &TaskRun) -> Result<bool> {
        if proposed.status != TaskRunStatus::Running {
            return Ok(false);
        }
        self.write_task_run_if_active(proposed, &["created", "awaiting_permission"])
    }

    /// Updates a non-executing outcome only while the same run is still pending.
    /// A stale confirmation or dismissal cannot overwrite an active executor.
    pub fn update_pending_task_run(&self, proposed: &TaskRun) -> Result<bool> {
        if !matches!(
            proposed.status,
            TaskRunStatus::AwaitingPermission | TaskRunStatus::Cancelled | TaskRunStatus::Failed
        ) {
            return Ok(false);
        }
        self.write_task_run_if_active(proposed, &["created", "awaiting_permission"])
    }

    /// First terminal outcome wins; a late executor cannot overwrite cancellation.
    pub fn finish_running_task_run(&self, proposed: &TaskRun) -> Result<bool> {
        if !proposed.status.is_terminal() {
            return Ok(false);
        }
        self.write_task_run_if_active(proposed, &["running"])
    }

    /// Dispatch rejection may fail only a never-started Created run. It cannot
    /// replace a permission prompt, executor claim, cancellation, or completion.
    pub fn fail_created_task_run(&self, proposed: &TaskRun) -> Result<bool> {
        if proposed.status != TaskRunStatus::Failed {
            return Ok(false);
        }
        self.write_task_run_if_active(proposed, &["created"])
    }

    fn write_task_run_if_active(
        &self,
        proposed: &TaskRun,
        expected_statuses: &[&str],
    ) -> Result<bool> {
        let mut connection = self.conn.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = transaction.query_row(
            "SELECT capability_id, initiator_type, client_id, status, input FROM task_runs WHERE id = ?1",
            params![proposed.id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?)),
        ).optional()?;
        let Some((capability_id, initiator_type, client_id, status, input)) = current else {
            return Ok(false);
        };
        if capability_id != proposed.capability_id
            || initiator_type != task_run_initiator_type_to_str(proposed.initiator.kind)
            || client_id != proposed.initiator.client_id
            || !expected_statuses.contains(&status.as_str())
            || serde_json::from_str::<Value>(&input).ok().as_ref() != Some(&proposed.input)
        {
            return Ok(false);
        }
        let changed = transaction.execute(
            r#"
            UPDATE task_runs SET
                capability_id = ?2, initiator_type = ?3, client_id = ?4, status = ?5,
                input = ?6, output = ?7, summary = ?8, progress = ?9, artifacts = ?10,
                warnings = ?11, errors = ?12, actions = ?13, memory_ids = ?14, metrics = ?15,
                validation = ?16, audit_id = ?17, retry_of = ?18, created_at = ?19,
                updated_at = ?20, started_at = ?21, finished_at = ?22
            WHERE id = ?1 AND status = ?23
            "#,
            params![
                proposed.id,
                proposed.capability_id,
                task_run_initiator_type_to_str(proposed.initiator.kind),
                proposed.initiator.client_id,
                proposed.status.as_str(),
                serde_json::to_string(&proposed.input)?,
                serde_json::to_string(&proposed.output)?,
                proposed.summary,
                proposed.progress.map(i64::from),
                serde_json::to_string(&proposed.artifacts)?,
                serde_json::to_string(&proposed.warnings)?,
                serde_json::to_string(&proposed.errors)?,
                serde_json::to_string(&proposed.actions)?,
                serde_json::to_string(&proposed.memory_ids)?,
                serde_json::to_string(&proposed.metrics)?,
                serde_json::to_string(&proposed.validation)?,
                proposed.audit_id,
                proposed.retry_of,
                proposed.created_at,
                proposed.updated_at,
                proposed.started_at,
                proposed.finished_at,
                status,
            ],
        )?;
        transaction.commit()?;
        Ok(changed == 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_run::TaskRunInitiator;
    use serde_json::json;

    fn pending(db: &Database) -> TaskRun {
        let mut run = TaskRun::new(
            "plugin_fixture_run",
            TaskRunInitiator::agent("client"),
            json!({"value":1}),
        );
        run.transition(TaskRunStatus::AwaitingPermission).unwrap();
        db.upsert_task_run(&run).unwrap();
        run
    }

    #[test]
    fn pending_approval_grant_is_inserted_only_for_matching_run_identity() {
        let db = Database::in_memory().unwrap();
        let run = pending(&db);
        assert!(db
            .grant_agent_tool_for_pending_run(&run, "client", "plugin_fixture_run")
            .unwrap());
        assert!(db
            .is_agent_tool_granted("client", "plugin_fixture_run")
            .unwrap());

        let mut mismatched = run;
        mismatched.input = json!({"value":2});
        assert!(!db
            .grant_agent_tool_for_pending_run(&mismatched, "client", "plugin_fixture_run")
            .unwrap());
        assert!(!db
            .grant_agent_tool_for_pending_run(&mismatched, "other-client", "plugin_fixture_run")
            .unwrap());
    }

    #[test]
    fn a_cancellation_committed_before_grant_prevents_saved_authorization() {
        let db = Database::in_memory().unwrap();
        let run = pending(&db);
        let mut cancelled = run.clone();
        cancelled.transition(TaskRunStatus::Cancelled).unwrap();
        assert!(db.update_pending_task_run(&cancelled).unwrap());

        assert!(!db
            .grant_agent_tool_for_pending_run(&run, "client", "plugin_fixture_run")
            .unwrap());
        assert!(!db
            .is_agent_tool_granted("client", "plugin_fixture_run")
            .unwrap());
    }
}
