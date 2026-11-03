use super::{
    clipboard::ClipboardAccess,
    clipboard_formats::{
        exact_has_format, exact_read_format, MAX_FORMAT_DATA_BYTES, MAX_FORMAT_NAME_BYTES,
    },
    registry::Access,
    request::ClipboardRequest,
};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Default)]
struct FormatClipboard {
    formats: Mutex<BTreeMap<String, Vec<u8>>>,
    calls: Mutex<Vec<&'static str>>,
}

impl ClipboardAccess for FormatClipboard {
    fn read(&self) -> Result<String, String> {
        Ok(String::new())
    }

    fn write(&self, _text: &str) -> Result<(), String> {
        Ok(())
    }

    fn has_format(&self, format: &str) -> Result<bool, String> {
        self.calls.lock().push("has");
        Ok(self.formats.lock().contains_key(format))
    }

    fn read_format(&self, format: &str) -> Result<Vec<u8>, String> {
        self.calls.lock().push("read");
        Ok(self.formats.lock().get(format).cloned().unwrap_or_default())
    }
}

fn execute(access: Access, payload: Value, backend: &dyn ClipboardAccess) -> Result<Value, String> {
    ClipboardRequest::parse(access, &payload)?.execute(access, backend)
}

#[test]
fn read_scope_keeps_legacy_shapes_and_parses_exact_format_requests() {
    assert!(matches!(
        ClipboardRequest::parse(Access::Read, &json!({})),
        Ok(ClipboardRequest::ReadText)
    ));
    assert!(matches!(
        ClipboardRequest::parse(Access::Read, &json!({ "format": "files" })),
        Ok(ClipboardRequest::ReadFiles)
    ));
    assert!(matches!(
        ClipboardRequest::parse(
            Access::Read,
            &json!({ "operation": "hasFormat", "format": "public.file-url" })
        ),
        Ok(ClipboardRequest::HasFormat(format)) if format == "public.file-url"
    ));
    assert!(matches!(
        ClipboardRequest::parse(
            Access::Read,
            &json!({ "operation": "readFormat", "format": "com.example.custom" })
        ),
        Ok(ClipboardRequest::ReadFormat(format)) if format == "com.example.custom"
    ));
    assert!(matches!(
        ClipboardRequest::parse(
            Access::Read,
            &json!({ "operation": "hasFormat", "format": " Custom Platform Type " })
        ),
        Ok(ClipboardRequest::HasFormat(format)) if format == " Custom Platform Type "
    ));
    assert!(matches!(
        ClipboardRequest::parse(
            Access::Read,
            &json!({ "operation": "hasFormat", "format": "x".repeat(MAX_FORMAT_NAME_BYTES) })
        ),
        Ok(ClipboardRequest::HasFormat(format)) if format.len() == MAX_FORMAT_NAME_BYTES
    ));
}

#[test]
fn format_requests_reject_wrong_scope_unknown_fields_and_invalid_names() {
    let valid = json!({ "operation": "hasFormat", "format": "public.file-url" });
    for access in [
        Access::Write,
        Access::Image,
        Access::ImageWrite,
        Access::ContentWrite,
        Access::Paste,
        Access::HistoryRead,
        Access::HistoryDelete,
    ] {
        assert!(ClipboardRequest::parse(access, &valid).is_err());
    }
    for invalid in [
        json!({ "operation": "hasFormat", "format": "public.file-url", "extra": true }),
        json!({ "operation": "hasFormat", "format": "public.file-url", "type": "clipboard" }),
        json!({ "operation": "hasFormat" }),
        json!({ "operation": "readFormat", "format": 4 }),
        json!({ "operation": "unknown", "format": "public.file-url" }),
        json!({ "operation": "hasFormat", "format": "" }),
        json!({ "operation": "hasFormat", "format": "bad\nname" }),
        json!({ "operation": "hasFormat", "format": "bad\u{007f}name" }),
        json!({ "operation": "hasFormat", "format": "表情🧰" }),
        json!({ "operation": "hasFormat", "format": "x".repeat(257) }),
        json!({ "operation": "hasFormat", "format": "\u{0000}" }),
    ] {
        assert!(ClipboardRequest::parse(Access::Read, &invalid).is_err());
    }
    assert!(ClipboardRequest::parse(Access::Read, &json!({ "format": "image" })).is_err());
}

#[test]
fn metadata_query_is_exact_and_read_returns_utf8_or_lossy_text() {
    let backend = FormatClipboard::default();
    backend
        .formats
        .lock()
        .insert("public.file-url".into(), b"file:///tmp/fixture".to_vec());
    backend
        .formats
        .lock()
        .insert("com.example.utf8".into(), "格式 🧰".as_bytes().to_vec());
    backend
        .formats
        .lock()
        .insert("com.example.invalid".into(), vec![0xff, b'a']);

    assert_eq!(
        execute(
            Access::Read,
            json!({ "operation": "hasFormat", "format": "public.file-url" }),
            &backend
        )
        .unwrap(),
        Value::Bool(true)
    );
    assert_eq!(*backend.calls.lock(), ["has"]);
    assert_eq!(
        execute(
            Access::Read,
            json!({ "operation": "hasFormat", "format": "public.missing" }),
            &backend
        )
        .unwrap(),
        Value::Bool(false)
    );
    assert_eq!(
        execute(
            Access::Read,
            json!({ "operation": "readFormat", "format": "com.example.utf8" }),
            &backend
        )
        .unwrap(),
        Value::String("格式 🧰".into())
    );
    assert_eq!(
        execute(
            Access::Read,
            json!({ "operation": "readFormat", "format": "com.example.invalid" }),
            &backend
        )
        .unwrap(),
        Value::String("�a".into())
    );
    assert_eq!(
        execute(
            Access::Read,
            json!({ "operation": "readFormat", "format": "public.missing" }),
            &backend
        )
        .unwrap(),
        Value::String(String::new())
    );
}

#[test]
fn read_enforces_raw_and_actual_json_envelope_budgets_without_truncating() {
    let backend = FormatClipboard::default();
    backend.formats.lock().insert(
        "com.example.raw-overflow".into(),
        vec![b'a'; MAX_FORMAT_DATA_BYTES + 1],
    );
    backend
        .formats
        .lock()
        .insert("com.example.utf8-expansion".into(), vec![0xff; 180 * 1024]);
    backend.formats.lock().insert(
        "com.example.json-escaping".into(),
        vec![b'"'; MAX_FORMAT_DATA_BYTES],
    );

    for format in [
        "com.example.raw-overflow",
        "com.example.utf8-expansion",
        "com.example.json-escaping",
    ] {
        assert!(exact_read_format(&backend, format).is_err(), "{format}");
    }
}

#[test]
fn format_and_contents_are_not_recorded_in_taskrun_audit_arguments() {
    let args = super::invocation_audit_args("session-1", "ticket-1");
    assert_eq!(
        args,
        json!({
            "operation": "request",
            "sessionId": "session-1",
            "invocationId": "ticket-1"
        })
    );
    let audit = args.to_string();
    assert!(!audit.contains("public.file-url"));
    assert!(!audit.contains("clipboard-secret-fixture"));
}

#[test]
fn unsupported_backend_defaults_return_explicit_errors() {
    struct Unsupported;
    impl ClipboardAccess for Unsupported {
        fn read(&self) -> Result<String, String> {
            Ok(String::new())
        }
        fn write(&self, _text: &str) -> Result<(), String> {
            Ok(())
        }
    }
    let backend = Unsupported;
    assert!(backend.has_format("public.file-url").is_err());
    assert!(backend.read_format("public.file-url").is_err());
}

#[cfg(target_os = "macos")]
struct NamedClipboard(String);

#[cfg(target_os = "macos")]
impl ClipboardAccess for NamedClipboard {
    fn read(&self) -> Result<String, String> {
        Ok(String::new())
    }
    fn write(&self, _text: &str) -> Result<(), String> {
        Ok(())
    }
    fn has_format(&self, format: &str) -> Result<bool, String> {
        super::clipboard_formats::mac_has_format(Some(&self.0), format)
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
#[ignore = "native integration requires the macOS pasteboard service; run explicitly"]
fn named_pasteboard_reads_exact_metadata_and_format_bytes() {
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboardItem, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSData, NSString};

    let name = format!("com.atools.clipboard-format-test.{}", uuid::Uuid::new_v4());
    let _clear = ClearNamed(name.clone());
    let pasteboard = super::clipboard_formats::native_pasteboard(Some(&name)).unwrap();
    pasteboard.clearContents();

    let file_format = NSString::from_str("public.file-url");
    let custom_format = NSString::from_str("com.atools.test.custom-utf8");
    let file_url = b"file:///tmp/atools-format-fixture";
    let custom_bytes = "named native UTF-8 🧰".as_bytes();
    let file_data =
        unsafe { NSData::dataWithBytes_length(file_url.as_ptr().cast(), file_url.len()) };
    let custom_data =
        unsafe { NSData::dataWithBytes_length(custom_bytes.as_ptr().cast(), custom_bytes.len()) };
    let item = NSPasteboardItem::new();
    assert!(item.setData_forType(&file_data, &file_format));
    assert!(item.setData_forType(&custom_data, &custom_format));
    let object: &ProtocolObject<dyn NSPasteboardWriting> = ProtocolObject::from_ref(&*item);
    assert!(pasteboard.writeObjects(&NSArray::from_slice(&[object])));

    let backend = NamedClipboard(name.clone());
    assert_eq!(
        exact_has_format(&backend, "public.file-url").unwrap(),
        Value::Bool(true)
    );
    assert_eq!(
        exact_read_format(&backend, "public.file-url").unwrap(),
        Value::String(String::from_utf8_lossy(file_url).into_owned())
    );
    assert_eq!(
        exact_read_format(&backend, "com.atools.test.custom-utf8").unwrap(),
        Value::String("named native UTF-8 🧰".into())
    );
    assert_eq!(
        exact_has_format(&backend, "com.atools.missing").unwrap(),
        Value::Bool(false)
    );
    assert_eq!(
        exact_read_format(&backend, "com.atools.missing").unwrap(),
        Value::String(String::new())
    );

    super::clipboard_formats::mac_clear_named(&name);
    assert_eq!(
        exact_has_format(&backend, "public.file-url").unwrap(),
        Value::Bool(false)
    );
    drop(_clear);
}
