//! Plugin-local background startup preference routed through plugin data.
use atools_core::Database;
use serde_json::{json, Value};

const MAX_STARTUP_NAMES: usize = 16;

pub(super) fn execute(
    db: &Database,
    plugin_id: &str,
    method: &str,
    args: &[Value],
) -> Result<Value, String> {
    let plugin = db
        .get_plugin(plugin_id)
        .map_err(|_| "Plugin startup preference is unavailable")?;
    let own_name = plugin.manifest.name.trim();
    match method {
        "startup.get" => get(db, plugin_id, own_name, args),
        "startup.set" => set(db, plugin_id, own_name, args),
        _ => Err("Unsupported startup preference operation".into()),
    }
}

fn get(db: &Database, plugin_id: &str, own_name: &str, args: &[Value]) -> Result<Value, String> {
    if !args.is_empty() {
        return Err("Invalid startup preference arguments".into());
    }
    let stored = db
        .plugin_storage_get(plugin_id, super::BACKGROUND_STARTUP_KEY)
        .map_err(|_| "Plugin startup preference is unavailable")?;
    if !own_name.is_empty()
        && stored
            .as_array()
            .is_some_and(|names| names.len() == 1 && names[0].as_str() == Some(own_name))
    {
        Ok(json!([own_name]))
    } else {
        Ok(json!([]))
    }
}

fn set(db: &Database, plugin_id: &str, own_name: &str, args: &[Value]) -> Result<Value, String> {
    if args.len() != 1 {
        return Err("Invalid startup preference arguments".into());
    }
    let names = args[0]
        .as_array()
        .filter(|names| names.len() <= MAX_STARTUP_NAMES)
        .ok_or("Invalid startup preference list")?;
    let requested = if names.is_empty() {
        false
    } else {
        if own_name.is_empty() || names.iter().any(|value| value.as_str() != Some(own_name)) {
            return Err("Startup preference may name only this plugin".into());
        }
        true
    };
    let value = if requested {
        json!([own_name])
    } else {
        json!([])
    };
    let result = db
        .plugin_storage_set(plugin_id, super::BACKGROUND_STARTUP_KEY, &value)
        .map_err(|_| "Plugin startup preference could not be saved")?;
    if result.ok != Some(true) {
        return Err("Plugin startup preference could not be saved".into());
    }

    crate::plugin_background_runtime::registry::sync(db)?;
    Ok(Value::Null)
}
