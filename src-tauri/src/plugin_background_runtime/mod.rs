//! Permissioned, window-owned resident plugin sessions. This module never starts
//! Node itself; the trusted main renderer owns document loading and readiness.
mod admission;
mod candidates;
pub(crate) mod commands;
mod dto;
mod executor;
mod inventory;
mod lifecycle;
mod receipt;
pub(crate) mod registry;
mod store;
#[cfg(test)]
mod tests;

use atools_core::{agent::ToolDefinition, Database};
use serde_json::Value;
use std::sync::Arc;
use store::{Intent, Runtime};
use tauri::{AppHandle, Manager};

pub(crate) const SOURCE: &str = registry::SOURCE;

pub(crate) fn inventory_snapshot(
    app: &AppHandle,
) -> Result<(Vec<crate::plugin_runtime_inventory::RuntimeSession>, bool), String> {
    inventory::inventory_snapshot(app)
}

pub(crate) fn install_manager(app: &AppHandle) {
    app.manage(Arc::new(Runtime::default()));
}

pub(crate) fn is_installed(app: &AppHandle) -> bool {
    app.try_state::<Arc<Runtime>>().is_some()
}

fn manager(app: &AppHandle) -> Result<Arc<Runtime>, String> {
    app.try_state::<Arc<Runtime>>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| "ERR_PLUGIN_BACKGROUND_UNAVAILABLE".into())
}

pub(crate) fn validate_private_request(
    app: &AppHandle,
    db: &Database,
    client: &str,
    name: &str,
    args: &Value,
) -> Result<(), String> {
    admission::validate_private_request(app, db, client, name, args)
}

pub(crate) fn bind_run(
    app: &AppHandle,
    db: &Database,
    name: &str,
    args: &Value,
    run: &str,
) -> Result<(), String> {
    admission::bind_run(app, db, name, args, run)
}

pub(crate) async fn execute(
    app: &AppHandle,
    db: &Database,
    tool: &ToolDefinition,
    args: Value,
    client: &str,
    run_id: &str,
) -> Result<Value, String> {
    executor::execute(app, db, tool, args, client, run_id).await
}

pub(crate) fn cancel_run(app: &AppHandle, db: &Database, run_id: &str) {
    lifecycle::cancel_run(app, db, run_id);
}

pub(crate) async fn close_window(app: &AppHandle, window: &str) {
    lifecycle::close_window(app, window).await;
}

pub(crate) async fn invalidate(
    app: &AppHandle,
    db: &Database,
    plugin: Option<&str>,
) -> Result<(), String> {
    lifecycle::invalidate(app, db, plugin).await
}

pub(crate) async fn stop(app: &AppHandle) -> Result<(), String> {
    lifecycle::stop(app).await
}

pub(crate) async fn finalize_task_run(app: &AppHandle, db: &Database, run_id: &str) {
    lifecycle::finalize_task_run(app, db, run_id).await;
}

fn close_intent(app: &AppHandle, db: &Database, intent: &Arc<Intent>, cancel: bool) {
    lifecycle::close_intent(app, db, intent, cancel);
}

fn finish_intent(
    app: &AppHandle,
    intent: &Arc<Intent>,
    outcome: dto::Outcome,
    run_id: &str,
) -> Result<(), String> {
    manager(app)?.finish(intent, outcome, run_id)
}
