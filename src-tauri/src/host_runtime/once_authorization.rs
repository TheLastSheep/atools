use super::{
    registry::Access,
    sessions::{Intent, Session},
};
use atools_core::{
    agent::PermissionDecision,
    db::Database,
    task_run::{TaskRunInitiatorType, TaskRunStatus},
    Plugin,
};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const MAX_AGE: Duration = Duration::from_secs(600);
const UI_CLIENT: &str = "atools-ui";

/// Ephemeral proof that an exact, confirmed open TaskRun authorized one session.
#[derive(Clone)]
pub(super) struct OnceAuthorization {
    run_id: String,
    intent_id: String,
    owner: String,
    plugin: String,
    path: String,
    version: String,
    access: Access,
    document_id: Option<String>,
    session_id: String,
    expires_at: Instant,
}

impl OnceAuthorization {
    pub(super) fn remaining_ms(&self) -> u64 {
        self.expires_at
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(u64::MAX as u128) as u64
    }

    pub(super) fn for_confirmed_open(
        db: &Database,
        intent_id: &str,
        intent: &Intent,
        plugin: &Plugin,
        access: Access,
        tool_name: &str,
        run_id: &str,
    ) -> Result<Self, String> {
        if intent.plugin != plugin.id
            || intent.access != access
            || intent.created.elapsed() >= MAX_AGE
            || intent.cancelled.load(std::sync::atomic::Ordering::Acquire)
            || intent.run.lock().as_deref() != Some(run_id)
        {
            return Err("Clipboard approval does not match this opening".into());
        }
        let tool = db
            .get_agent_tool(tool_name)
            .map_err(|_| "Clipboard capability unavailable")?
            .ok_or("Clipboard capability unavailable")?;
        if tool.name != tool_name
            || tool.plugin_id.as_deref() != Some(plugin.id.as_str())
            || super::registry::access_for(&tool)? != access
            || crate::agent_tools::permission_decision_for_tool(db, UI_CLIENT, tool_name)?
                != PermissionDecision::Confirm
        {
            return Err("Clipboard approval is no longer pending".into());
        }
        let run = db
            .get_task_run(run_id)
            .map_err(|_| "Clipboard approval TaskRun unavailable")?
            .ok_or("Clipboard approval TaskRun unavailable")?;
        let expected_input = json!({"operation":"open","intentId":intent_id});
        let pending = &run.output;
        let scopes = serde_json::to_value(&tool.scopes).map_err(|_| "Invalid clipboard scopes")?;
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
                .is_some_and(|s| !s.is_empty())
            && pending.get("client_id").and_then(Value::as_str) == Some(UI_CLIENT)
            && pending.get("tool").and_then(Value::as_str) == Some(tool_name)
            && pending.get("arguments") == Some(&expected_input)
            && pending.get("scopes") == Some(&scopes)
            && pending
                .get("capabilitySnapshot")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty());
        if !valid_pending {
            return Err("Clipboard approval TaskRun does not match this opening".into());
        }
        Ok(Self {
            run_id: run_id.into(),
            intent_id: intent_id.into(),
            owner: intent.owner.clone(),
            plugin: plugin.id.clone(),
            path: plugin.path.clone(),
            version: plugin.version.clone(),
            access,
            document_id: intent
                .document
                .as_ref()
                .map(|document| document.id().to_owned()),
            session_id: String::new(),
            expires_at: intent.created + MAX_AGE,
        })
    }

    pub(super) fn bind_session(&mut self, session_id: &str) {
        self.session_id = session_id.to_string();
    }

    pub(super) fn permits(&self, db: &Database, session: &Session) -> bool {
        self.permits_at(db, session, Instant::now())
    }

    #[cfg(test)]
    pub(super) fn permits_at_for_test(
        &self,
        db: &Database,
        session: &Session,
        now: Instant,
    ) -> bool {
        self.permits_at(db, session, now)
    }

    #[cfg(test)]
    pub(super) fn expires_at_for_test(&self) -> Instant {
        self.expires_at
    }

    fn permits_at(&self, db: &Database, session: &Session, now: Instant) -> bool {
        if now >= self.expires_at
            || self.session_id != session.id
            || self.owner != session.owner
            || self.plugin != session.plugin
            || self.path != session.path
            || self.version != session.version
            || self.access != session.access
            || self.document_id.as_deref()
                != session.document.as_ref().map(|document| document.id())
            || session.tool != super::registry::tool_name(&self.plugin, self.access)
        {
            return false;
        }
        let Ok(Some(run)) = db.get_task_run(&self.run_id) else {
            return false;
        };
        run.id == self.run_id
            && run.status == TaskRunStatus::Succeeded
            && run.initiator.kind == TaskRunInitiatorType::Human
            && run.initiator.client_id.as_deref() == Some(UI_CLIENT)
            && run.capability_id == session.tool
            && run.input == json!({"operation":"open","intentId":self.intent_id})
            && run.output.get("sessionId").and_then(Value::as_str) == Some(session.id.as_str())
            && run.output.get("pluginId").and_then(Value::as_str) == Some(session.plugin.as_str())
            && run.output.get("access").and_then(Value::as_str) == Some(self.access.label())
            && run.output.get("runtime").and_then(Value::as_str) == Some("host-clipboard")
    }
}
