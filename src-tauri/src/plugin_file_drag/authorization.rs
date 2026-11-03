//! Ephemeral proof that an exact confirmed open TaskRun authorized a session.
use super::{
    registry,
    types::{Intent, Session},
};
use atools_core::{
    agent::PermissionDecision,
    db::Database,
    task_run::{TaskRunInitiatorType, TaskRunStatus},
    Plugin,
};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const MAX_AGE: Duration = super::types::SESSION_TTL;
const UI_CLIENT: &str = "atools-ui";

#[derive(Clone)]
pub(super) struct OnceAuthorization {
    run_id: String,
    intent_id: String,
    owner: super::types::Owner,
    plugin: String,
    binding: super::types::Binding,
    document_id: Option<String>,
    session_id: String,
    expires_at: Instant,
}

impl OnceAuthorization {
    pub fn remaining_ms(&self) -> u64 {
        self.expires_at
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(u64::MAX as u128) as u64
    }

    pub fn for_confirmed_open(
        db: &Database,
        intent_id: &str,
        intent: &Intent,
        plugin: &Plugin,
        tool_name: &str,
        run_id: &str,
    ) -> Result<Self, String> {
        if intent.owner.plugin != plugin.id
            || intent.created.elapsed() >= MAX_AGE
            || intent.cancelled.load(std::sync::atomic::Ordering::Acquire)
            || intent
                .document
                .as_ref()
                .is_some_and(|document| !document.is_active())
            || intent.run.lock().as_deref() != Some(run_id)
        {
            return Err("File-drag approval does not match this opening".into());
        }
        intent.binding.validate(db, &plugin.id)?;
        let tool = db
            .get_agent_tool(tool_name)
            .map_err(|_| "File-drag capability unavailable")?
            .ok_or("File-drag capability unavailable")?;
        if registry::validate(&tool)? != plugin.id
            || tool.name != tool_name
            || crate::agent_tools::permission_decision_for_tool(db, UI_CLIENT, tool_name)?
                != PermissionDecision::Confirm
        {
            return Err("File-drag approval is no longer pending".into());
        }
        let run = db
            .get_task_run(run_id)
            .map_err(|_| "File-drag approval TaskRun unavailable")?
            .ok_or("File-drag approval TaskRun unavailable")?;
        let expected_input = json!({"operation":"open","intentId":intent_id});
        let pending = &run.output;
        let scopes = serde_json::to_value(&tool.scopes).map_err(|_| "Invalid file-drag scope")?;
        let valid_pending = run.id == run_id
            && run.capability_id == tool_name
            && run.status == TaskRunStatus::Running
            && run.initiator.kind == TaskRunInitiatorType::Human
            && run.initiator.client_id.as_deref() == Some(UI_CLIENT)
            && run.input == expected_input
            && pending.get("permission_required") == Some(&Value::Bool(true))
            && pending.get("retry_after_grant") == Some(&Value::Bool(true))
            && pending
                .get("request_id")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty())
            && pending.get("client_id").and_then(Value::as_str) == Some(UI_CLIENT)
            && pending.get("tool").and_then(Value::as_str) == Some(tool_name)
            && pending.get("arguments") == Some(&expected_input)
            && pending.get("scopes") == Some(&scopes)
            && pending
                .get("capabilitySnapshot")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty());
        if !valid_pending {
            return Err("File-drag approval TaskRun does not match this opening".into());
        }
        Ok(Self {
            run_id: run_id.into(),
            intent_id: intent_id.into(),
            owner: intent.owner.clone(),
            plugin: plugin.id.clone(),
            binding: intent.binding.clone(),
            document_id: intent
                .document
                .as_ref()
                .map(|document| document.id().to_owned()),
            session_id: String::new(),
            expires_at: intent.created + MAX_AGE,
        })
    }

    pub fn bind_session(&mut self, session_id: &str) {
        self.session_id = session_id.to_owned();
    }

    pub fn permits(&self, db: &Database, session: &Session) -> bool {
        if Instant::now() >= self.expires_at
            || self.session_id != session.id
            || self.owner != session.owner
            || self.plugin != session.owner.plugin
            || self.binding != session.binding
            || self.document_id.as_deref()
                != session.document.as_ref().map(|document| document.id())
            || session.tool != registry::tool_name(&self.plugin)
            || !session.valid()
        {
            return false;
        }
        let Ok(Some(run)) = db.get_task_run(&self.run_id) else {
            return false;
        };
        let expected_input = json!({"operation":"open","intentId":self.intent_id});
        let expected_output = json!({
            "sessionId": session.id,
            "pluginId": session.owner.plugin,
            "runtime": "plugin-file-drag"
        });
        run.id == self.run_id
            && run.status == TaskRunStatus::Succeeded
            && run.initiator.kind == TaskRunInitiatorType::Human
            && run.initiator.client_id.as_deref() == Some(UI_CLIENT)
            && run.capability_id == session.tool
            && run.input == expected_input
            && run.output == expected_output
    }

    #[cfg(test)]
    pub fn expires_at_for_test(&self) -> Instant {
        self.expires_at
    }
}
