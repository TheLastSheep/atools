use super::super::state::Harness;
use serde_json::Value;
use tauri::{AppHandle, Wry};

pub(in crate::renderer_desktop_smoke::settings_input_journey) async fn main_plugin_inventory(
    app: &AppHandle<Wry>,
    harness: &Harness,
    target: &(String, String),
    expected_timestamp_count: Option<u64>,
    expected_event_count: Option<u64>,
    expected_list_read_count: Option<u64>,
) -> Result<Value, &'static str> {
    let name = super::js_string(&target.0);
    let path = super::js_string(&target.1);
    let timestamp_count = count_arg(expected_timestamp_count)?;
    let event_count = count_arg(expected_event_count)?;
    let list_read_count = count_arg(expected_list_read_count)?;
    super::main_call(
        app,
        harness,
        "mainPluginInventory",
        "pluginInventoryInspect",
        &[
            name.as_str(),
            path.as_str(),
            timestamp_count.as_str(),
            event_count.as_str(),
            list_read_count.as_str(),
        ],
    )
    .await
}

fn count_arg(value: Option<u64>) -> Result<String, &'static str> {
    match value {
        Some(value) if value <= 4096 => Ok(value.to_string()),
        Some(_) => Err("settings-input-probe-protocol-rejected"),
        None => Ok("-1".to_owned()),
    }
}
