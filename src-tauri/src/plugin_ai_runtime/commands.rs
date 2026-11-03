use super::{
    registry,
    types::{Binding, FrameBinding, Mode, Owner, Request, MAX_REQUEST_BYTES, PREPARED_LEASE},
};
use crate::{ai_runtime::AiProviderConfig, plugin_page_runtime::resolve_binding};
use atools_core::{
    ai_service::{valid_model_id, validate_request, AiModel, AiRequest},
    Database,
};
use serde_json::{json, Value};
use std::{
    io::{self, Write},
    sync::Arc,
    time::Instant,
};
use tauri::{AppHandle, Manager, WebviewWindow};

fn state(app: &AppHandle) -> Result<Arc<Database>, String> {
    Ok(app.state::<crate::state::AppState>().db.clone())
}
fn configured(db: &Database) -> Result<Value, String> {
    let raw = db
        .get_setting("settings-general")
        .map_err(|_| "AI settings unavailable")?
        .unwrap_or_else(|| "{}".into());
    let settings: Value = serde_json::from_str(&raw).map_err(|_| "AI settings unavailable")?;
    Ok(settings)
}
fn current(
    app: &AppHandle,
    window: &str,
    plugin: &str,
    instance: &str,
    generation: u64,
    nonce: String,
    doc: Option<String>,
) -> Result<
    (
        Owner,
        FrameBinding,
        Option<crate::plugin_page_runtime::DocumentBinding>,
        Binding,
    ),
    String,
> {
    let (owner, frame) = super::owner_frame(window, plugin, instance, generation, nonce, doc)?;
    let document = resolve_binding(app, window, plugin, frame.page_document_id.as_deref())?;
    if document.as_ref().map(|d| d.id()) != frame.page_document_id.as_deref() {
        return Err("AI document identity mismatch".into());
    }
    let db = state(app)?;
    let installed = db.get_plugin(plugin).map_err(|_| "Plugin unavailable")?;
    let binding = Binding::current(&db, &installed)?;
    Ok((owner, frame, document, binding))
}
fn config(db: &Database) -> Result<AiProviderConfig, String> {
    let raw = db
        .get_setting("settings-general")
        .map_err(|_| "AI settings unavailable")?
        .ok_or("AI settings are not configured")?;
    let settings: Value = serde_json::from_str(&raw).map_err(|_| "AI settings unavailable")?;
    AiProviderConfig::from_settings(&settings).map_err(super::executor::safe_error)
}
fn ensure_identity(
    app: &AppHandle,
    window: &str,
    plugin: &str,
    instance: &str,
    page_document_id: Option<String>,
    frame_generation: u64,
    document_nonce: String,
) -> Result<
    (
        Owner,
        FrameBinding,
        Option<crate::plugin_page_runtime::DocumentBinding>,
        Binding,
    ),
    String,
> {
    current(
        app,
        window,
        plugin,
        instance,
        frame_generation,
        document_nonce,
        page_document_id,
    )
}
fn within_request_limit(request: &Value) -> Result<bool, String> {
    struct Counter {
        bytes: usize,
    }
    impl Write for Counter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.bytes = self.bytes.saturating_add(buffer.len());
            if self.bytes > MAX_REQUEST_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "request too large",
                ));
            }
            Ok(buffer.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter { bytes: 0 };
    match serde_json::to_writer(&mut counter, request) {
        Ok(()) => Ok(true),
        Err(_error) if counter.bytes > MAX_REQUEST_BYTES => Ok(false),
        Err(_) => Err("Invalid AI request".into()),
    }
}

#[tauri::command]
pub(crate) fn list_plugin_ai_models(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    instance_id: String,
    page_document_id: Option<String>,
    frame_generation: u64,
    document_nonce: String,
) -> Result<Value, String> {
    let (_, _, _, binding) = ensure_identity(
        &app,
        window.label(),
        &plugin_id,
        &instance_id,
        page_document_id,
        frame_generation,
        document_nonce,
    )?;
    let db = state(&app)?;
    let settings = configured(&db)?;
    binding.validate(&db, &plugin_id)?;
    let Ok(provider) = AiProviderConfig::from_settings(&settings) else {
        return Ok(json!({"configured":false,"models":[]}));
    };
    let Some(model) = provider.default_model().filter(|m| valid_model_id(m)) else {
        return Ok(json!({"configured":false,"models":[]}));
    };
    Ok(json!({"configured":true,"models":[{"id":model,"value":model,"label":model}]}))
}

#[tauri::command]
pub(crate) fn prepare_plugin_ai_request(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    instance_id: String,
    page_document_id: Option<String>,
    frame_generation: u64,
    document_nonce: String,
    client_request_id: String,
    request: Value,
    mode: String,
) -> Result<Value, String> {
    let (owner, frame, document, binding) = ensure_identity(
        &app,
        window.label(),
        &plugin_id,
        &instance_id,
        page_document_id,
        frame_generation,
        document_nonce,
    )?;
    let client_request_id = uuid::Uuid::parse_str(&client_request_id)
        .map_err(|_| "Invalid AI client request id")?
        .to_string();
    if !within_request_limit(&request)? {
        return Err("AI request exceeds the 3 MiB limit".into());
    }
    let parsed: AiRequest = serde_json::from_value(request).map_err(|_| "Invalid AI request")?;
    validate_request(&parsed).map_err(super::executor::safe_error)?;
    let mode = Mode::parse(&mode)?;
    let db = state(&app)?;
    let plugin = db
        .get_plugin(&plugin_id)
        .map_err(|_| "Plugin unavailable")?;
    let tool = registry::ensure_tool(&db, &plugin)?;
    let permission_at_prepare =
        crate::agent_tools::permission_decision_for_tool(&db, "atools-ui", &tool)?;
    let cfg = config(&db)?;
    let model = cfg
        .default_model()
        .ok_or("AI default model is not configured")?
        .to_owned();
    if parsed.model.as_deref().is_some_and(|m| m != model) {
        return Err("Plugin AI only supports the configured default model".into());
    }
    cfg.resolve_model(
        Some(&model),
        &[AiModel {
            id: model.clone(),
            value: model.clone(),
            label: model.clone(),
        }],
    )
    .map_err(super::executor::safe_error)?;
    let request_id = uuid::Uuid::new_v4().to_string();
    let runtime = super::manager(&app)?;
    let req = Arc::new(Request {
        id: request_id.clone(),
        client_id: client_request_id.clone(),
        owner: owner.clone(),
        frame: frame.clone(),
        document,
        binding,
        tool,
        permission_at_prepare,
        mode,
        model: model.clone(),
        request: parking_lot::Mutex::new(Some(parsed)),
        created: Instant::now(),
        cancel: crate::ai_runtime::AiCancelHandle::new(),
        run_id: parking_lot::Mutex::new(None),
        submitted: parking_lot::Mutex::new(false),
        started: parking_lot::Mutex::new(false),
        task_terminal: parking_lot::Mutex::new(false),
        running_at: parking_lot::Mutex::new(None),
        output: parking_lot::Mutex::new(None),
        output_bytes: parking_lot::Mutex::new(0),
        delta_count: parking_lot::Mutex::new(0),
        expires_result: parking_lot::Mutex::new(None),
        channel: parking_lot::Mutex::new(None),
        ack: parking_lot::Mutex::new(None),
        active: parking_lot::Mutex::new(true),
    });
    runtime.insert(req.clone())?;
    super::lifecycle::schedule_expiry(&app, &runtime, &req, PREPARED_LEASE);
    Ok(
        json!({"ok":true,"requestId":request_id,"clientRequestId":client_request_id,"model":model,"expiresInMs":PREPARED_LEASE.as_millis() as u64}),
    )
}

#[tauri::command]
pub(crate) async fn execute_plugin_ai_request(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    instance_id: String,
    page_document_id: Option<String>,
    frame_generation: u64,
    document_nonce: String,
    request_id: String,
    on_delta: tauri::ipc::Channel<super::types::AiDeltaEnvelope>,
) -> Result<Value, String> {
    let (owner, frame, _, binding) = ensure_identity(
        &app,
        window.label(),
        &plugin_id,
        &instance_id,
        page_document_id,
        frame_generation,
        document_nonce,
    )?;
    let runtime = super::manager(&app)?;
    let req = runtime.get(&request_id)?;
    super::validate_identity(&req, &owner, &frame)?;
    let db = state(&app)?;
    binding.validate(db.as_ref(), &plugin_id)?;
    {
        let mut submitted = req.submitted.lock();
        if *submitted {
            return Err("AI request was already submitted".into());
        }
        *submitted = true;
        *req.channel.lock() = Some(on_delta.clone());
    }
    let db = state(&app)?;
    let result = crate::agent_tools::call_tool_with_audit(
        &app,
        &db,
        "atools-ui",
        &req.tool,
        json!({"operation":"execute","requestId":req.id}),
        false,
    )
    .await;
    if result.structured_content.get("permission_required") == Some(&Value::Bool(true)) {
        return Ok(result.structured_content);
    }
    if result.is_error {
        return Err("Plugin AI request failed".into());
    }
    let value = result.structured_content;
    if value.get("status").and_then(Value::as_str) != Some("succeeded") {
        return Err("Plugin AI TaskRun did not succeed".into());
    }
    Ok(
        json!({"status":"completed","requestId":req.id,"model":req.model,"outputBytes":*req.output_bytes.lock(),"deltaCount":*req.delta_count.lock(),"runId":value.get("runId").and_then(Value::as_str)}),
    )
}

#[tauri::command]
pub(crate) fn ack_plugin_ai_delta(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    instance_id: String,
    page_document_id: Option<String>,
    frame_generation: u64,
    document_nonce: String,
    request_id: String,
    seq: u64,
) -> Result<(), String> {
    let (owner, frame, _, _) = ensure_identity(
        &app,
        window.label(),
        &plugin_id,
        &instance_id,
        page_document_id,
        frame_generation,
        document_nonce,
    )?;
    let runtime = super::manager(&app)?;
    let req = runtime.get(&request_id)?;
    super::validate_identity(&req, &owner, &frame)?;
    let outcome = {
        let mut ack = req.ack.lock();
        match ack.as_mut() {
            Some((expected, accepted, notify)) if *expected == seq && !*accepted => {
                *accepted = true;
                Ok(notify.clone())
            }
            _ => Err("AI delta acknowledgement mismatch".to_owned()),
        }
    };
    match outcome {
        Ok(notify) => {
            notify.notify_one();
            Ok(())
        }
        Err(error) => {
            if let Some(request) = runtime.remove(&request_id) {
                let db = state(&app)?;
                super::lifecycle::cancel_request(&app, db.as_ref(), request);
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub(crate) fn take_plugin_ai_result(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    instance_id: String,
    page_document_id: Option<String>,
    frame_generation: u64,
    document_nonce: String,
    request_id: String,
) -> Result<Value, String> {
    let (owner, frame, _, _) = ensure_identity(
        &app,
        window.label(),
        &plugin_id,
        &instance_id,
        page_document_id,
        frame_generation,
        document_nonce,
    )?;
    let runtime = super::manager(&app)?;
    let req = runtime.get(&request_id)?;
    super::validate_identity(&req, &owner, &frame)?;
    if req.mode != Mode::Collect {
        return Err("not_collect_mode".into());
    }
    if req
        .expires_result
        .lock()
        .is_none_or(|deadline| deadline <= Instant::now())
    {
        if let Some(expired) = runtime.remove(&request_id) {
            super::lifecycle::discard(expired);
        }
        return Err("AI result expired".into());
    }
    if !runtime.is_current(&req) {
        return Err("AI result expired or was cancelled".into());
    }
    let db = state(&app)?;
    super::executor::validate_completed(db.as_ref(), &req, &owner)?;
    let message = req
        .output
        .lock()
        .take()
        .ok_or("AI result unavailable or already consumed")?;
    let bytes = *req.output_bytes.lock();
    if let Some(removed) = runtime.remove(&request_id) {
        super::lifecycle::discard(removed);
    }
    Ok(json!({"requestId":req.id,"model":req.model,"message":message,"outputBytes":bytes}))
}

#[tauri::command]
pub(crate) fn cancel_plugin_ai_request(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    instance_id: String,
    page_document_id: Option<String>,
    frame_generation: u64,
    document_nonce: String,
    client_request_id: Option<String>,
    request_id: Option<String>,
) -> Result<bool, String> {
    let (owner, frame, _, _) = ensure_identity(
        &app,
        window.label(),
        &plugin_id,
        &instance_id,
        page_document_id,
        frame_generation,
        document_nonce,
    )?;
    let runtime = super::manager(&app)?;
    let removed = if let Some(id) = request_id {
        match runtime.get_optional(&id) {
            Some(req) => {
                super::validate_identity(&req, &owner, &frame)?;
                runtime.remove(&id)
            }
            None => None,
        }
    } else if let Some(client) = client_request_id {
        let client = uuid::Uuid::parse_str(&client)
            .map_err(|_| "Invalid AI client request id")?
            .to_string();
        runtime.cancel_client(&owner, &frame, &client)?
    } else {
        return Err("Missing AI request identity".into());
    };
    if let Some(req) = removed {
        let db = state(&app)?;
        super::lifecycle::cancel_request(&app, db.as_ref(), req);
        Ok(true)
    } else {
        Ok(false)
    }
}

#[cfg(test)]
#[path = "commands_tests.rs"]
mod tests;
