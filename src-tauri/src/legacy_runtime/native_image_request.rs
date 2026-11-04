//! TaskRun-backed, per-session transport for bounded native image operations.
use super::native_image::{
    EncodeRequest, ImageDescriptor, NativeImageCancellation, NativeImageEngine, NativeImageError,
    NativeImageSession, OpenSourceKind, OutputFormat, ResizeStep,
};
#[cfg(test)]
use super::native_image_session::ImageSessionStore;
#[cfg(test)]
use super::native_image_worker::WorkerFailure;
use super::native_image_worker::{run_open_worker, run_worker, worker_error, WORKER_DEADLINE};
use super::types::Session;
use atools_core::{
    agent::{PermissionScope, ToolDefinition},
    db::Database,
};
use atools_plugin::{
    legacy_node::NativeImageSource,
    sidecar::{SidecarError, SidecarStatus},
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
enum ImageOperation {
    OpenPath {
        path: String,
    },
    OpenBuffer {
        #[serde(rename = "byteLength")]
        byte_length: usize,
        #[serde(rename = "dataBase64")]
        data_base64: String,
    },
    Encode {
        #[serde(rename = "handleId")]
        handle_id: String,
        format: OutputFormat,
        #[serde(rename = "resizePlan")]
        resize_plan: Vec<ResizeStep>,
        #[serde(default, rename = "jpegQuality")]
        jpeg_quality: Option<u8>,
    },
}

pub(super) async fn handle(
    db: &Database,
    session: &Arc<Session>,
    request: &Value,
) -> Result<Value, String> {
    super::validate_session(db, session)?;
    let operation = parse_request_operation(request)?;
    match operation {
        ImageOperation::OpenPath { path } => open_path(db, session, &path).await,
        ImageOperation::OpenBuffer {
            byte_length,
            data_base64,
        } => open_buffer(db, session, byte_length, data_base64).await,
        ImageOperation::Encode {
            handle_id,
            format,
            resize_plan,
            jpeg_quality,
        } => {
            encode(
                db,
                session,
                handle_id,
                EncodeRequest {
                    format,
                    jpeg_quality,
                    resize_plan,
                },
            )
            .await
        }
    }
}

/// Parse the same request envelope accepted by the host route. Serde maps
/// `Option<T>` from both a missing field and JSON null, so reject explicit
/// nulls for contract-optional values before deserializing.
fn parse_request_operation(request: &Value) -> Result<ImageOperation, String> {
    let object = request
        .as_object()
        .filter(|object| {
            object.len() == 2
                && object.contains_key("method")
                && object.contains_key("params")
                && object.get("method").and_then(Value::as_str) == Some("nativeImageTransform")
        })
        .ok_or_else(|| fixed_error(NativeImageError::InvalidRequest))?;
    let params = object["params"].clone();
    if !optional_image_fields_are_non_null(&params) {
        return Err(fixed_error(NativeImageError::InvalidRequest));
    }
    serde_json::from_value(params).map_err(|_| fixed_error(NativeImageError::InvalidRequest))
}

async fn open_path(db: &Database, session: &Arc<Session>, path: &str) -> Result<Value, String> {
    require_file_read(db, session)?;
    let store = session
        .native_image_store
        .get_or_create(&session.native_image_engine)
        .map_err(fixed_error)?;
    let (reservation, source) =
        match reserve_path_source(&session.native_image_engine, &store, |max_bytes| {
            session
                .runtime
                .read_native_image_path_with_limit(path, max_bytes)
        })
        .await
        {
            Ok(result) => result,
            Err(PathReadError::Budget(error)) => return Err(fixed_error(error)),
            Err(PathReadError::Source(_)) => {
                if session.runtime.status() != SidecarStatus::Running {
                    session.native_image_store.close();
                }
                return Err(
                    "ERR_ATOOLS_NATIVE_IMAGE_SOURCE_READ: Unable to read image source".into(),
                );
            }
        };
    super::validate_session(db, session)?;
    require_file_read(db, session)?;
    let permit = session
        .native_image_engine
        .try_worker()
        .map_err(fixed_error)?;
    let engine = Arc::clone(&session.native_image_engine);
    let engine_for_worker = Arc::clone(&engine);
    let store_for_worker = Arc::clone(&store);
    let source_bytes = source.bytes;
    let result = run_open_worker(
        &session.native_image_store,
        &store,
        &engine,
        || session.runtime.status() == SidecarStatus::Running,
        permit,
        move |(token, permit)| {
            engine_for_worker.open_bytes(
                &store_for_worker,
                reservation,
                source_bytes,
                permit,
                &token,
            )
        },
        WORKER_DEADLINE,
    )
    .await;
    let descriptor = result.map_err(worker_error)?;
    complete_open(db, session, &store, descriptor)
}

async fn open_buffer(
    db: &Database,
    session: &Arc<Session>,
    byte_length: usize,
    data_base64: String,
) -> Result<Value, String> {
    super::validate_session(db, session)?;
    let store = session
        .native_image_store
        .get_or_create(&session.native_image_engine)
        .map_err(fixed_error)?;
    // Reserve from the declared exact length before decoding attacker-controlled base64.
    let reservation = session
        .native_image_engine
        .reserve_open(&store, OpenSourceKind::WebViewBuffer { byte_length })
        .map_err(fixed_error)?;
    let expected_encoded =
        encoded_length(byte_length).ok_or_else(|| fixed_error(NativeImageError::InvalidRequest))?;
    if data_base64.len() != expected_encoded || !data_base64.is_ascii() {
        return Err(fixed_error(NativeImageError::InvalidRequest));
    }
    let permit = session
        .native_image_engine
        .try_worker()
        .map_err(fixed_error)?;
    let engine = Arc::clone(&session.native_image_engine);
    let engine_for_worker = Arc::clone(&engine);
    let store_for_worker = Arc::clone(&store);
    let result = run_open_worker(
        &session.native_image_store,
        &store,
        &engine,
        || session.runtime.status() == SidecarStatus::Running,
        permit,
        move |(token, permit)| {
            let bytes = decode_canonical(&data_base64, byte_length)?;
            engine_for_worker.open_bytes(&store_for_worker, reservation, bytes, permit, &token)
        },
        WORKER_DEADLINE,
    )
    .await;
    let descriptor = result.map_err(worker_error)?;
    complete_open(db, session, &store, descriptor)
}

async fn encode(
    db: &Database,
    session: &Arc<Session>,
    handle_id: String,
    request: EncodeRequest,
) -> Result<Value, String> {
    super::validate_session(db, session)?;
    let store = session.native_image_store.current().map_err(fixed_error)?;
    let permit = session
        .native_image_engine
        .try_worker()
        .map_err(fixed_error)?;
    let engine = Arc::clone(&session.native_image_engine);
    let store_for_worker = Arc::clone(&store);
    let result = run_worker(
        permit,
        move |token, permit| engine.encode(&store_for_worker, &handle_id, &request, permit, &token),
        WORKER_DEADLINE,
        NativeImageCancellation::default(),
    )
    .await
    .map_err(worker_error)?;
    super::validate_session(db, session)?;
    if !session.native_image_store.is_current(&store) {
        return Err("ERR_ATOOLS_NATIVE_IMAGE_SESSION_CLOSED: Image session changed".into());
    }
    let data_base64 = STANDARD.encode(&result.bytes);
    Ok(json!({
        "format": result.format,
        "width": result.width,
        "height": result.height,
        "byteLength": result.bytes.len(),
        "dataBase64": data_base64,
    }))
}

fn complete_open(
    db: &Database,
    session: &Session,
    store: &Arc<NativeImageSession>,
    descriptor: ImageDescriptor,
) -> Result<Value, String> {
    super::validate_session(db, session)?;
    if !session.native_image_store.is_current(store) {
        return Err("ERR_ATOOLS_NATIVE_IMAGE_SESSION_CLOSED: Image session changed".into());
    }
    serde_json::to_value(descriptor).map_err(|_| "ERR_ATOOLS_NATIVE_IMAGE_INVALID_RESPONSE".into())
}

fn require_file_read(db: &Database, session: &Session) -> Result<(), String> {
    let tool = db
        .get_agent_tool(&session.tool)
        .map_err(|_| "ERR_ATOOLS_NATIVE_IMAGE_PERMISSION: File read is unavailable")?
        .ok_or("ERR_ATOOLS_NATIVE_IMAGE_PERMISSION: File read is unavailable")?;
    if !is_file_read_tool(&tool, &session.plugin_id, &session.tool) {
        return Err("ERR_ATOOLS_NATIVE_IMAGE_PERMISSION: File read is unavailable".into());
    }
    Ok(())
}

fn is_file_read_tool(tool: &ToolDefinition, plugin_id: &str, tool_name: &str) -> bool {
    tool.source == "legacy_node"
        && tool.name == tool_name
        && tool.name == super::registry::tool_name(plugin_id)
        && tool.plugin_id.as_deref() == Some(plugin_id)
        && tool.scopes.contains(&PermissionScope::FileRead)
}

fn encoded_length(byte_length: usize) -> Option<usize> {
    byte_length.checked_add(2)?.checked_div(3)?.checked_mul(4)
}

#[derive(Debug)]
enum PathReadError {
    Budget(NativeImageError),
    Source(#[allow(dead_code)] SidecarError),
}

async fn reserve_path_source<F, Fut>(
    engine: &NativeImageEngine,
    store: &NativeImageSession,
    read: F,
) -> Result<(super::native_image::OpenReservation, NativeImageSource), PathReadError>
where
    F: FnOnce(usize) -> Fut,
    Fut: std::future::Future<Output = Result<NativeImageSource, SidecarError>>,
{
    let reservation = engine
        .reserve_open(store, OpenSourceKind::NodePath)
        .map_err(PathReadError::Budget)?;
    let source = read(reservation.max_bytes())
        .await
        .map_err(PathReadError::Source)?;
    Ok((reservation, source))
}

fn decode_canonical(encoded: &str, expected_length: usize) -> Result<Vec<u8>, NativeImageError> {
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| NativeImageError::InvalidRequest)?;
    if bytes.len() != expected_length || STANDARD.encode(&bytes) != encoded {
        return Err(NativeImageError::InvalidRequest);
    }
    Ok(bytes)
}

fn fixed_error(error: NativeImageError) -> String {
    format!("{}: {}", error.code(), error.message())
}

fn optional_image_fields_are_non_null(params: &Value) -> bool {
    let Some(object) = params.as_object() else {
        return false;
    };
    if object.get("operation").and_then(Value::as_str) != Some("encode") {
        return true;
    }
    if object.get("jpegQuality").is_some_and(Value::is_null) {
        return false;
    }
    let Some(steps) = object.get("resizePlan").and_then(Value::as_array) else {
        return true;
    };
    steps.iter().all(|step| {
        let Some(step) = step.as_object() else {
            return false;
        };
        ["width", "height", "quality"]
            .iter()
            .all(|key| !step.get(*key).is_some_and(Value::is_null))
    })
}

#[cfg(test)]
#[path = "native_image_request_tests.rs"]
mod tests;
