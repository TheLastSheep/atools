use super::{registry::Access, request::ClipboardRequest};
use serde_json::json;

#[test]
fn history_read_and_delete_use_separate_accesses() {
    let list = ClipboardRequest::parse(
        Access::HistoryRead,
        &json!({"operation":"list","page":1,"pageSize":1000,"query":"hello"}),
    )
    .unwrap();
    assert!(matches!(
        list,
        ClipboardRequest::HistoryPage {
            page: 1,
            page_size: 1000,
            ..
        }
    ));
    assert!(ClipboardRequest::parse(
        Access::HistoryRead,
        &json!({"operation":"list","page":10001,"pageSize":1000}),
    )
    .is_ok());
    let id = "clip-0123456789abcdef";
    assert!(matches!(
        ClipboardRequest::parse(
            Access::HistoryRead,
            &json!({"operation":"getContent","id":id})
        ),
        Ok(ClipboardRequest::HistoryText { .. })
    ));
    for media_id in ["clip-image-0123456789abcdef", "clip-file-0123456789abcdef"] {
        assert!(ClipboardRequest::parse(
            Access::HistoryRead,
            &json!({"operation":"getContent","id":media_id}),
        )
        .is_ok());
        assert!(ClipboardRequest::parse(
            Access::HistoryDelete,
            &json!({"operation":"delete","id":media_id}),
        )
        .is_ok());
    }
    assert!(matches!(
        ClipboardRequest::parse(
            Access::HistoryDelete,
            &json!({"operation":"delete","id":id})
        ),
        Ok(ClipboardRequest::HistoryDelete { .. })
    ));
    assert!(matches!(
        ClipboardRequest::parse(Access::HistoryDelete, &json!({"operation":"clear"})),
        Ok(ClipboardRequest::HistoryClear { kind: None })
    ));
    assert!(ClipboardRequest::parse(
        Access::HistoryDelete,
        &json!({"operation":"list","page":1,"pageSize":10})
    )
    .is_err());
    assert!(ClipboardRequest::parse(Access::HistoryRead, &json!({"operation":"clear"})).is_err());
}

#[test]
fn history_inputs_are_bounded_and_ids_are_exact() {
    for payload in [
        json!({"operation":"list","page":0,"pageSize":10}),
        json!({"operation":"list","page":1,"pageSize":1001}),
        json!({"operation":"list","page":10002,"pageSize":1000}),
        json!({"operation":"list","page":1,"pageSize":10,"query":"x".repeat(257)}),
        json!({"operation":"list","page":1,"pageSize":10,"query":"界".repeat(86)}),
        json!({"operation":"list","page":1,"pageSize":10,"extra":true}),
        json!({"operation":"paste","type":"text","content":"no"}),
    ] {
        assert!(ClipboardRequest::parse(Access::HistoryRead, &payload).is_err());
    }
    for id in ["clip-1", "clip-0123456789abcdeG", "other-0123456789abcdef"] {
        assert!(ClipboardRequest::parse(
            Access::HistoryDelete,
            &json!({"operation":"delete","id":id})
        )
        .is_err());
    }
    assert!(ClipboardRequest::parse(
        Access::HistoryRead,
        &json!({"operation":"getContent","id":"clip-0123456789abcdef","extra":true})
    )
    .is_err());
}

#[test]
fn clipboard_clear_selects_text_image_file_or_all() {
    for (payload, expected_kind) in [
        (json!({"operation":"clear"}), None),
        (json!({"operation":"clear","type":"all"}), None),
        (json!({"operation":"clear","type":"text"}), Some("text")),
        (json!({"operation":"clear","type":"image"}), Some("image")),
        (json!({"operation":"clear","type":"file"}), Some("file")),
    ] {
        let request = ClipboardRequest::parse(Access::HistoryDelete, &payload).unwrap();
        assert!(
            matches!(request, ClipboardRequest::HistoryClear { kind } if kind.as_deref() == expected_kind)
        );
    }
    for payload in [
        json!({"operation":"clear","type":"other"}),
        json!({"operation":"clear","type":1}),
        json!({"operation":"clear","type":"image","extra":true}),
    ] {
        assert!(ClipboardRequest::parse(Access::HistoryDelete, &payload).is_err());
    }
}
