//! Typed fail-closed facade for platforms without the macOS materializer.
use atools_core::{db::Database, task_run::TaskRun};
use serde_json::Value;
use std::{
    path::Path,
    sync::{atomic::AtomicBool, Arc},
};
use tauri::AppHandle;

use super::ConversionDependencies;

const UNSUPPORTED: &str = "SOURCE_DEPENDENCY_PLATFORM_UNSUPPORTED";

pub(crate) async fn execute(
    _app: &AppHandle,
    _db: &Database,
    _tool_name: &str,
    _arguments: Value,
    _run_id: &str,
) -> Result<Value, String> {
    Err(UNSUPPORTED.into())
}

pub(crate) fn request_cancel(_app: &AppHandle, _run: &TaskRun) -> Result<TaskRun, String> {
    Err(UNSUPPORTED.into())
}

pub(crate) fn state(_run: &TaskRun) -> Result<super::super::manager::BuildState, String> {
    Err(UNSUPPORTED.into())
}

pub(in crate::plugin_source_build) async fn prepared_for_conversion(
    _app: &AppHandle,
    _source_path: &Path,
    _expected_revision: &str,
    _cancelled: Arc<AtomicBool>,
) -> Result<Option<ConversionDependencies>, String> {
    Err(UNSUPPORTED.into())
}
