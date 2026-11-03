//! Protocol-level tests for the private Web Storage bridge.

use super::operations;
use atools_core::db::PLUGIN_WEB_STORAGE_MAX_VALUE_BYTES;
use serde_json::Value;

mod tests {
    use super::*;
    use atools_core::{Database, Plugin};
    use base64::Engine;
    use serde_json::json;

    fn setup() -> Database {
        let db = Database::in_memory().unwrap();
        let plugin: Plugin = serde_json::from_value(json!({"id":"web-storage-test","name":"test","version":"1","path":"/tmp/test","enabled":true,"manifest":{"name":"test"},"created_at":"now","updated_at":"now"})).unwrap();
        db.save_plugin(&plugin).unwrap();
        db
    }

    fn request(method: &str, args: Value) -> Value {
        json!({"method":method,"args":args})
    }

    fn b64(units: &[u16]) -> String {
        base64::engine::general_purpose::STANDARD.encode(
            units
                .iter()
                .flat_map(|unit| unit.to_le_bytes())
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn protocol_round_trips_arbitrary_utf16_and_keeps_dbstorage_separate() {
        let db = setup();
        let client = "ab".repeat(16);
        let key = [0xd800, 0x0000];
        let value = [0xdfff, 0x0061];
        let args = json!([client, "https://example.test/path", b64(&key), b64(&value)]);
        let set = super::operations::execute(
            &db,
            "web-storage-test",
            &request("webStorage.setItem", args),
        )
        .unwrap();
        assert_eq!(set["changed"], true);
        assert_eq!(set["key"], b64(&key));
        assert_eq!(set["newValue"], b64(&value));
        assert!(!super::operations::logical_failure(
            "webStorage.setItem",
            &set
        ));

        let get = super::operations::execute(
            &db,
            "web-storage-test",
            &request(
                "webStorage.getItem",
                json!([client, "file:///private.html", b64(&key)]),
            ),
        )
        .unwrap();
        assert_eq!(get, json!(b64(&value)));
        assert_eq!(
            super::operations::execute(
                &db,
                "web-storage-test",
                &request("webStorage.length", json!([client, "opaque://source"])),
            )
            .unwrap(),
            json!(1)
        );
        assert_eq!(
            super::operations::execute(
                &db,
                "web-storage-test",
                &request("webStorage.key", json!([client, "opaque://source", 0])),
            )
            .unwrap(),
            json!(b64(&key))
        );
        assert_eq!(
            super::operations::execute(
                &db,
                "web-storage-test",
                &request("webStorage.keys", json!([client, "opaque://source"])),
            )
            .unwrap(),
            json!([b64(&key)])
        );
        db.plugin_storage_set("web-storage-test", "same-key", &json!("db"))
            .unwrap();
        super::operations::execute(
            &db,
            "web-storage-test",
            &request("webStorage.clear", json!([client, "opaque://source"])),
        )
        .unwrap();
        assert_eq!(
            db.plugin_storage_get("web-storage-test", "same-key")
                .unwrap(),
            json!("db")
        );
    }

    #[test]
    fn malformed_protocol_inputs_become_fixed_logical_errors_without_echoing_data() {
        let db = setup();
        let client = "01".repeat(16);
        let invalid = super::operations::execute(
            &db,
            "web-storage-test",
            &request(
                "webStorage.setItem",
                json!([client, "x".repeat(8193), "bad", "bad-value"]),
            ),
        )
        .unwrap();
        assert_eq!(invalid["error"], true);
        assert_eq!(invalid["name"], "InvalidStateError");
        assert!(!invalid.to_string().contains("bad-value"));
        assert!(super::operations::logical_failure(
            "webStorage.setItem",
            &invalid
        ));

        let noncanonical = super::operations::execute(
            &db,
            "web-storage-test",
            &request("webStorage.getItem", json!([client, "x", "AA"])),
        )
        .unwrap();
        assert_eq!(noncanonical["name"], "InvalidStateError");
        let invalid_client = super::operations::execute(
            &db,
            "web-storage-test",
            &request("webStorage.length", json!(["not-an-id", "x"])),
        )
        .unwrap();
        assert_eq!(invalid_client["name"], "InvalidStateError");
    }

    #[test]
    fn entries_protocol_returns_bounded_offset_pages() {
        let db = setup();
        let client = "12".repeat(16);
        let large_value = vec![0xd800; 50 * 1024];
        for key in [vec![], vec![0xdfff], vec![0x0063]] {
            db.plugin_web_storage_set("web-storage-test", &key, &large_value)
                .unwrap();
        }

        let page = super::operations::execute(
            &db,
            "web-storage-test",
            &request("webStorage.entries", json!([client, "opaque://x", 0])),
        )
        .unwrap();
        assert_eq!(page["entries"].as_array().unwrap().len(), 2);
        assert_eq!(page["entries"][0]["key"], b64(&[]));
        assert_eq!(page["entries"][1]["key"], b64(&[0xdfff]));
        assert_eq!(page["nextOffset"], 2);
        assert!(serde_json::to_vec(&page).unwrap().len() <= 384 * 1024);

        let last = super::operations::execute(
            &db,
            "web-storage-test",
            &request("webStorage.entries", json!([client, "opaque://x", 2])),
        )
        .unwrap();
        assert_eq!(last["entries"].as_array().unwrap().len(), 1);
        assert_eq!(last["entries"][0]["key"], b64(&[0x0063]));
        assert_eq!(last["nextOffset"], Value::Null);

        let invalid = super::operations::execute(
            &db,
            "web-storage-test",
            &request("webStorage.entries", json!([client, "opaque://x", -1])),
        )
        .unwrap();
        assert_eq!(invalid["name"], "InvalidStateError");
    }

    #[test]
    fn core_quota_maps_to_fixed_quota_error_and_invalid_empty_index_is_rejected() {
        let db = setup();
        let client = "ef".repeat(16);
        let too_large = b64(&vec![1; PLUGIN_WEB_STORAGE_MAX_VALUE_BYTES / 2 + 1]);
        let error = super::operations::execute(
            &db,
            "web-storage-test",
            &request("webStorage.setItem", json!([client, "url", "", too_large])),
        )
        .unwrap();
        assert_eq!(error["name"], "QuotaExceededError");
        assert_eq!(error["message"], "Web Storage quota exceeded");
        assert!(!error.to_string().contains("url"));
        assert!(super::operations::logical_failure(
            "webStorage.setItem",
            &error
        ));
        let invalid = super::operations::execute(
            &db,
            "web-storage-test",
            &request("webStorage.key", json!([client, "url", -1])),
        )
        .unwrap();
        assert_eq!(invalid["name"], "InvalidStateError");
    }

    #[test]
    fn literal_local_storage_requests_data_while_session_storage_does_not() {
        let db = Database::in_memory().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let plugin: Plugin = serde_json::from_value(json!({"id":"source-hint","name":"test","version":"1","path":directory.path().to_string_lossy(),"enabled":true,"manifest":{"name":"test"},"created_at":"now","updated_at":"now"})).unwrap();
        db.save_plugin(&plugin).unwrap();
        let hints = super::super::source_hint::Hints::default();
        std::fs::write(
            directory.path().join("index.js"),
            "window.localStorage.getItem('x')",
        )
        .unwrap();
        assert_eq!(
            hints.scan(&plugin, None),
            super::super::source_hint::Usage::Detected
        );
        std::fs::write(
            directory.path().join("index.js"),
            "window.sessionStorage.getItem('x')",
        )
        .unwrap();
        assert_eq!(
            hints.scan(&plugin, None),
            super::super::source_hint::Usage::NotDetected
        );
    }
}
