use super::child_io::OutputStream;
use super::error::RequestFailure;
use super::protocol::{write_frame, MAX_CREDIT_GRANT, MAX_WRITE_BYTES};
use super::spawn::spawn_managed_child;
use super::spawn::{ChildCommand, ManagedChild, SpawnSpec, StdioMode};
use crate::sidecar::SidecarError;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use tokio::io::AsyncWrite;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinSet;

const MAX_RETAINED_TOMBSTONES: usize = 512;
const MAX_ENV_KEY_BYTES: usize = 4096;
const MAX_ENV_VALUE_BYTES: usize = 32 * 1024;

pub(super) enum ChildEntry {
    Running(Arc<ManagedChild>),
    Finished,
}

pub(super) async fn handle_frame<W: AsyncWrite + Unpin>(
    value: Value,
    last_request_id: &mut u64,
    next_child_id: &mut u64,
    children: &mut HashMap<u64, ChildEntry>,
    owner_budget: &Arc<tokio::sync::Semaphore>,
    events: &mpsc::Sender<Value>,
    tasks: &mut JoinSet<(u64, Result<(), SidecarError>)>,
    writer: &mut W,
) -> Result<(), SidecarError> {
    let id = value
        .get("id")
        .and_then(Value::as_u64)
        .filter(|id| *id > 0)
        .ok_or_else(|| {
            SidecarError::Protocol("managed child control id must be a positive integer".into())
        })?;
    if id <= *last_request_id {
        write_response(
            writer,
            id,
            Err(RequestFailure::invalid("control ids must increase")),
        )
        .await?;
        return Ok(());
    }
    *last_request_id = id;
    let operation = value
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| SidecarError::Protocol("managed child request is missing op".into()))?
        .to_owned();
    let result = match validate_request_fields(&value, &operation) {
        Err(error) => Err(error),
        Ok(()) => match operation.as_str() {
            "spawn" => {
                handle_spawn(value, next_child_id, children, owner_budget, events, tasks).await
            }
            "kill" => handle_kill(&value, children).await,
            "write" => handle_write(&value, children).await,
            "end" => handle_end(&value, children).await,
            "credit" => handle_credit(&value, children).await,
            _ => Err(RequestFailure::new(
                "ERR_ATOOLS_CHILD_UNSUPPORTED",
                "unsupported managed child operation",
                None,
            )),
        },
    };
    write_response_and_escalate(writer, id, result).await
}

async fn write_response_and_escalate<W: AsyncWrite + Unpin>(
    writer: &mut W,
    id: u64,
    result: Result<Value, RequestFailure>,
) -> Result<(), SidecarError> {
    let fatal_cleanup = result
        .as_ref()
        .err()
        .and_then(|failure| failure.fatal_cleanup.clone());
    write_response(writer, id, result).await?;
    fatal_cleanup.map_or(Ok(()), Err)
}

fn validate_request_fields(value: &Value, operation: &str) -> Result<(), RequestFailure> {
    let allowed: &[&str] = match operation {
        "spawn" => &["id", "op", "file", "args", "envPairs", "cwd", "stdio"],
        "kill" => &["id", "op", "childId", "signal", "group"],
        "write" => &["id", "op", "childId", "writeId", "data"],
        "end" => &["id", "op", "childId", "writeId"],
        "credit" => &["id", "op", "childId", "stream", "count"],
        _ => &["id", "op"],
    };
    let object = value
        .as_object()
        .ok_or_else(|| RequestFailure::invalid("request must be a JSON object"))?;
    if let Some(field) = object
        .keys()
        .find(|field| !allowed.contains(&field.as_str()))
    {
        return Err(RequestFailure::invalid(format!(
            "unsupported field for {operation}: {field}"
        )));
    }
    Ok(())
}

async fn handle_spawn(
    request: Value,
    next_child_id: &mut u64,
    children: &mut HashMap<u64, ChildEntry>,
    owner_budget: &Arc<tokio::sync::Semaphore>,
    events: &mpsc::Sender<Value>,
    tasks: &mut JoinSet<(u64, Result<(), SidecarError>)>,
) -> Result<Value, RequestFailure> {
    let spec = parse_spawn(&request)?;
    let child_id = *next_child_id;
    *next_child_id = (*next_child_id)
        .checked_add(1)
        .ok_or_else(|| RequestFailure::invalid("managed child id space exhausted"))?;
    let (child, pid) = spawn_managed_child(
        child_id,
        spec,
        Arc::clone(owner_budget),
        events.clone(),
        tasks,
    )
    .await?;
    children.insert(child_id, ChildEntry::Running(Arc::new(child)));
    Ok(json!({"childId":child_id.to_string(),"pid":pid}))
}

async fn handle_kill(
    request: &Value,
    children: &HashMap<u64, ChildEntry>,
) -> Result<Value, RequestFailure> {
    let child_id = child_id(request)?;
    let signal = request
        .get("signal")
        .and_then(Value::as_i64)
        .and_then(|signal| i32::try_from(signal).ok())
        .filter(|signal| super::spawn::signal_is_valid(*signal))
        .ok_or_else(|| RequestFailure::invalid("signal is outside the platform range"))?;
    let group = request
        .get("group")
        .and_then(Value::as_bool)
        .ok_or_else(|| RequestFailure::invalid("group must be boolean"))?;
    match children.get(&child_id) {
        Some(ChildEntry::Finished) => Ok(json!({"accepted":false})),
        Some(ChildEntry::Running(child)) => {
            let (response, receiver) = oneshot::channel();
            child
                .commands
                .send(ChildCommand::Kill {
                    signal,
                    group,
                    response,
                })
                .await
                .map_err(|_| {
                    RequestFailure::new("ERR_ATOOLS_CHILD_CLOSED", "managed child is closed", None)
                })?;
            receiver
                .await
                .map_err(|_| {
                    RequestFailure::new("ERR_ATOOLS_CHILD_CLOSED", "managed child stopped", None)
                })?
                .map(|accepted| json!({"accepted":accepted}))
        }
        None => Err(unknown_child()),
    }
}

async fn handle_write(
    request: &Value,
    children: &HashMap<u64, ChildEntry>,
) -> Result<Value, RequestFailure> {
    let child_id = child_id(request)?;
    let write_id = request
        .get("writeId")
        .and_then(Value::as_u64)
        .filter(|id| *id > 0)
        .ok_or_else(|| RequestFailure::invalid("writeId must be a positive integer"))?;
    let encoded = request
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| RequestFailure::invalid("data must be base64 text"))?;
    if encoded.len() > MAX_WRITE_BYTES.div_ceil(3) * 4 {
        return Err(RequestFailure::invalid("stdin chunk exceeds 64 KiB"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| RequestFailure::invalid("data is not valid base64"))?;
    if bytes.len() > MAX_WRITE_BYTES {
        return Err(RequestFailure::invalid("stdin chunk exceeds 64 KiB"));
    }
    match running_child(children, child_id)? {
        Some(child) => {
            send_child_command(child, |response| ChildCommand::Write {
                write_id,
                bytes,
                response,
            })
            .await?;
            Ok(json!({"accepted":true}))
        }
        None => Err(RequestFailure::new(
            "ERR_ATOOLS_CHILD_CLOSED",
            "managed child is closed",
            None,
        )),
    }
}

async fn handle_end(
    request: &Value,
    children: &HashMap<u64, ChildEntry>,
) -> Result<Value, RequestFailure> {
    let child_id = child_id(request)?;
    let write_id = request
        .get("writeId")
        .and_then(Value::as_u64)
        .filter(|id| *id > 0)
        .ok_or_else(|| RequestFailure::invalid("writeId must be a positive integer"))?;
    match running_child(children, child_id)? {
        Some(child) => {
            send_child_command(child, |response| ChildCommand::End { write_id, response }).await?;
            Ok(json!({"accepted":true}))
        }
        None => Err(RequestFailure::new(
            "ERR_ATOOLS_CHILD_CLOSED",
            "managed child is closed",
            None,
        )),
    }
}

async fn handle_credit(
    request: &Value,
    children: &HashMap<u64, ChildEntry>,
) -> Result<Value, RequestFailure> {
    let count = request
        .get("count")
        .and_then(Value::as_u64)
        .and_then(|count| usize::try_from(count).ok())
        .ok_or_else(|| RequestFailure::invalid("credit count must be a positive integer"))?;
    if !(1..=MAX_CREDIT_GRANT).contains(&count) {
        return Err(RequestFailure::invalid(format!(
            "credit count must be between 1 and {MAX_CREDIT_GRANT}"
        )));
    }
    let child_id = child_id(request)?;
    let stream = match request.get("stream").and_then(Value::as_str) {
        Some("stdout") => OutputStream::Stdout,
        Some("stderr") => OutputStream::Stderr,
        _ => return Err(RequestFailure::invalid("stream must be stdout or stderr")),
    };
    match children.get(&child_id) {
        Some(ChildEntry::Finished) => Ok(json!({"accepted":true})),
        Some(ChildEntry::Running(child)) => {
            match send_child_command(child, |response| ChildCommand::Credit {
                stream,
                count,
                response,
            })
            .await
            {
                Ok(()) => Ok(json!({"accepted":true})),
                Err(error) if error.code == "ERR_ATOOLS_CHILD_CLOSED" => {
                    Ok(json!({"accepted":true}))
                }
                Err(error) => Err(error),
            }
        }
        None => Err(unknown_child()),
    }
}

async fn send_child_command<F>(child: &ManagedChild, make: F) -> Result<(), RequestFailure>
where
    F: FnOnce(oneshot::Sender<Result<(), RequestFailure>>) -> ChildCommand,
{
    let (response, receiver) = oneshot::channel();
    child.commands.send(make(response)).await.map_err(|_| {
        RequestFailure::new("ERR_ATOOLS_CHILD_CLOSED", "managed child is closed", None)
    })?;
    receiver.await.map_err(|_| {
        RequestFailure::new("ERR_ATOOLS_CHILD_CLOSED", "managed child stopped", None)
    })?
}

fn running_child(
    children: &HashMap<u64, ChildEntry>,
    child_id: u64,
) -> Result<Option<&ManagedChild>, RequestFailure> {
    match children.get(&child_id) {
        Some(ChildEntry::Running(child)) => Ok(Some(child)),
        Some(ChildEntry::Finished) => Ok(None),
        None => Err(unknown_child()),
    }
}

fn parse_spawn(request: &Value) -> Result<SpawnSpec, RequestFailure> {
    let file = request
        .get("file")
        .and_then(Value::as_str)
        .filter(|file| !file.is_empty() && file.len() <= 8192 && !file.contains('\0'))
        .ok_or_else(|| RequestFailure::invalid("file must be a non-empty path"))?
        .to_owned();
    let args = request
        .get("args")
        .and_then(Value::as_array)
        .filter(|args| !args.is_empty() && args.len() <= 256)
        .ok_or_else(|| {
            RequestFailure::invalid("args must contain argv[0] and at most 255 arguments")
        })?
        .iter()
        .map(|arg| string_field(arg, "args entry", 8192))
        .collect::<Result<Vec<_>, _>>()?;
    let env_pairs = parse_env_pairs(request.get("envPairs"))?;
    let cwd = request
        .get("cwd")
        .map(|cwd| string_field(cwd, "cwd", 8192))
        .transpose()?;
    let stdio = parse_stdio(request.get("stdio"))?;
    Ok(SpawnSpec {
        file,
        args,
        env_pairs,
        cwd,
        stdio,
    })
}

fn parse_env_pairs(value: Option<&Value>) -> Result<Vec<(String, String)>, RequestFailure> {
    let entries = value
        .and_then(Value::as_array)
        .filter(|entries| entries.len() <= 256)
        .ok_or_else(|| {
            RequestFailure::invalid("envPairs must be an array of at most 256 entries")
        })?;
    let mut result = Vec::with_capacity(entries.len());
    let mut keys = std::collections::HashSet::new();
    for entry in entries {
        let assignment = string_field(
            entry,
            "envPairs entry",
            MAX_ENV_KEY_BYTES + 1 + MAX_ENV_VALUE_BYTES,
        )?;
        let (key, value) = assignment.split_once('=').ok_or_else(|| {
            RequestFailure::invalid("each envPairs entry must use KEY=VALUE format")
        })?;
        if key.is_empty()
            || key.len() > MAX_ENV_KEY_BYTES
            || value.len() > MAX_ENV_VALUE_BYTES
            || !keys.insert(key.to_owned())
        {
            return Err(RequestFailure::invalid(
                "environment keys must be non-empty, unique, and within the size limit",
            ));
        }
        result.push((key.to_owned(), value.to_owned()));
    }
    Ok(result)
}

fn parse_stdio(value: Option<&Value>) -> Result<[StdioMode; 3], RequestFailure> {
    let modes = value
        .and_then(Value::as_array)
        .filter(|modes| modes.len() == 3)
        .ok_or_else(|| RequestFailure::invalid("stdio must contain exactly three modes"))?;
    let parsed = modes
        .iter()
        .map(|mode| match mode.as_str() {
            Some("pipe") => Ok(StdioMode::Pipe),
            Some("ignore") => Ok(StdioMode::Ignore),
            _ => Err(RequestFailure::new(
                "ERR_ATOOLS_CHILD_STDIO_UNSUPPORTED",
                "stdio modes must be pipe or ignore",
                None,
            )),
        })
        .collect::<Result<Vec<_>, _>>()?;
    parsed
        .try_into()
        .map_err(|_| RequestFailure::invalid("stdio must contain three modes"))
}

fn string_field(value: &Value, name: &str, max_bytes: usize) -> Result<String, RequestFailure> {
    value
        .as_str()
        .filter(|text| text.len() <= max_bytes && !text.contains('\0'))
        .map(str::to_owned)
        .ok_or_else(|| {
            RequestFailure::invalid(format!("{name} must be a string within its size limit"))
        })
}

fn child_id(request: &Value) -> Result<u64, RequestFailure> {
    let text = request
        .get("childId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .ok_or_else(|| RequestFailure::invalid("childId must be a canonical decimal string"))?;
    let id = text
        .parse::<u64>()
        .ok()
        .filter(|id| *id > 0 && id.to_string() == text)
        .ok_or_else(|| {
            RequestFailure::invalid("childId must be a positive canonical decimal string")
        })?;
    Ok(id)
}

fn unknown_child() -> RequestFailure {
    RequestFailure::new(
        "ERR_ATOOLS_CHILD_UNKNOWN",
        "unknown managed child handle",
        None,
    )
}

async fn write_response<W: AsyncWrite + Unpin>(
    writer: &mut W,
    id: u64,
    result: Result<Value, RequestFailure>,
) -> Result<(), SidecarError> {
    let response = match result {
        Ok(result) => json!({"id":id,"ok":true,"result":result}),
        Err(error) => json!({"id":id,"ok":false,"error":error.to_value()}),
    };
    write_frame(writer, &response).await
}

pub(super) fn finish_child(
    id: u64,
    result: Result<(), SidecarError>,
    children: &mut HashMap<u64, ChildEntry>,
    tombstones: &mut VecDeque<u64>,
    first_error: &mut Option<SidecarError>,
) {
    if let Err(error) = result {
        first_error.get_or_insert(error);
    }
    children.insert(id, ChildEntry::Finished);
    tombstones.push_back(id);
    prune_tombstones(children, tombstones);
}

pub(super) fn prune_tombstones(
    children: &mut HashMap<u64, ChildEntry>,
    tombstones: &mut VecDeque<u64>,
) {
    while tombstones.len() > MAX_RETAINED_TOMBSTONES {
        if let Some(id) = tombstones.pop_front() {
            if matches!(children.get(&id), Some(ChildEntry::Finished)) {
                children.remove(&id);
            }
        }
    }
}

#[cfg(test)]
#[path = "requests_tests.rs"]
mod tests;
