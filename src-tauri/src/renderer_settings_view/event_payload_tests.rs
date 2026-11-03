use serde_json::json;

use super::{build_event_payload, build_open_receipt};

const ID: &str = "00000000000040008000000000000001";

#[test]
fn open_receipt_has_exactly_the_two_fields_accepted_by_the_main_client() {
    assert_eq!(build_open_receipt(ID), json!({"version":1,"sessionId":ID}));
}

#[test]
fn v1_lifecycle_payload_has_only_contract_fields() {
    let plugin = json!({
        "name":"setting",
        "title":"设置",
        "logo":"data:image/png;base64,AA==",
        "path":"atools:internal/setting",
        "cmdName":"设置",
        "subInputPlaceholder":"搜索",
        "subInputVisible":false,
    });
    for phase in ["placeholder", "loaded", "closed", "back-to-search"] {
        let payload = build_event_payload(ID, phase, None).unwrap();
        assert_eq!(payload, json!({"version":1,"sessionId":ID,"phase":phase}));
    }

    let opened = build_event_payload(ID, "opened", Some(plugin.clone())).unwrap();
    assert_eq!(
        opened,
        json!({"version":1,"sessionId":ID,"phase":"opened","plugin":plugin})
    );
}

#[test]
fn only_opened_may_carry_the_plugin_dto() {
    assert!(build_event_payload(ID, "opened", None).is_err());
    assert!(build_event_payload(ID, "loaded", Some(json!({"name":"setting"}))).is_err());
    assert!(build_event_payload(ID, "unknown", None).is_err());
}
