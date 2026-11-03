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
const MAX_AGE: Duration = Duration::from_secs(600);
const UI_CLIENT: &str = "atools-ui";
#[derive(Clone)]
pub(super) struct OnceAuthorization {
    run: String,
    intent: String,
    owner: super::types::Owner,
    plugin: String,
    path: String,
    version: String,
    document: Option<String>,
    session: String,
    expires: Instant,
}
impl OnceAuthorization {
    pub(super) fn confirmed_open(
        db: &Database,
        id: &str,
        intent: &Intent,
        plugin: &Plugin,
        tool: &str,
        run_id: &str,
    ) -> Result<Self, String> {
        if intent.owner.plugin != plugin.id
            || intent.created.elapsed() >= MAX_AGE
            || intent.cancelled.load(std::sync::atomic::Ordering::Acquire)
            || intent.run.lock().as_deref() != Some(run_id)
        {
            return Err("Secret storage approval does not match this opening".into());
        }
        let cap = db
            .get_agent_tool(tool)
            .map_err(|_| "Secret storage capability unavailable")?
            .ok_or("Secret storage capability unavailable")?;
        let scopes =
            serde_json::to_value(&cap.scopes).map_err(|_| "Invalid secret storage scopes")?;
        if registry::validate(&cap)? != plugin.id
            || crate::agent_tools::permission_decision_for_tool(db, UI_CLIENT, tool)?
                != PermissionDecision::Confirm
        {
            return Err("Secret storage approval is no longer pending".into());
        }
        let run = db
            .get_task_run(run_id)
            .map_err(|_| "Approval TaskRun unavailable")?
            .ok_or("Approval TaskRun unavailable")?;
        let input = json!({"operation":"open","intentId":id});
        let pending = &run.output;
        if run.id != run_id
            || run.capability_id != tool
            || run.status != TaskRunStatus::Running
            || run.initiator.kind != TaskRunInitiatorType::Human
            || run.initiator.client_id.as_deref() != Some(UI_CLIENT)
            || run.input != input
            || pending.get("permission_required") != Some(&Value::Bool(true))
            || pending.get("retry_after_grant") != Some(&Value::Bool(true))
            || pending
                .get("request_id")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            || pending.get("client_id").and_then(Value::as_str) != Some(UI_CLIENT)
            || pending.get("tool").and_then(Value::as_str) != Some(tool)
            || pending.get("arguments") != Some(&input)
            || pending.get("scopes") != Some(&scopes)
            || pending
                .get("capabilitySnapshot")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
        {
            return Err("Approval TaskRun does not match this opening".into());
        }
        Ok(Self {
            run: run_id.into(),
            intent: id.into(),
            owner: intent.owner.clone(),
            plugin: plugin.id.clone(),
            path: plugin.path.clone(),
            version: plugin.version.clone(),
            document: intent.document.as_ref().map(|d| d.id().to_owned()),
            session: String::new(),
            expires: intent.created + MAX_AGE,
        })
    }
    pub(super) fn bind_session(&mut self, id: &str) {
        self.session = id.into();
    }
    pub(super) fn remaining(&self) -> Duration {
        self.expires.saturating_duration_since(Instant::now())
    }
    pub(super) fn permits(&self, db: &Database, session: &Session) -> bool {
        if Instant::now() >= self.expires
            || self.session != session.id
            || self.owner != session.owner
            || self.plugin != session.owner.plugin
            || self.path != session.binding.path
            || self.version != session.binding.version
            || self.document.as_deref() != session.document.as_ref().map(|d| d.id())
        {
            return false;
        }
        let Ok(Some(run)) = db.get_task_run(&self.run) else {
            return false;
        };
        run.status == TaskRunStatus::Succeeded
            && run.initiator.kind == TaskRunInitiatorType::Human
            && run.initiator.client_id.as_deref() == Some(UI_CLIENT)
            && run.capability_id == session.tool
            && run.input == json!({"operation":"open","intentId":self.intent})
            && run.output.get("sessionId").and_then(Value::as_str) == Some(session.id.as_str())
            && run.output.get("pluginId").and_then(Value::as_str)
                == Some(session.owner.plugin.as_str())
            && run.output.get("runtime").and_then(Value::as_str) == Some("plugin-secret-storage")
    }
}
