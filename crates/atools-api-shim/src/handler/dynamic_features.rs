//! Dynamic registrations share the core store used by desktop search and MCP.
use anyhow::{bail, Context, Result};
use atools_core::Database;
use serde_json::{json, Value};

fn codes(value: &Value) -> Result<Vec<String>> {
    let values = value.as_array().context("Feature codes must be an array")?;
    if values.len() > 128 {
        bail!("At most 128 feature codes are supported");
    }
    values
        .iter()
        .map(|value| {
            let code = value.as_str().context("Feature code must be a string")?;
            if code.len() > 256 {
                bail!("Feature code exceeds 256 bytes");
            }
            Ok(code.to_owned())
        })
        .collect()
}

pub(super) fn execute(
    db: &Database,
    plugin: &str,
    method: &str,
    args: Vec<Value>,
) -> Result<Value> {
    if args.len() > 1 {
        bail!("Invalid dynamic feature argument count");
    }
    match method {
        "features.get" => {
            let filter = args.first().map(codes).transpose()?;
            Ok(serde_json::to_value(
                db.plugin_dynamic_features(plugin, filter.as_deref())?,
            )?)
        }
        "features.set" => {
            let value = args.first().context("Missing dynamic feature")?;
            let items = match value.as_array() {
                Some(items) if items.len() > 128 => {
                    bail!("At most 128 feature updates are supported")
                }
                Some(items) => items.as_slice(),
                None => std::slice::from_ref(value),
            };
            Ok(json!(db.plugin_dynamic_features_set(plugin, items)?))
        }
        "features.remove" => {
            let value = args.first().context("Missing dynamic feature code")?;
            let targets = if value.is_array() {
                codes(value)?
            } else {
                vec![value
                    .as_str()
                    .context("Feature code must be a string")?
                    .to_owned()]
            };
            Ok(json!(db.plugin_dynamic_features_remove(plugin, &targets)?))
        }
        _ => bail!("Unsupported dynamic feature operation"),
    }
}
