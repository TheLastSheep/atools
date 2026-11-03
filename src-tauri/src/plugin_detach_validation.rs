//! Bounded input mapping and claim-time plugin snapshot checks.

use std::io::{self, Write};

use atools_core::models::Plugin;
use serde::Serialize;

use crate::plugin_detach_runtime::PendingPluginAction;

pub(crate) const MAX_HANDOFF_BYTES: usize = 16 * 1024 * 1024;

struct BudgetWriter {
    bytes: usize,
}

impl Write for BudgetWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let next = self.bytes.saturating_add(buffer.len());
        if next > MAX_HANDOFF_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "plugin handoff exceeds the 16 MiB limit",
            ));
        }
        self.bytes = next;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(crate) fn check_handoff_budget<T: Serialize>(value: &T) -> Result<(), String> {
    serde_json::to_writer(&mut BudgetWriter { bytes: 0 }, value)
        .map_err(|_| "Plugin handoff exceeds the 16 MiB serialized limit".to_string())
}

pub(crate) fn normalize_files_payload(
    payload: Option<serde_json::Value>,
) -> Result<Option<serde_json::Value>, String> {
    let Some(serde_json::Value::Array(files)) = payload else {
        return Err("PLUGIN_HANDOFF_INPUT_INVALID: files handoff must contain a path array".into());
    };
    let paths = files
        .into_iter()
        .map(|file| match file {
            serde_json::Value::String(path) => Ok(serde_json::Value::String(path)),
            serde_json::Value::Object(mut file) => file
                .remove("path")
                .filter(serde_json::Value::is_string)
                .ok_or_else(|| {
                    "PLUGIN_HANDOFF_INPUT_INVALID: every file must contain a path".to_string()
                }),
            _ => Err("PLUGIN_HANDOFF_INPUT_INVALID: invalid file handoff item".into()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(serde_json::Value::Array(paths)))
}

pub(crate) fn validate_current_snapshot(
    pending: &PendingPluginAction,
    plugin: &Plugin,
    feature_owner: &str,
    code_revision: Result<Option<String>, String>,
) -> Result<(), String> {
    let current_revision = code_revision?;
    if plugin.id != pending.action.plugin_id
        || !plugin.enabled
        || plugin.path != pending.action.plugin_path
        || plugin.version != pending.plugin_version
        || feature_owner != pending.action.plugin_id
        || current_revision != pending.code_revision
    {
        return Err("FEATURE_OWNER_CHANGED: plugin changed before handoff claim".into());
    }
    Ok(())
}

pub(crate) fn validate_claim_window(label: &str) -> Result<(), String> {
    if label == crate::window::PLUGIN_DETACH_LABEL {
        Ok(())
    } else {
        Err("Plugin handoffs can only be claimed by the detached plugin window".into())
    }
}
