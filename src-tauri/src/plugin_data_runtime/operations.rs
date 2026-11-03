//! Exact supported synchronous data API, backed by bounded core SQLite methods.
use atools_core::{
    db::{PluginDataQuery, PluginDataRemove, PluginDataWriteResult},
    models::Document,
    Database,
};
use base64::Engine;
use serde_json::{json, Value};

pub(super) const MAX_BYTES: usize = 512 * 1024;
pub(super) const METHODS: &[&str] = &[
    "features.get",
    "features.set",
    "features.remove",
    "db.get",
    "db.put",
    "db.remove",
    "db.allDocs",
    "db.bulkDocs",
    "dbStorage.getItem",
    "dbStorage.setItem",
    "dbStorage.removeItem",
    "webStorage.getItem",
    "webStorage.setItem",
    "webStorage.removeItem",
    "webStorage.clear",
    "webStorage.key",
    "webStorage.length",
    "webStorage.keys",
    "webStorage.entries",
    "webStorage.event",
    "db.postAttachment",
    "db.getAttachment",
    "db.getAttachmentType",
    "startup.get",
    "startup.set",
];
pub(super) fn validate(request: &Value) -> Result<&str, String> {
    let object = request.as_object().ok_or("Invalid data request")?;
    if object.len() != 2 || !object.contains_key("method") || !object.contains_key("args") {
        return Err("Invalid data request fields".into());
    }
    let method = request["method"]
        .as_str()
        .filter(|m| METHODS.contains(m))
        .ok_or("Unsupported synchronous plugin data method")?;
    if !request["args"].is_array() {
        return Err("Data arguments must be an array".into());
    }
    if serde_json::to_vec(request)
        .map_err(|_| "Invalid data request")?
        .len()
        > MAX_BYTES
    {
        return Err("Data request exceeds 512 KiB".into());
    }
    if method.starts_with("features.") {
        super::dynamic_features::validate(method, request["args"].as_array().unwrap())?;
    }
    Ok(method)
}
fn string(args: &[Value], index: usize) -> Result<&str, String> {
    args.get(index)
        .and_then(Value::as_str)
        .ok_or_else(|| "Invalid data string argument".into())
}
fn document(value: Option<&Value>) -> Result<Document, String> {
    serde_json::from_value(value.cloned().ok_or("Missing document")?)
        .map_err(|_| "Invalid data document".into())
}
fn storage_result(result: PluginDataWriteResult) -> Result<Value, String> {
    if result.ok == Some(true) {
        Ok(Value::Null)
    } else {
        serde_json::to_value(result).map_err(|_| "Invalid storage result".into())
    }
}
#[cfg(test)]
pub(super) fn execute(db: &Database, plugin: &str, request: &Value) -> Result<Value, String> {
    execute_with_context(db, plugin, request, None)
}
pub(super) fn execute_with_context(
    db: &Database,
    plugin: &str,
    request: &Value,
    context: Option<&super::web_storage::ExecutionContext>,
) -> Result<Value, String> {
    let method = validate(request)?;
    let args = request["args"].as_array().ok_or("Invalid data arguments")?;
    let count = match method {
        "startup.get" => 0..=0,
        "db.allDocs" | "features.get" => 0..=1,
        "startup.set" => 1..=1,
        "dbStorage.setItem" => 2..=2,
        "db.postAttachment" => 3..=4,
        "db.getAttachment" | "db.getAttachmentType" => 1..=2,
        "webStorage.getItem" | "webStorage.removeItem" | "webStorage.key" | "webStorage.event" => {
            3..=3
        }
        "webStorage.setItem" => 4..=4,
        "webStorage.entries" => 3..=3,
        _ => 1..=1,
    };
    let count = match method {
        "webStorage.clear" | "webStorage.length" | "webStorage.keys" => 2..=2,
        _ => count,
    };
    if !count.contains(&args.len()) {
        if method.starts_with("webStorage.") {
            return Ok(super::web_storage::invalid_state());
        }
        return Err("Invalid data argument count".into());
    }
    if method.starts_with("startup.") {
        return super::startup::execute(db, plugin, method, args);
    }
    if method.starts_with("webStorage.") {
        let result = super::web_storage::execute(db, plugin, method, args, context)?;
        if serde_json::to_vec(&json!({"ok":true,"result":result}))
            .map_err(|_| "Invalid data result")?
            .len()
            > MAX_BYTES
        {
            return Err("Data response exceeds 512 KiB".into());
        }
        return Ok(result);
    }
    let result = match method {
        "features.get" | "features.set" | "features.remove" => {
            super::dynamic_features::execute(db, plugin, method, args, context)
        }
        "db.get" => serde_json::to_value(
            db.plugin_data_get_bounded(plugin, string(args, 0)?)
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string()),
        "db.put" => serde_json::to_value(
            db.plugin_data_put_strict(plugin, &document(args.first())?)
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string()),
        "db.remove" => {
            let target = if let Some(id) = args[0].as_str() {
                PluginDataRemove::Id(id.into())
            } else {
                PluginDataRemove::Document(document(args.first())?)
            };
            serde_json::to_value(
                db.plugin_data_remove_strict(plugin, &target)
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())
        }
        "db.allDocs" => {
            let query = match args.first() {
                None | Some(Value::Null) => PluginDataQuery::All,
                Some(Value::String(prefix)) => PluginDataQuery::Prefix(prefix.clone()),
                Some(Value::Array(keys)) => PluginDataQuery::Keys(
                    keys.iter()
                        .map(|k| k.as_str().map(str::to_owned).ok_or("Invalid data key"))
                        .collect::<Result<Vec<_>, _>>()?,
                ),
                _ => return Err("Invalid allDocs query".into()),
            };
            serde_json::to_value(
                db.plugin_data_all_bounded(plugin, &query, None)
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())
        }
        "db.bulkDocs" => {
            let docs: Vec<Document> =
                serde_json::from_value(args[0].clone()).map_err(|_| "Invalid documents array")?;
            serde_json::to_value(
                db.plugin_data_bulk_strict(plugin, &docs)
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())
        }
        "dbStorage.getItem" => db
            .plugin_storage_get(plugin, string(args, 0)?)
            .map_err(|e| e.to_string()),
        "dbStorage.setItem" => storage_result(
            db.plugin_storage_set(plugin, string(args, 0)?, &args[1])
                .map_err(|e| e.to_string())?,
        ),
        "dbStorage.removeItem" => storage_result(
            db.plugin_storage_remove(plugin, string(args, 0)?)
                .map_err(|e| e.to_string())?,
        ),
        "db.postAttachment" => {
            let encoded = string(args, 1)?;
            if encoded.len() > ((256 * 1024 + 2) / 3) * 4 {
                return Err("Attachment exceeds byte budget".into());
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| "Invalid attachment base64")?;
            let name = if args.len() == 4 {
                string(args, 3)?
            } else {
                "default"
            };
            serde_json::to_value(
                db.plugin_data_post_attachment_bounded(
                    plugin,
                    string(args, 0)?,
                    name,
                    &bytes,
                    string(args, 2)?,
                )
                .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())
        }
        "db.getAttachment" => {
            let name = if args.len() == 2 {
                string(args, 1)?
            } else {
                "default"
            };
            db.plugin_data_get_attachment_bounded(plugin,string(args,0)?,name).map(|value|value.map(|(bytes,_)|
                json!({"base64":base64::engine::general_purpose::STANDARD.encode(bytes)})).unwrap_or(Value::Null)).map_err(|e|e.to_string())
        }
        "db.getAttachmentType" => {
            let name = if args.len() == 2 {
                string(args, 1)?
            } else {
                "default"
            };
            serde_json::to_value(
                db.plugin_data_get_attachment_type_bounded(plugin, string(args, 0)?, name)
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())
        }
        _ => Err("Unsupported data operation".into()),
    }?;
    if serde_json::to_vec(&json!({"ok":true,"result":result}))
        .map_err(|_| "Invalid data result")?
        .len()
        > MAX_BYTES
    {
        return Err("Data response exceeds 512 KiB".into());
    }
    Ok(result)
}

pub(super) fn logical_failure(method: &str, result: &Value) -> bool {
    match method {
        "features.set" | "features.remove" => result == &Value::Bool(false),
        "db.put"
        | "db.remove"
        | "db.postAttachment"
        | "dbStorage.setItem"
        | "dbStorage.removeItem"
        | "webStorage.getItem"
        | "webStorage.setItem"
        | "webStorage.removeItem"
        | "webStorage.clear"
        | "webStorage.key"
        | "webStorage.length"
        | "webStorage.keys"
        | "webStorage.entries"
        | "webStorage.event" => result.get("error") == Some(&Value::Bool(true)),
        "db.bulkDocs" => result.as_array().is_some_and(|items| {
            items
                .iter()
                .any(|item| item.get("error") == Some(&Value::Bool(true)))
        }),
        _ => false,
    }
}
