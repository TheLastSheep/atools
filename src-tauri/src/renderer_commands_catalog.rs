//! One immutable, bounded projection of the original renderer command directory.
use crate::{launcher_app_catalog::LauncherApp, state::AppState};
use atools_core::db::{RendererCommandCatalogSnapshot, RENDERER_COMMAND_CATALOG_MAX_PLUGINS};
use serde_json::{Map, Value};
use tauri::AppHandle;

const MAX_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;
const MAX_COMMAND_ROWS: usize = 16_384;
const SNAPSHOT_ENVELOPE_BYTES: usize = 128;

/// Captures the app, local shortcut, installed plugin, static feature and dynamic feature
/// metadata available to the current ATools host. Aliases are deliberately not expanded.
pub(crate) fn capture(_app: &AppHandle, state: &AppState) -> Result<Vec<u8>, String> {
    let apps = state.launcher_app_catalog.snapshot()?;
    let app_values = apps
        .iter()
        .map(|app| {
            serde_json::to_value(app)
                .map_err(|_| "Renderer app catalog could not be serialized".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let source = state
        .db
        .read_renderer_command_catalog()
        .map_err(|error| error.to_string())?;
    build_snapshot(&app_values, source)
}

fn build_snapshot(
    apps: &[Value],
    source: RendererCommandCatalogSnapshot,
) -> Result<Vec<u8>, String> {
    if source.plugins.len() > RENDERER_COMMAND_CATALOG_MAX_PLUGINS {
        return Err("Renderer command catalog exceeds the plugin limit".into());
    }

    let plugin_bytes = serde_json::to_vec(&source.plugins)
        .map_err(|_| "Renderer command catalog could not be serialized".to_owned())?
        .len();
    let mut budget = OutputBudget {
        bytes: plugin_bytes
            .checked_add(SNAPSHOT_ENVELOPE_BYTES)
            .ok_or_else(|| "Renderer command catalog exceeds 8 MiB".to_owned())?,
        rows: 0,
    };
    if budget.bytes > MAX_SNAPSHOT_BYTES {
        return Err("Renderer command catalog exceeds 8 MiB".into());
    }

    let mut commands = Vec::new();
    let mut regex_commands = Vec::new();
    for app in apps {
        let mut row = app.clone();
        let object = row
            .as_object_mut()
            .ok_or_else(|| "Renderer app catalog row is invalid".to_owned())?;
        if object.get("name").and_then(Value::as_str).is_none()
            || object.get("path").and_then(Value::as_str).is_none()
        {
            return Err("Renderer app catalog row has no name or path".into());
        }
        object.insert("type".into(), Value::String("direct".into()));
        object.insert("subType".into(), Value::String("app".into()));
        push_row(&mut commands, &mut regex_commands, row, false, &mut budget)?;
    }

    if let Some(Value::Array(shortcuts)) = source.local_shortcuts.as_ref() {
        for shortcut in shortcuts {
            let Some(shortcut) = shortcut.as_object() else {
                continue;
            };
            let alias = shortcut.get("alias");
            let name = shortcut.get("name");
            let display_name = if js_truthy(alias) { alias } else { name };
            let (Some(display_name), Some(path)) = (
                display_name.and_then(Value::as_str),
                shortcut.get("path").and_then(Value::as_str),
            ) else {
                continue;
            };
            let icon = shortcut
                .get("icon")
                .filter(|icon| js_truthy(Some(icon)))
                .cloned()
                .unwrap_or_else(|| Value::String(String::new()));
            let row = serde_json::json!({
                "name": display_name,
                "path": path,
                "icon": icon,
                "type": "direct",
                "subType": "local-shortcut"
            });
            push_row(&mut commands, &mut regex_commands, row, false, &mut budget)?;
        }
    }

    let plugins = source.plugins;
    for plugin in &plugins {
        append_plugin_commands(plugin, &mut commands, &mut regex_commands, &mut budget)?;
    }
    let document = serde_json::json!({
        "commands": commands,
        "regexCommands": regex_commands,
        "plugins": plugins,
    });
    let bytes = serde_json::to_vec(&document)
        .map_err(|_| "Renderer command catalog could not be serialized".to_owned())?;
    if bytes.len() > MAX_SNAPSHOT_BYTES {
        return Err("Renderer command catalog exceeds 8 MiB".into());
    }
    Ok(bytes)
}

fn append_plugin_commands(
    plugin: &Value,
    commands: &mut Vec<Value>,
    regex_commands: &mut Vec<Value>,
    budget: &mut OutputBudget,
) -> Result<(), String> {
    let plugin_name = plugin
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "Installed plugin has no canonical name".to_owned())?;
    let plugin_path = plugin
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "Installed plugin has no path".to_owned())?;
    let plugin_title = plugin.get("title").and_then(Value::as_str);
    let plugin_logo = plugin.get("logo");
    let Some(features) = plugin.get("features").and_then(Value::as_array) else {
        return Ok(());
    };

    for feature in features {
        let Some(feature) = feature.as_object() else {
            continue;
        };
        let feature_code = feature.get("code").and_then(Value::as_str);
        let explain = feature
            .get("explain")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let icon = feature
            .get("icon")
            .filter(|icon| js_truthy(Some(icon)))
            .or_else(|| plugin_logo.filter(|logo| js_truthy(Some(logo))));
        let Some(cmds) = feature.get("cmds").and_then(Value::as_array) else {
            continue;
        };

        for cmd in cmds {
            if let Some(name) = cmd.as_str() {
                let row = plugin_command_row(
                    name,
                    plugin_path,
                    icon,
                    feature_code,
                    plugin_name,
                    plugin_title,
                    explain,
                    "text",
                    None,
                );
                push_row(commands, regex_commands, row, false, budget)?;
            } else if let Some(cmd_object) = cmd.as_object() {
                let Some(cmd_type) = cmd_object.get("type").and_then(Value::as_str) else {
                    continue;
                };
                let name = cmd_object
                    .get("label")
                    .filter(|label| js_truthy(Some(label)))
                    .and_then(Value::as_str)
                    .unwrap_or(explain);
                let mut match_command = cmd_object.clone();
                let match_value = cmd_object
                    .get("match")
                    .filter(|value| !value.is_null())
                    .or_else(|| cmd_object.get("regex").filter(|value| !value.is_null()))
                    .cloned()
                    .unwrap_or_else(|| Value::String(String::new()));
                match_command.insert("match".into(), match_value);
                let row = plugin_command_row(
                    name,
                    plugin_path,
                    icon,
                    feature_code,
                    plugin_name,
                    plugin_title,
                    explain,
                    cmd_type,
                    Some(Value::Object(match_command)),
                );
                push_row(commands, regex_commands, row, true, budget)?;
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn plugin_command_row(
    name: &str,
    path: &str,
    icon: Option<&Value>,
    feature_code: Option<&str>,
    plugin_name: &str,
    plugin_title: Option<&str>,
    explain: &str,
    cmd_type: &str,
    match_command: Option<Value>,
) -> Value {
    let mut row = Map::new();
    row.insert("name".into(), Value::String(name.into()));
    row.insert("path".into(), Value::String(path.into()));
    if let Some(icon) = icon {
        row.insert("icon".into(), icon.clone());
    }
    row.insert("type".into(), Value::String("plugin".into()));
    if let Some(feature_code) = feature_code {
        row.insert("featureCode".into(), Value::String(feature_code.into()));
    }
    row.insert("pluginName".into(), Value::String(plugin_name.into()));
    if let Some(plugin_title) = plugin_title {
        row.insert("pluginTitle".into(), Value::String(plugin_title.into()));
    }
    row.insert("pluginExplain".into(), Value::String(explain.into()));
    row.insert("cmdType".into(), Value::String(cmd_type.into()));
    if let Some(match_command) = match_command {
        row.insert("matchCmd".into(), match_command);
    }
    Value::Object(row)
}

fn push_row(
    commands: &mut Vec<Value>,
    regex_commands: &mut Vec<Value>,
    row: Value,
    regex: bool,
    budget: &mut OutputBudget,
) -> Result<(), String> {
    if budget.rows >= MAX_COMMAND_ROWS {
        return Err("Renderer command catalog exceeds 16,384 command rows".into());
    }
    let encoded_len = serde_json::to_vec(&row)
        .map_err(|_| "Renderer command catalog could not be serialized".to_owned())?
        .len();
    let next_bytes = budget
        .bytes
        .checked_add(encoded_len)
        .and_then(|bytes| bytes.checked_add(usize::from(budget.rows > 0)))
        .ok_or_else(|| "Renderer command catalog exceeds 8 MiB".to_owned())?;
    if next_bytes > MAX_SNAPSHOT_BYTES {
        return Err("Renderer command catalog exceeds 8 MiB".into());
    }
    budget.bytes = next_bytes;
    budget.rows += 1;
    if regex {
        regex_commands.push(row);
    } else {
        commands.push(row);
    }
    Ok(())
}

struct OutputBudget {
    bytes: usize,
    rows: usize,
}

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Number(value)) => value.as_f64().is_some_and(|number| number != 0.0),
        Some(_) => true,
    }
}

#[cfg(test)]
#[path = "renderer_commands_catalog_tests.rs"]
mod tests;
