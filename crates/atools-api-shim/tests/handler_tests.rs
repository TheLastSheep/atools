//! Integration tests for the API handler IPC dispatch.

use atools_api_shim::handler::ApiHandler;
use atools_core::db::Database;
use atools_core::models::{Plugin, PluginManifest};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tempfile::TempDir;

fn setup() -> (ApiHandler, TempDir) {
    let temp_dir = TempDir::new().unwrap();
    let db = Arc::new(Database::in_memory().unwrap());

    // Register test plugin to satisfy foreign key constraints
    let plugin = Plugin {
        id: "test-plugin".to_string(),
        name: "Test Plugin".to_string(),
        version: "1.0.0".to_string(),
        path: "/tmp/test-plugin".to_string(),
        enabled: true,
        manifest: PluginManifest {
            name: "Test Plugin".to_string(),
            version: "1.0.0".to_string(),
            main: None,
            logo: None,
            preload: None,
            description: None,
            author: None,
            homepage: None,
            plugin_setting: None,
            features: vec![],
            development: None,
            tools: HashMap::new(),
            permissions: vec![],
        },
        created_at: "2026-01-01T00:00:00Z".to_string(),
        updated_at: "2026-01-01T00:00:00Z".to_string(),
    };
    db.save_plugin(&plugin).unwrap();

    let handler = ApiHandler::new(db, temp_dir.path().to_path_buf());
    (handler, temp_dir)
}

#[tokio::test]
async fn test_db_put_and_get() {
    let (handler, _temp) = setup();
    let plugin_id = "test-plugin";

    // Put a document
    let doc = json!({"_id": "doc1", "title": "Hello", "count": 42});
    let result = handler
        .handle(plugin_id, "db.put", vec![doc])
        .await
        .unwrap();
    assert_eq!(result["ok"], true);
    assert_eq!(result["id"], "doc1");

    // Get it back
    let result = handler
        .handle(plugin_id, "db.get", vec![json!("doc1")])
        .await
        .unwrap();
    assert_eq!(result["title"], "Hello");
    assert_eq!(result["count"], 42);
}

#[tokio::test]
async fn test_db_get_missing_returns_null() {
    let (handler, _temp) = setup();
    let result = handler
        .handle("test-plugin", "db.get", vec![json!("nonexistent")])
        .await
        .unwrap();
    assert!(result.is_null());
}

#[tokio::test]
async fn test_db_remove() {
    let (handler, _temp) = setup();
    let plugin_id = "test-plugin";

    // Put then remove
    let doc = json!({"_id": "doc1"});
    handler
        .handle(plugin_id, "db.put", vec![doc])
        .await
        .unwrap();
    let result = handler
        .handle(plugin_id, "db.remove", vec![json!("doc1")])
        .await
        .unwrap();
    assert_eq!(result["ok"], true);

    // Verify gone
    let result = handler
        .handle(plugin_id, "db.get", vec![json!("doc1")])
        .await
        .unwrap();
    assert!(result.is_null());
}

#[tokio::test]
async fn test_db_all_docs() {
    let (handler, _temp) = setup();
    let plugin_id = "test-plugin";

    handler
        .handle(plugin_id, "db.put", vec![json!({"_id": "user/a"})])
        .await
        .unwrap();
    handler
        .handle(plugin_id, "db.put", vec![json!({"_id": "user/b"})])
        .await
        .unwrap();
    handler
        .handle(plugin_id, "db.put", vec![json!({"_id": "settings"})])
        .await
        .unwrap();

    let result = handler
        .handle(plugin_id, "db.allDocs", vec![])
        .await
        .unwrap();
    let docs = result.as_array().unwrap();
    assert_eq!(docs.len(), 3);

    let result = handler
        .handle(plugin_id, "db.allDocs", vec![json!("user/")])
        .await
        .unwrap();
    let ids: Vec<&str> = result
        .as_array()
        .unwrap()
        .iter()
        .map(|doc| doc["_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["user/a", "user/b"]);

    let result = handler
        .handle(
            plugin_id,
            "db.allDocs",
            vec![json!(["settings", "missing", "user/a"])],
        )
        .await
        .unwrap();
    let ids: Vec<&str> = result
        .as_array()
        .unwrap()
        .iter()
        .map(|doc| doc["_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["settings", "user/a"]);
}

#[tokio::test]
async fn test_db_bulk_docs() {
    let (handler, _temp) = setup();
    let plugin_id = "test-plugin";

    let docs = json!([
        {"_id": "bulk1", "val": 1},
        {"_id": "bulk2", "val": 2},
    ]);
    let result = handler
        .handle(plugin_id, "db.bulkDocs", vec![docs])
        .await
        .unwrap();
    assert_eq!(result["ok"], true);

    // Verify both exist
    let all = handler
        .handle(plugin_id, "db.allDocs", vec![])
        .await
        .unwrap();
    assert_eq!(all.as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn test_storage_set_get_remove() {
    let (handler, _temp) = setup();
    let plugin_id = "test-plugin";

    // Set
    let result = handler
        .handle(
            plugin_id,
            "storage.set",
            vec![json!("key1"), json!("value1")],
        )
        .await
        .unwrap();
    assert_eq!(result, true);

    // Get
    let result = handler
        .handle(plugin_id, "storage.get", vec![json!("key1")])
        .await
        .unwrap();
    assert_eq!(result, "value1");

    // Remove
    let result = handler
        .handle(plugin_id, "storage.remove", vec![json!("key1")])
        .await
        .unwrap();
    assert_eq!(result, true);

    // Verify gone
    let result = handler
        .handle(plugin_id, "storage.get", vec![json!("key1")])
        .await
        .unwrap();
    assert!(result.is_null());
}

#[tokio::test]
async fn test_storage_isolation_between_plugins() {
    let (handler, _temp) = setup();

    handler
        .handle(
            "plugin-a",
            "storage.set",
            vec![json!("key"), json!("a-value")],
        )
        .await
        .unwrap();
    handler
        .handle(
            "plugin-b",
            "storage.set",
            vec![json!("key"), json!("b-value")],
        )
        .await
        .unwrap();

    let a = handler
        .handle("plugin-a", "storage.get", vec![json!("key")])
        .await
        .unwrap();
    let b = handler
        .handle("plugin-b", "storage.get", vec![json!("key")])
        .await
        .unwrap();

    assert_eq!(a, "a-value");
    assert_eq!(b, "b-value");
}

#[tokio::test]
async fn test_system_methods_return_expected() {
    let (handler, _temp) = setup();

    let result = handler
        .handle("test", "system.isMacOS", vec![])
        .await
        .unwrap();
    assert_eq!(result, true);

    let result = handler
        .handle("test", "system.isWindows", vec![])
        .await
        .unwrap();
    assert_eq!(result, false);

    let result = handler
        .handle("test", "system.isLinux", vec![])
        .await
        .unwrap();
    assert_eq!(result, false);

    let result = handler
        .handle("test", "system.getFileIcon", vec![json!(".txt")])
        .await
        .unwrap();
    assert!(result
        .as_str()
        .unwrap()
        .starts_with("data:image/svg+xml;base64,"));

    let result = handler
        .handle("test", "system.nativeId", vec![])
        .await
        .unwrap();
    assert_eq!(result, "test");

    // Delegated methods return null
    let result = handler
        .handle("test", "system.notify", vec![])
        .await
        .unwrap();
    assert!(result.is_null());
}

#[tokio::test]
async fn test_delegated_methods_return_null() {
    let (handler, _temp) = setup();

    let delegated = vec![
        "window.show",
        "window.hide",
        "shell.openPath",
        "clipboard.copyText",
        "input.setSubInput",
        "plugin.out",
    ];

    for method in delegated {
        let result = handler.handle("test", method, vec![]).await.unwrap();
        assert!(result.is_null(), "{} should return null", method);
    }
}

#[tokio::test]
async fn test_unknown_method_returns_null() {
    let (handler, _temp) = setup();
    let result = handler.handle("test", "nonexistent.method", vec![]).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_native_bridge_methods_error_when_not_handled_by_native_layer() {
    let (handler, _temp) = setup();

    let methods = vec![
        "clipboard.copyImage",
        "clipboard.copyFile",
        "clipboard.getCopyedFiles",
        "shell.trashItem",
        "shell.beep",
        "dialog.open",
        "dialog.save",
        "input.pasteText",
        "input.pasteImage",
        "input.pasteFile",
        "input.typeString",
        "app.redirect",
        "settings.redirectHotKey",
        "settings.redirectAiModels",
        "window.startDrag",
        "window.createBrowserWindow",
        "window.sendToParent",
        "screen.capture",
        "screen.colorPick",
        "screen.desktopCaptureSources",
    ];

    for method in methods {
        let err = handler.handle("test", method, vec![]).await.unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("requires native Tauri bridge"),
            "{} should explain native handling requirement, got {}",
            method,
            msg
        );
    }
}

#[tokio::test]
async fn test_user_methods_return_local_only_results() {
    let (handler, _temp) = setup();

    let user = handler.handle("test", "user.get", vec![]).await.unwrap();
    assert!(
        user.is_null(),
        "local-only API shim should report no logged-in uTools user"
    );

    let err = handler
        .handle("test", "user.fetchServerTemporaryToken", vec![])
        .await
        .unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("requires native Tauri bridge"),
        "temporary token should explain native handling requirement, got {}",
        msg
    );
}

#[tokio::test]
async fn test_window_theme_probe_returns_boolean() {
    let (handler, _temp) = setup();

    let result = handler
        .handle("test", "window.isDarkColors", vec![])
        .await
        .unwrap();
    assert_eq!(
        result, false,
        "local-only API shim should provide a stable light-theme boolean fallback"
    );
}

#[tokio::test]
async fn test_unknown_method_errors_instead_of_returning_null() {
    let (handler, _temp) = setup();

    let err = handler
        .handle("test", "nonexistent.method", vec![])
        .await
        .unwrap_err();

    assert!(err.to_string().contains("Unsupported IPC method"));
}

#[tokio::test]
async fn test_db_attachment_round_trips_base64_data() {
    let (handler, _temp) = setup();
    let plugin_id = "test-plugin";

    handler
        .handle(
            plugin_id,
            "db.put",
            vec![json!({"_id": "doc-with-attachment"})],
        )
        .await
        .unwrap();

    let result = handler
        .handle(
            plugin_id,
            "db.putAttachment",
            vec![
                json!("doc-with-attachment"),
                json!("file.bin"),
                json!(null),
                json!("aGVsbG8Ad29ybGQ="),
                json!("application/octet-stream"),
            ],
        )
        .await
        .unwrap();
    assert_eq!(result["ok"], true);

    let result = handler
        .handle(
            plugin_id,
            "db.getAttachment",
            vec![json!("doc-with-attachment"), json!("file.bin")],
        )
        .await
        .unwrap();

    assert_eq!(result, "aGVsbG8Ad29ybGQ=");
}

#[tokio::test]
async fn test_db_put_missing_arg_errors() {
    let (handler, _temp) = setup();
    let result = handler.handle("test", "db.put", vec![]).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_db_get_missing_arg_errors() {
    let (handler, _temp) = setup();
    let result = handler.handle("test", "db.get", vec![]).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_system_get_path() {
    let (handler, _temp) = setup();

    let result = handler
        .handle("test", "system.getPath", vec![json!("home")])
        .await
        .unwrap();
    assert!(!result.as_str().unwrap().is_empty());

    let result = handler
        .handle("test", "system.getPath", vec![json!("temp")])
        .await
        .unwrap();
    assert!(!result.as_str().unwrap().is_empty());
}

#[tokio::test]
async fn test_plugin_get_path() {
    let (handler, _temp) = setup();
    let result = handler
        .handle("my-plugin", "plugin.getPath", vec![])
        .await
        .unwrap();
    let path = result.as_str().unwrap();
    assert!(path.ends_with("my-plugin"));
}
