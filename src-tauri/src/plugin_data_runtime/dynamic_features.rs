//! Dynamic command metadata uses the approved data ticket, never TaskRun bodies.
use super::{types::Session, web_storage::ExecutionContext, Sessions};
use atools_core::Database;
use serde_json::Value;
use std::sync::atomic::Ordering;

const MAX_BATCH: usize = 128;

enum Request<'a> {
    Get(Option<Vec<String>>),
    Set(&'a [Value]),
    Remove(Vec<String>),
}

fn strings(value: &Value) -> Result<Vec<String>, String> {
    let values = value
        .as_array()
        .ok_or("Dynamic feature codes must be an array")?;
    if values.len() > MAX_BATCH {
        return Err("Dynamic feature batch exceeds 128 entries".into());
    }
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| "Invalid dynamic feature code".into())
        })
        .collect()
}

fn parse<'a>(method: &str, args: &'a [Value]) -> Result<Request<'a>, String> {
    match (method, args) {
        ("features.get", []) => Ok(Request::Get(None)),
        ("features.get", [codes]) => Ok(Request::Get(Some(strings(codes)?))),
        ("features.set", [feature]) if feature.is_object() => {
            Ok(Request::Set(std::slice::from_ref(feature)))
        }
        ("features.set", [Value::Array(features)]) => {
            if features.len() > MAX_BATCH || features.iter().any(|feature| !feature.is_object()) {
                return Err("Invalid dynamic feature object batch".into());
            }
            Ok(Request::Set(features))
        }
        ("features.remove", [Value::String(code)]) => Ok(Request::Remove(vec![code.clone()])),
        ("features.remove", [codes]) => Ok(Request::Remove(strings(codes)?)),
        _ => Err("Invalid dynamic feature arguments".into()),
    }
}

pub(super) fn validate(method: &str, args: &[Value]) -> Result<(), String> {
    parse(method, args).map(|_| ())
}

pub(super) fn execute(
    db: &Database,
    plugin: &str,
    method: &str,
    args: &[Value],
    context: Option<&ExecutionContext>,
) -> Result<Value, String> {
    execute_bound(
        db,
        plugin,
        method,
        args,
        context.map(|context| {
            (
                &*context.runtime,
                &*context.session,
                context.invocation_id.as_str(),
            )
        }),
    )
}

// Kept independent of AppHandle so authorization failures can be checked without
// a WebView or loopback server. Production always supplies the approved context.
pub(super) fn execute_bound(
    db: &Database,
    plugin: &str,
    method: &str,
    args: &[Value],
    context: Option<(&Sessions, &Session, &str)>,
) -> Result<Value, String> {
    #[cfg(not(test))]
    if context.is_none() {
        return Err("Dynamic features require an approved data session".into());
    }
    let request = parse(method, args)?;
    let invocation = context
        .map(|(runtime, session, ticket)| {
            let store = runtime.store.lock();
            let current = store
                .sessions
                .get(&session.id)
                .ok_or("Data session closed")?;
            let invocation = store
                .invocations
                .get(ticket)
                .ok_or("Data invocation expired")?;
            if current.owner != session.owner
                || session.owner.plugin != plugin
                || invocation.session != session.id
                || invocation.request["method"] != method
                || invocation.request["args"].as_array().map(Vec::as_slice) != Some(args)
                || !invocation.claimed.load(Ordering::Acquire)
            {
                return Err("Dynamic feature invocation identity mismatch");
            }
            Ok(invocation.clone())
        })
        .transpose()?;
    // Never acquire the store while holding active: close acquires store first.
    // A close before this guard rejects the operation; an in-flight operation
    // owns the guard until its bounded transaction and private flag complete.
    let active = context.map(|(_, session, _)| session.active.lock());
    if let Some((_, session, _)) = context {
        if active.as_deref() != Some(&true) {
            return Err("Data session closed".into());
        }
        super::validate_session(db, session)?;
    }
    let (result, changed) = match request {
        Request::Get(codes) => (
            Value::Array(
                db.plugin_dynamic_features(plugin, codes.as_deref())
                    .map_err(|e| e.to_string())?,
            ),
            false,
        ),
        Request::Set(features) => {
            let (success, changed) = db
                .plugin_dynamic_features_set_with_change(plugin, features)
                .map_err(|e| e.to_string())?;
            (Value::Bool(success), changed)
        }
        Request::Remove(codes) => {
            let (success, changed) = db
                .plugin_dynamic_features_remove_with_change(plugin, &codes)
                .map_err(|e| e.to_string())?;
            (Value::Bool(success), changed)
        }
    };
    if changed {
        if let Some(invocation) = invocation {
            invocation
                .dynamic_features_changed
                .store(true, Ordering::Release);
        }
    }
    Ok(result)
}

pub(super) fn should_refresh(
    method: &str,
    task_succeeded: bool,
    result: Option<&Result<Value, String>>,
    changed: bool,
) -> bool {
    matches!(method, "features.set" | "features.remove")
        && task_succeeded
        && changed
        && result.is_some_and(|result| matches!(result, Ok(Value::Bool(true))))
}
