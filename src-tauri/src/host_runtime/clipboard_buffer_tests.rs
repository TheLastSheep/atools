use super::{
    clipboard::ClipboardAccess,
    clipboard_formats::{MAX_FORMAT_DATA_BYTES, MAX_FORMAT_RESPONSE_BYTES},
    registry::{self, Access},
    request::ClipboardRequest,
    sessions::Sessions,
};
use atools_core::db::Database;
use base64::{engine::general_purpose::STANDARD, Engine};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

struct BinaryClipboard {
    result: Result<Vec<u8>, String>,
    reads: AtomicUsize,
    formats: Mutex<Vec<String>>,
}

impl BinaryClipboard {
    fn with_bytes(bytes: Vec<u8>) -> Self {
        Self {
            result: Ok(bytes),
            reads: AtomicUsize::new(0),
            formats: Mutex::new(Vec::new()),
        }
    }

    fn with_error(message: &str) -> Self {
        Self {
            result: Err(message.to_owned()),
            reads: AtomicUsize::new(0),
            formats: Mutex::new(Vec::new()),
        }
    }
}

impl ClipboardAccess for BinaryClipboard {
    fn read(&self) -> Result<String, String> {
        Ok(String::new())
    }

    fn write(&self, _text: &str) -> Result<(), String> {
        Ok(())
    }

    fn read_format(&self, format: &str) -> Result<Vec<u8>, String> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.formats.lock().push(format.to_owned());
        self.result.clone()
    }
}

fn execute_buffer_request(
    access: Access,
    payload: &Value,
    backend: &BinaryClipboard,
) -> Result<Value, String> {
    ClipboardRequest::parse(access, payload)?.execute(access, backend)
}

fn buffer_payload(format: &str) -> Value {
    json!({ "operation": "readFormatBuffer", "format": format })
}

#[test]
fn read_format_buffer_preserves_nul_and_non_utf8_bytes() {
    let backend = BinaryClipboard::with_bytes(vec![0x00, 0xff, 0x80, 0x41]);
    assert_eq!(
        execute_buffer_request(Access::Read, &buffer_payload("public.tiff"), &backend).unwrap(),
        json!({ "base64": "AP+AQQ==", "byteLength": 4 })
    );
    assert_eq!(backend.reads.load(Ordering::SeqCst), 1);
    assert_eq!(
        backend.formats.lock().as_slice(),
        &[String::from("public.tiff")]
    );
}

#[test]
fn read_format_buffer_returns_empty_bytes_without_inventing_content() {
    let backend = BinaryClipboard::with_bytes(Vec::new());
    assert_eq!(
        execute_buffer_request(Access::Read, &buffer_payload("public.tiff"), &backend).unwrap(),
        json!({ "base64": "", "byteLength": 0 })
    );
    assert_eq!(backend.reads.load(Ordering::SeqCst), 1);
}

#[test]
fn read_format_buffer_accepts_exact_data_limit_and_rejects_overflow() {
    let bytes = vec![0xa5; MAX_FORMAT_DATA_BYTES];
    let backend = BinaryClipboard::with_bytes(bytes.clone());
    let result =
        execute_buffer_request(Access::Read, &buffer_payload("public.tiff"), &backend).unwrap();
    assert_eq!(result["byteLength"], MAX_FORMAT_DATA_BYTES);
    assert_eq!(
        STANDARD.decode(result["base64"].as_str().unwrap()).unwrap(),
        bytes
    );
    let envelope = serde_json::to_vec(&json!({ "ok": true, "result": result })).unwrap();
    assert!(envelope.len() <= MAX_FORMAT_RESPONSE_BYTES);
    assert_eq!(backend.reads.load(Ordering::SeqCst), 1);

    let overflow = BinaryClipboard::with_bytes(vec![0xa5; MAX_FORMAT_DATA_BYTES + 1]);
    assert_eq!(
        execute_buffer_request(Access::Read, &buffer_payload("public.tiff"), &overflow)
            .unwrap_err(),
        "Clipboard format data exceeds 256 KiB"
    );
    assert_eq!(overflow.reads.load(Ordering::SeqCst), 1);
}

#[test]
fn read_format_buffer_propagates_backend_errors_after_one_read() {
    let backend = BinaryClipboard::with_error("native format backend failed");
    assert_eq!(
        execute_buffer_request(Access::Read, &buffer_payload("public.tiff"), &backend).unwrap_err(),
        "native format backend failed"
    );
    assert_eq!(backend.reads.load(Ordering::SeqCst), 1);
}

#[test]
fn read_format_buffer_rejects_invalid_wire_names_and_scopes_without_reading() {
    let backend = BinaryClipboard::with_bytes(vec![1, 2, 3]);
    for payload in [
        json!({ "operation": "readFormatBuffer", "format": "" }),
        json!({ "operation": "readFormatBuffer", "format": "bad\nname" }),
        json!({ "operation": "readFormatBuffer", "format": "表情" }),
        json!({ "operation": "readFormatBuffer", "format": "x".repeat(257) }),
        json!({ "operation": "readFormatBuffer", "format": "public.tiff", "extra": true }),
        json!({ "operation": "readFormat", "format": "public.tiff", "binary": true }),
    ] {
        assert!(ClipboardRequest::parse(Access::Read, &payload).is_err());
    }

    let payload = buffer_payload("public.tiff");
    for access in [
        Access::Write,
        Access::Image,
        Access::ImageWrite,
        Access::ContentWrite,
        Access::Paste,
        Access::HistoryRead,
        Access::HistoryDelete,
    ] {
        assert!(ClipboardRequest::parse(access, &payload).is_err());
    }
    assert!(ClipboardRequest::ReadFormatBuffer("public.tiff".into())
        .execute(Access::Write, &backend)
        .is_err());
    assert_eq!(backend.reads.load(Ordering::SeqCst), 0);
    assert!(backend.formats.lock().is_empty());
}

#[test]
fn revoked_read_session_cannot_read_binary_clipboard_data() {
    let db = Database::in_memory().unwrap();
    let plugin = super::tests::plugin();
    db.save_plugin(&plugin).unwrap();
    let backend = Arc::new(BinaryClipboard::with_bytes(vec![0x00, 0xff]));
    let runtime = Sessions::new(backend.clone());
    let tool = registry::ensure_tool(&db, &plugin, Access::Read).unwrap();
    db.grant_agent_tool("atools-ui", &tool).unwrap();
    let intent = runtime
        .intent(
            "binary-buffer-owner".into(),
            plugin.id.clone(),
            Access::Read,
        )
        .unwrap();
    let session = runtime.open(&intent, &plugin, Access::Read).unwrap();
    let request = ClipboardRequest::parse(Access::Read, &buffer_payload("public.tiff")).unwrap();

    assert_eq!(
        super::execute_sync_request(&db, &session, &request, backend.as_ref()).unwrap(),
        json!({ "base64": "AP8=", "byteLength": 2 })
    );
    db.revoke_agent_tool("atools-ui", &tool).unwrap();
    assert!(super::execute_sync_request(&db, &session, &request, backend.as_ref()).is_err());
    assert_eq!(backend.reads.load(Ordering::SeqCst), 1);
}

#[test]
fn closed_document_read_session_cannot_read_binary_clipboard_data() {
    let db = Database::in_memory().unwrap();
    let plugin = super::tests::plugin();
    db.save_plugin(&plugin).unwrap();
    let backend = Arc::new(BinaryClipboard::with_bytes(vec![0x00, 0xff]));
    let runtime = Sessions::new(backend.clone());
    let tool = registry::ensure_tool(&db, &plugin, Access::Read).unwrap();
    db.grant_agent_tool("atools-ui", &tool).unwrap();
    let (document, active) = crate::plugin_page_runtime::test_binding();
    let intent = runtime
        .intent_with_document(
            "binary-document-owner".into(),
            plugin.id.clone(),
            Access::Read,
            Some(document),
        )
        .unwrap();
    let session = runtime.open(&intent, &plugin, Access::Read).unwrap();
    let request = ClipboardRequest::parse(Access::Read, &buffer_payload("public.tiff")).unwrap();
    active.store(false, Ordering::Release);

    assert!(super::execute_sync_request(&db, &session, &request, backend.as_ref()).is_err());
    assert_eq!(backend.reads.load(Ordering::SeqCst), 0);
}

#[test]
fn binary_format_and_contents_stay_out_of_taskrun_audit_values() {
    let args = super::invocation_audit_args("session-1", "ticket-1");
    assert_eq!(
        args,
        json!({
            "operation": "request",
            "sessionId": "session-1",
            "invocationId": "ticket-1"
        })
    );
    let summary = super::invocation_audit_summary("ticket-1", Access::Read);
    assert_eq!(
        summary,
        json!({
            "invocationId": "ticket-1",
            "access": Access::Read,
            "transportOnly": true,
            "summary": "Native clipboard operation completed; contents are private"
        })
    );
    let audit = format!("{args}{summary}");
    for private_value in ["public.tiff", "AP8=", "byteLength", "clipboard-secret"] {
        assert!(!audit.contains(private_value));
    }
}

#[cfg(target_os = "macos")]
struct NamedBinaryClipboard(String);

#[cfg(target_os = "macos")]
impl ClipboardAccess for NamedBinaryClipboard {
    fn read(&self) -> Result<String, String> {
        Ok(String::new())
    }

    fn write(&self, _text: &str) -> Result<(), String> {
        Ok(())
    }

    fn read_format(&self, format: &str) -> Result<Vec<u8>, String> {
        super::clipboard_formats::mac_read_format(Some(&self.0), format)
    }
}

#[cfg(target_os = "macos")]
struct ClearNamed(String);

#[cfg(target_os = "macos")]
impl Drop for ClearNamed {
    fn drop(&mut self) {
        super::clipboard_formats::mac_clear_named(&self.0);
    }
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "native integration requires the named macOS pasteboard service; run explicitly"]
fn named_pasteboard_buffer_read_preserves_fixed_binary_data() {
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboardItem, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSData, NSString};

    let name = format!("com.atools.clipboard-buffer-test.{}", uuid::Uuid::new_v4());
    let _clear = ClearNamed(name.clone());
    let pasteboard = super::clipboard_formats::native_pasteboard(Some(&name)).unwrap();
    pasteboard.clearContents();

    let format = NSString::from_str("com.atools.test.binary-buffer");
    let expected = [0x00, 0xff, 0x80, 0x54, 0x49, 0x46, 0x46];
    let data = unsafe { NSData::dataWithBytes_length(expected.as_ptr().cast(), expected.len()) };
    let item = NSPasteboardItem::new();
    assert!(item.setData_forType(&data, &format));
    let object: &ProtocolObject<dyn NSPasteboardWriting> = ProtocolObject::from_ref(&*item);
    assert!(pasteboard.writeObjects(&NSArray::from_slice(&[object])));

    let result = super::clipboard_formats::exact_read_format_buffer(
        &NamedBinaryClipboard(name),
        "com.atools.test.binary-buffer",
    )
    .unwrap();
    assert_eq!(
        result,
        json!({
            "base64": "AP+AVElGRg==",
            "byteLength": expected.len()
        })
    );
    let decoded = STANDARD.decode(result["base64"].as_str().unwrap()).unwrap();
    assert_eq!(decoded.as_slice(), &expected);
    drop(_clear);
}
