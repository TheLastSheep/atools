use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

use super::{
    invalid, validate_identity, RendererAppIdentity, RendererDirectSubtype, MAX_SAFE_INTEGER,
};
use crate::error::Result;

pub(super) fn record_launch(
    history: &mut Vec<Value>,
    app: &RendererAppIdentity,
    now_ms: i64,
) -> Result<()> {
    let mut matching = Vec::new();
    let mut total_count = 0u64;
    for (index, value) in history.iter().enumerate() {
        if record_matches(value, &app.path, Some(&app.name), false, Some(app.sub_type)) {
            let count = read_usage_count(value)?;
            total_count = total_count
                .checked_add(count)
                .ok_or_else(|| invalid("app usage counter overflow"))?;
            matching.push(index);
        }
    }
    let count = total_count
        .checked_add(1)
        .ok_or_else(|| invalid("app usage counter overflow"))?;
    if count > MAX_SAFE_INTEGER {
        return Err(invalid("app usage counter exceeds the safe range"));
    }
    let mut updated = matching
        .first()
        .map(|index| history[*index].clone())
        .unwrap_or_else(|| new_app_record(app));
    let object = updated
        .as_object_mut()
        .ok_or_else(|| invalid("app history record is invalid"))?;
    object.insert("path".into(), Value::String(app.path.clone()));
    object.insert("name".into(), Value::String(app.name.clone()));
    object.insert("type".into(), Value::String("direct".into()));
    object.insert(
        "subType".into(),
        Value::String(app.sub_type.as_str().to_owned()),
    );
    object.insert("lastUsed".into(), Value::Number(now_ms.into()));
    object.insert("useCount".into(), Value::Number(count.into()));

    for index in matching.into_iter().rev() {
        history.remove(index);
    }
    history.push(updated);
    history.sort_by(|left, right| {
        let left_time = left
            .get("lastUsed")
            .and_then(Value::as_i64)
            .unwrap_or(i64::MIN);
        let right_time = right
            .get("lastUsed")
            .and_then(Value::as_i64)
            .unwrap_or(i64::MIN);
        right_time.cmp(&left_time)
    });
    Ok(())
}

fn read_usage_count(value: &Value) -> Result<u64> {
    let Some(raw_count) = value.get("useCount") else {
        return Ok(0);
    };
    let count = raw_count
        .as_u64()
        .ok_or_else(|| invalid("app usage counter is invalid"))?;
    if count > MAX_SAFE_INTEGER {
        return Err(invalid("app usage counter exceeds the safe range"));
    }
    Ok(count)
}

pub(super) fn reorder_app_pins(
    pins: &mut Vec<Value>,
    apps: &[RendererAppIdentity],
) -> Result<bool> {
    let mut requested = Vec::with_capacity(apps.len());
    let mut seen = BTreeSet::new();
    for app in apps {
        validate_identity(app)?;
        if !seen.insert((app.path.as_str(), app.name.as_str(), app.sub_type)) {
            return Err(invalid("pin order contains a duplicate identity"));
        }
        requested.push((app.path.as_str(), app.name.as_str(), app.sub_type));
    }

    let app_indices: Vec<usize> = pins
        .iter()
        .enumerate()
        .filter_map(|(index, value)| is_direct_record(value).then_some(index))
        .collect();
    let mut stored = BTreeMap::new();
    for index in &app_indices {
        let identity = record_identity(&pins[*index], true)
            .ok_or_else(|| invalid("stored app pin identity is invalid"))?;
        if stored.insert(identity, *index).is_some() {
            return Err(invalid("stored app pins contain duplicate identities"));
        }
    }
    if requested.len() != stored.len()
        || requested
            .iter()
            .any(|identity| !stored.contains_key(identity))
    {
        return Err(invalid(
            "pin order must include every stored app exactly once",
        ));
    }

    let reordered: Vec<Value> = requested
        .iter()
        .map(|identity| pins[stored[identity]].clone())
        .collect();
    let changed = app_indices
        .iter()
        .zip(&reordered)
        .any(|(index, value)| pins[*index] != *value);
    if changed {
        for (index, value) in app_indices.into_iter().zip(reordered) {
            pins[index] = value;
        }
    }
    Ok(changed)
}

pub(super) fn remove_app_records(
    values: &mut Vec<Value>,
    path: &str,
    name: Option<&str>,
    prefer_persisted_name: bool,
) -> bool {
    let old_len = values.len();
    values.retain(|value| !record_matches(value, path, name, prefer_persisted_name, None));
    values.len() != old_len
}

pub(super) fn record_matches(
    value: &Value,
    path: &str,
    name: Option<&str>,
    prefer_persisted_name: bool,
    subtype: Option<RendererDirectSubtype>,
) -> bool {
    if !is_direct_record(value)
        || value.get("path").and_then(Value::as_str) != Some(path)
        || subtype.is_some_and(|expected| direct_subtype(value) != Some(expected))
    {
        return false;
    }
    match name {
        None => true,
        Some(name) => record_identity(value, prefer_persisted_name)
            .map(|(record_path, record_name, _)| record_path == path && record_name == name)
            .unwrap_or(false),
    }
}

fn record_identity(
    value: &Value,
    prefer_persisted_name: bool,
) -> Option<(&str, &str, RendererDirectSubtype)> {
    let path = value.get("path")?.as_str()?;
    let subtype = direct_subtype(value)?;
    let stored_name = if prefer_persisted_name {
        value
            .get("persistedName")
            .and_then(Value::as_str)
            .or_else(|| value.get("name").and_then(Value::as_str))
    } else {
        value.get("name").and_then(Value::as_str)
    };
    Some((path, stored_name.unwrap_or(path), subtype))
}

pub(super) fn is_direct_record(value: &Value) -> bool {
    direct_subtype(value).is_some()
}

fn direct_subtype(value: &Value) -> Option<RendererDirectSubtype> {
    let Some(object) = value.as_object() else {
        return None;
    };
    match object.get("type").and_then(Value::as_str) {
        Some("app") => Some(RendererDirectSubtype::App),
        Some("direct") => match object.get("subType").and_then(Value::as_str) {
            Some("app") => Some(RendererDirectSubtype::App),
            Some("local-shortcut") => Some(RendererDirectSubtype::LocalShortcut),
            _ => None,
        },
        _ => None,
    }
}

pub(super) fn new_app_record(app: &RendererAppIdentity) -> Value {
    let mut object = Map::new();
    object.insert("path".into(), Value::String(app.path.clone()));
    object.insert("name".into(), Value::String(app.name.clone()));
    object.insert("type".into(), Value::String("direct".into()));
    object.insert(
        "subType".into(),
        Value::String(app.sub_type.as_str().to_owned()),
    );
    Value::Object(object)
}
