use parking_lot::Mutex;
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tauri::{Webview, Wry};
use tokio::sync::oneshot;

const MAX_REPLY_BYTES: usize = 64 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(2);
const SNAPSHOT_SCRIPT: &str = r#"(()=>{try{return window.__ATOOLS_RENDERER_LAUNCH_RETURN__?.snapshot?.()??null}catch(_){return null}})()"#;

pub(super) async fn read(webview: Webview<Wry>) -> Option<Value> {
    let (sender, receiver) = oneshot::channel();
    let pending = Arc::new(Mutex::new(Some(sender)));
    let callback_pending = Arc::clone(&pending);
    let callback = move |reply: String| {
        let bounded = if reply.len() <= MAX_REPLY_BYTES {
            Ok(reply)
        } else {
            Err(())
        };
        let sender = callback_pending.lock().take();
        if let Some(sender) = sender {
            let _ = sender.send(bounded);
        }
    };

    if webview
        .eval_with_callback(SNAPSHOT_SCRIPT, callback)
        .is_err()
    {
        pending.lock().take();
        return None;
    }
    drop(webview);

    let reply = match tokio::time::timeout(READ_TIMEOUT, receiver).await {
        Ok(Ok(Ok(reply))) => reply,
        _ => {
            pending.lock().take();
            return None;
        }
    };
    parse_raw(&reply)
}

fn parse_raw(reply: &str) -> Option<Value> {
    if reply.len() > MAX_REPLY_BYTES {
        return None;
    }
    let value: Value = serde_json::from_str(reply).ok()?;
    (!value.is_null()).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::{parse_raw, MAX_REPLY_BYTES};
    use serde_json::json;

    #[test]
    fn parses_bounded_json_and_rejects_invalid_or_oversized_replies() {
        let valid = r#"{"value":1}"#;
        assert_eq!(parse_raw(valid), Some(json!({ "value": 1 })));
        let at_limit = format!("{valid}{}", " ".repeat(MAX_REPLY_BYTES - valid.len()));
        assert_eq!(at_limit.len(), MAX_REPLY_BYTES);
        assert!(parse_raw(&at_limit).is_some());
        assert!(parse_raw("not-json").is_none());
        assert!(parse_raw(&format!("{at_limit} ")).is_none());
    }

    #[test]
    fn preserves_non_null_json_shapes_and_rejects_json_null() {
        assert_eq!(parse_raw("null"), None);
        assert_eq!(
            parse_raw(r#""encoded snapshot""#),
            Some(json!("encoded snapshot"))
        );
        assert_eq!(parse_raw("[1,2]"), Some(json!([1, 2])));
        assert_eq!(
            parse_raw(r#"{"unexpected":true}"#),
            Some(json!({ "unexpected": true }))
        );
    }
}
