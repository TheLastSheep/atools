//! Temporary consent is limited to one successfully prepared, current runner.
use super::dto::{Identity, Operation, Request};
use atools_core::{task_run::TaskRunStatus, Database};
use std::time::{Duration, Instant};
pub(super) const TTL: Duration = Duration::from_secs(300);
#[derive(Clone)]
pub(super) struct Admission {
    pub window: String,
    pub runner: String,
    pub identity: Identity,
    pub request: String,
    pub run: String,
    pub used: Instant,
}
impl Admission {
    pub fn validate(&self, db: &Database) -> Result<(), String> {
        if self.used.elapsed() >= TTL {
            return Err("ERR_MAIN_PUSH_PREPARE_EXPIRED".into());
        }
        let run = db
            .get_task_run(&self.run)
            .map_err(|_| "ERR_MAIN_PUSH_PREPARE_REQUIRED")?
            .ok_or("ERR_MAIN_PUSH_PREPARE_REQUIRED")?;
        let request: Request =
            super::parse(&run.input).map_err(|_| "ERR_MAIN_PUSH_PREPARE_REQUIRED")?;
        if run.status != TaskRunStatus::Succeeded
            || run.output["outcome"] != "ready"
            || run.output["runtime"] != "plugin-main-push"
            || run.capability_id != super::registry::tool_name(&self.identity.plugin_id)
            || run.initiator.client_id.as_deref() != Some("atools-ui")
            || request.operation != Operation::Prepare
            || request.request_id != self.request
            || request.runner_id != self.runner
            || request.identity != self.identity
        {
            return Err("ERR_MAIN_PUSH_PREPARE_REQUIRED".into());
        }
        Ok(())
    }
}

pub(super) fn confirmation(
    runtime: &super::store::Runtime,
    db: &Database,
    window: &str,
    request: &Request,
) -> Result<bool, String> {
    if request.operation == Operation::Prepare {
        return Ok(false);
    }
    let admission = runtime.admission(window, &request.runner_id, &request.identity)?;
    admission.validate(db)?;
    runtime.touch(&admission)?;
    Ok(true)
}
