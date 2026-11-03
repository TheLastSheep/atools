use super::SidecarError;
use serde_json::Value;
use std::collections::HashMap;
use tokio::sync::oneshot;

pub(super) fn route_response(
    value: Value,
    pending: &mut HashMap<u64, oneshot::Sender<Result<Value, SidecarError>>>,
) {
    let Some(id) = value.get("id").and_then(Value::as_u64) else {
        return;
    };
    let Some(response) = pending.remove(&id) else {
        return;
    };
    if let Some(error) = value.get("error") {
        let code = error.get("code").and_then(Value::as_i64).unwrap_or(-32_000);
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown JSON-RPC error")
            .to_string();
        let _ = response.send(Err(SidecarError::Remote { code, message }));
    } else if let Some(result) = value.get("result") {
        let _ = response.send(Ok(result.clone()));
    } else {
        let _ = response.send(Err(SidecarError::Protocol(
            "JSON-RPC response has neither result nor error".to_string(),
        )));
    }
}

pub(super) fn fail_pending(
    pending: &mut HashMap<u64, oneshot::Sender<Result<Value, SidecarError>>>,
    error: SidecarError,
) {
    for (_, response) in pending.drain() {
        let _ = response.send(Err(error.clone()));
    }
}
