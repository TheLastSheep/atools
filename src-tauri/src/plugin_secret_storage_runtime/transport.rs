use super::{lifecycle::InvocationLease, registry, types::credential, Sessions};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

pub(super) async fn ensure_server(app: &AppHandle, rt: &Arc<Sessions>) -> Result<(), String> {
    let mut server = rt.server.lock().await;
    if rt.store.lock().sessions.is_empty() {
        return Err("Secret storage opening cancelled".into());
    }
    if server.is_none() {
        *server = Some(
            crate::plugin_loopback::BridgeServer::start_scoped(
                Arc::new(Router {
                    app: app.clone(),
                    runtime: rt.clone(),
                }),
                "secrets",
            )
            .await?,
        )
    }
    Ok(())
}
struct Router {
    app: AppHandle,
    runtime: Arc<Sessions>,
}
#[async_trait]
impl crate::plugin_loopback::RequestHandler for Router {
    fn authenticated(&self, token: &str) -> bool {
        self.runtime.by_token(token).is_some()
    }
    fn max_request_body_bytes(&self, _: &str) -> Option<usize> {
        Some(registry::MAX_WIRE_BYTES)
    }
    fn origin_policy(&self, token: &str) -> crate::plugin_loopback::OriginPolicy {
        self.runtime
            .by_token(token)
            .map_or(crate::plugin_loopback::OriginPolicy::Deny, |s| {
                s.document
                    .as_ref()
                    .map_or(crate::plugin_loopback::OriginPolicy::Opaque, |d| {
                        d.origin_policy()
                    })
            })
    }
    async fn handle(&self, token: &str, payload: Value) -> Result<Value, String> {
        let session = self.runtime.by_token(token).ok_or("SESSION_UNAVAILABLE")?;
        let state = self.app.state::<crate::state::AppState>();
        if let Err(e) = super::validate_session(&state.db, &session) {
            super::lifecycle::close(
                &self.app,
                &state.db,
                &self.runtime,
                Some(&session.owner),
                None,
                None,
                false,
            )
            .await;
            return Err(fixed_error(&e));
        }
        validate_payload(&payload)?;
        let (ticket, invocation) = self.runtime.invoke(&session, payload)?;
        let mut lease = InvocationLease {
            runtime: self.runtime.clone(),
            ticket: ticket.clone(),
            app: self.app.clone(),
            db: state.db.clone(),
            completed: false,
        };
        let method = invocation.request["method"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let audit=crate::agent_tools::call_tool_with_audit(&self.app,&state.db,"atools-ui",&session.tool,json!({"operation":"request","sessionId":session.id,"invocationId":ticket,"method":method}),true).await;
        lease.completed = true;
        let result = invocation.result.lock().take();
        self.runtime.finish_invocation(&ticket);
        if audit.is_error {
            return match result {
                Some(Err(error)) => Err(fixed_error(&error)),
                _ => Err("REQUEST_REJECTED".into()),
            };
        }
        match result {
            Some(Ok(value)) => {
                validate_response_size(&value)?;
                Ok(value)
            }
            Some(Err(error)) => Err(fixed_error(&error)),
            None if self.runtime.get(&session.id).is_err()
                || session.document.as_ref().is_some_and(|d| !d.is_active()) =>
            {
                Err("SESSION_UNAVAILABLE".into())
            }
            None => Err("REQUEST_FAILED".into()),
        }
    }
}
fn validate_payload(value: &Value) -> Result<(), String> {
    let o = value.as_object().ok_or("INVALID_REQUEST")?;
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .ok_or("INVALID_REQUEST")?;
    match method {
        "encrypt" if o.len() == 2 && o.contains_key("text") => {
            let t = value["text"].as_str().ok_or("INVALID_REQUEST")?;
            if t.len() > registry::MAX_TEXT_BYTES {
                return Err("INPUT_TOO_LARGE".into());
            }
            Ok(())
        }
        "decrypt" if o.len() == 2 && o.contains_key("data") => {
            let d = value["data"].as_str().ok_or("INVALID_REQUEST")?;
            if d.len() > registry::MAX_WIRE_BYTES {
                return Err("CIPHERTEXT_TOO_LARGE".into());
            }
            Ok(())
        }
        _ => Err("INVALID_REQUEST".into()),
    }
}
pub(super) fn validate_response_size(value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "RESPONSE_INVALID")?;
    if bytes.len() > registry::MAX_WIRE_BYTES - 128 {
        return Err("RESPONSE_TOO_LARGE".into());
    }
    Ok(())
}
fn fixed_error(error: &str) -> String {
    match error {
        "INPUT_TOO_LARGE" => "input_too_large",
        "CIPHERTEXT_TOO_LARGE" => "ciphertext_too_large",
        "INVALID_CIPHERTEXT" => "invalid_ciphertext",
        "UNSUPPORTED_CIPHERTEXT" => "unsupported_format",
        "DECRYPT_FAILED" => "decrypt_failed",
        "ENCRYPT_FAILED" => "encrypt_failed",
        "INVALID_REQUEST" => "invalid_request",
        "SESSION_UNAVAILABLE" => "session_unavailable",
        "RESPONSE_TOO_LARGE" => "response_too_large",
        "KEYCHAIN_UNAVAILABLE" => "keychain_unavailable",
        "CRYPTO_UNAVAILABLE" => "encrypt_failed",
        "INVALID_PLAINTEXT" => "decrypt_failed",
        "PLAINTEXT_TOO_LARGE" => "decrypt_failed",
        _ => "request_rejected",
    }
    .into()
}
#[allow(dead_code)]
fn _opaque_id() -> String {
    credential()
}

#[cfg(test)]
mod tests {
    use super::validate_response_size;
    use crate::plugin_secret_storage_runtime::registry::MAX_TEXT_BYTES;
    use serde_json::json;

    #[test]
    fn escaped_control_text_is_rejected_before_audited_success() {
        let expanded = "\0".repeat(MAX_TEXT_BYTES);
        assert_eq!(
            validate_response_size(&json!({"text": expanded})).unwrap_err(),
            "RESPONSE_TOO_LARGE"
        );
    }
}
