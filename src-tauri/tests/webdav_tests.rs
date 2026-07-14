use atools_lib::webdav::{
    build_webdav_files, webdav_directory_urls, webdav_file_url, WebdavScopeSelection,
    WebdavSyncConfig, WebdavSyncSnapshot,
};

#[test]
fn webdav_urls_append_remote_path_and_encode_segments() {
    let base = "https://dav.example.com/remote.php/dav/files/me/";

    let dirs = webdav_directory_urls(base, "/ATools Sync/backups").unwrap();
    assert_eq!(
        dirs,
        vec![
            "https://dav.example.com/remote.php/dav/files/me/ATools%20Sync",
            "https://dav.example.com/remote.php/dav/files/me/ATools%20Sync/backups",
        ]
    );

    let file = webdav_file_url(base, "/ATools Sync/backups", "settings.json").unwrap();
    assert_eq!(
        file,
        "https://dav.example.com/remote.php/dav/files/me/ATools%20Sync/backups/settings.json"
    );
}

#[test]
fn webdav_export_files_redact_local_secrets_and_respect_scopes() {
    let files = build_webdav_files(WebdavSyncSnapshot {
        settings: serde_json::json!({
            "hotkey": "Option+Z",
            "aiApiKey": "sk-local-secret",
            "webdavPassword": "dav-password",
            "webdavUsername": "harris"
        }),
        plugin_data: serde_json::json!({
            "plugins": [{ "id": "demo", "documents": [{ "_id": "one" }] }]
        }),
        clipboard_history: serde_json::json!({
            "entries": [{ "text": "copied api key" }]
        }),
        scopes: WebdavScopeSelection {
            settings: true,
            plugins: false,
            clipboard: true,
        },
    })
    .unwrap();

    let names = files
        .iter()
        .map(|file| file.name.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        vec!["manifest.json", "settings.json", "clipboard-history.json"]
    );

    let settings = files
        .iter()
        .find(|file| file.name == "settings.json")
        .expect("settings file");
    let settings_payload: serde_json::Value = serde_json::from_slice(&settings.bytes).unwrap();
    assert_eq!(settings_payload["aiApiKey"], "<redacted>");
    assert_eq!(settings_payload["webdavPassword"], "<redacted>");
    assert_eq!(settings_payload["webdavUsername"], "harris");
}

#[tokio::test]
async fn webdav_sync_creates_remote_directory_uploads_files_and_verifies_manifest() {
    use atools_lib::webdav::sync_webdav_snapshot;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[derive(Clone, Debug)]
    struct RecordedRequest {
        method: String,
        path: String,
        authorization: String,
        body: String,
    }

    let requests: Arc<Mutex<Vec<RecordedRequest>>> = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}/dav/", listener.local_addr().unwrap());
    let server_requests = requests.clone();

    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let requests = server_requests.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0; 64 * 1024];
                let bytes_read = socket.read(&mut buffer).await.unwrap();
                let request = String::from_utf8_lossy(&buffer[..bytes_read]).to_string();
                let mut lines = request.lines();
                let start = lines.next().unwrap_or_default();
                let mut start_parts = start.split_whitespace();
                let method = start_parts.next().unwrap_or_default().to_string();
                let path = start_parts.next().unwrap_or_default().to_string();
                let authorization = request
                    .lines()
                    .find_map(|line| {
                        line.split_once(": ").and_then(|(name, value)| {
                            name.eq_ignore_ascii_case("authorization").then_some(value)
                        })
                    })
                    .unwrap_or_default()
                    .to_string();
                let body = request
                    .split("\r\n\r\n")
                    .nth(1)
                    .unwrap_or_default()
                    .to_string();
                requests.lock().unwrap().push(RecordedRequest {
                    method: method.clone(),
                    path,
                    authorization,
                    body,
                });

                let response_body = if method == "GET" {
                    r#"{"version":1,"kind":"manifest"}"#
                } else {
                    ""
                };
                let status = if method == "GET" {
                    "200 OK"
                } else {
                    "201 Created"
                };
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                            response_body.len(),
                            response_body
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            });
        }
    });

    let summary = sync_webdav_snapshot(
        WebdavSyncConfig {
            url: base_url,
            username: "harris".to_string(),
            password: "secret".to_string(),
            remote_path: "/ATools/test".to_string(),
            proxy_url: None,
        },
        WebdavSyncSnapshot {
            settings: serde_json::json!({ "hotkey": "Option+Z" }),
            plugin_data: serde_json::json!({ "plugins": [] }),
            clipboard_history: serde_json::json!({ "entries": [] }),
            scopes: WebdavScopeSelection {
                settings: true,
                plugins: true,
                clipboard: false,
            },
        },
    )
    .await
    .unwrap();

    assert_eq!(summary.status, "ok");
    assert_eq!(summary.files_uploaded.len(), 3);
    assert!(summary.remote_manifest_verified);

    let requests = requests.lock().unwrap().clone();
    assert!(requests
        .iter()
        .any(|req| req.method == "MKCOL" && req.path.ends_with("/ATools")));
    assert!(requests
        .iter()
        .any(|req| req.method == "MKCOL" && req.path.ends_with("/ATools/test")));
    assert!(requests
        .iter()
        .any(|req| req.method == "PUT" && req.path.ends_with("/manifest.json")));
    assert!(requests
        .iter()
        .any(|req| req.method == "PUT" && req.path.ends_with("/settings.json")));
    assert!(requests
        .iter()
        .any(|req| req.method == "PUT" && req.path.ends_with("/plugin-data.json")));
    assert!(requests
        .iter()
        .any(|req| req.method == "GET" && req.path.ends_with("/manifest.json")));
    assert!(requests
        .iter()
        .filter(|req| req.method == "PUT")
        .all(|req| req.authorization.starts_with("Basic ")));
    assert!(requests
        .iter()
        .find(|req| req.method == "PUT" && req.path.ends_with("/settings.json"))
        .unwrap()
        .body
        .contains("Option+Z"));
}

#[tokio::test]
async fn webdav_preview_downloads_remote_manifest_and_selected_files_without_writing() {
    use atools_lib::webdav::preview_webdav_backup;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let requests: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}/dav/", listener.local_addr().unwrap());
    let server_requests = requests.clone();

    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let requests = server_requests.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0; 64 * 1024];
                let bytes_read = socket.read(&mut buffer).await.unwrap();
                let request = String::from_utf8_lossy(&buffer[..bytes_read]).to_string();
                let start = request.lines().next().unwrap_or_default().to_string();
                let path = start
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or_default()
                    .to_string();
                requests.lock().unwrap().push(start);

                let body = if path.ends_with("/manifest.json") {
                    r#"{
                      "version": 1,
                      "kind": "atools-webdav-sync",
                      "exportedAt": "2026-06-02T18:00:00Z",
                      "files": [
                        { "name": "settings.json", "bytes": 42 },
                        { "name": "plugin-data.json", "bytes": 88 }
                      ]
                    }"#
                } else if path.ends_with("/settings.json") {
                    r#"{"hotkey":"Option+Z","webdavPassword":"<redacted>"}"#
                } else if path.ends_with("/plugin-data.json") {
                    r#"{"plugins":[{"id":"demo","documentCount":1}]}"#
                } else {
                    "{}"
                };

                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                            body.len(),
                            body
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            });
        }
    });

    let preview = preview_webdav_backup(WebdavSyncConfig {
        url: base_url,
        username: "harris".to_string(),
        password: "secret".to_string(),
        remote_path: "/ATools/test".to_string(),
        proxy_url: None,
    })
    .await
    .unwrap();

    assert_eq!(preview.status, "ok");
    assert_eq!(preview.remote_path, "/ATools/test");
    assert_eq!(preview.manifest_kind.as_deref(), Some("atools-webdav-sync"));
    assert_eq!(preview.exported_at.as_deref(), Some("2026-06-02T18:00:00Z"));
    assert_eq!(preview.files.len(), 2);
    assert_eq!(preview.files[0].name, "settings.json");
    assert_eq!(preview.files[0].declared_bytes, Some(42));
    assert_eq!(preview.files[0].downloaded_bytes, 51);
    assert_eq!(preview.files[0].summary, "设置备份 · 2 项");
    assert_eq!(preview.files[1].name, "plugin-data.json");
    assert_eq!(preview.files[1].summary, "插件数据 · 1 个插件");
    assert!(preview.duration_ms < 30_000);

    let requests = requests.lock().unwrap().clone();
    assert!(requests.iter().all(|start| start.starts_with("GET ")));
    assert!(requests
        .iter()
        .any(|start| start.contains("/manifest.json")));
    assert!(requests
        .iter()
        .any(|start| start.contains("/settings.json")));
    assert!(requests
        .iter()
        .any(|start| start.contains("/plugin-data.json")));
}

#[tokio::test]
async fn webdav_restore_plan_compares_remote_backup_with_local_snapshot_without_writing() {
    use atools_lib::webdav::{plan_webdav_restore, WebdavRestoreLocalSnapshot};
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let requests: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}/dav/", listener.local_addr().unwrap());
    let server_requests = requests.clone();

    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let requests = server_requests.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0; 64 * 1024];
                let bytes_read = socket.read(&mut buffer).await.unwrap();
                let request = String::from_utf8_lossy(&buffer[..bytes_read]).to_string();
                let start = request.lines().next().unwrap_or_default().to_string();
                let path = start
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or_default()
                    .to_string();
                requests.lock().unwrap().push(start);

                let body = if path.ends_with("/manifest.json") {
                    r#"{
                      "version": 1,
                      "kind": "atools-webdav-sync",
                      "exportedAt": "2026-06-02T18:30:00Z",
                      "files": [
                        { "name": "settings.json", "bytes": 100 },
                        { "name": "plugin-data.json", "bytes": 120 },
                        { "name": "clipboard-history.json", "bytes": 80 }
                      ]
                    }"#
                } else if path.ends_with("/settings.json") {
                    r#"{"hotkey":"Command+Space","theme":"system","webdavPassword":"<redacted>"}"#
                } else if path.ends_with("/plugin-data.json") {
                    r#"{"plugins":[{"id":"demo","documentCount":2}]}"#
                } else if path.ends_with("/clipboard-history.json") {
                    r#"{"entries":[{"text":"remote note"},{"text":"second"}]}"#
                } else {
                    "{}"
                };

                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                            body.len(),
                            body
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            });
        }
    });

    let plan = plan_webdav_restore(
        WebdavSyncConfig {
            url: base_url,
            username: "harris".to_string(),
            password: "secret".to_string(),
            remote_path: "/ATools/test".to_string(),
            proxy_url: None,
        },
        WebdavRestoreLocalSnapshot {
            settings: serde_json::json!({
                "hotkey": "Option+Z",
                "theme": "system",
                "webdavPassword": "local-secret"
            }),
            plugin_data: serde_json::json!({
                "plugins": [{"id":"demo","documentCount":1}]
            }),
            clipboard_history: serde_json::json!({
                "entries": [{"text":"local note"}]
            }),
        },
    )
    .await
    .unwrap();

    assert_eq!(plan.status, "ready");
    assert_eq!(plan.remote_path, "/ATools/test");
    assert_eq!(plan.manifest_kind.as_deref(), Some("atools-webdav-sync"));
    assert_eq!(plan.exported_at.as_deref(), Some("2026-06-02T18:30:00Z"));
    assert_eq!(plan.items.len(), 3);

    let settings = plan
        .items
        .iter()
        .find(|item| item.scope == "settings")
        .unwrap();
    assert_eq!(settings.action, "would_update");
    assert_eq!(settings.file_name, "settings.json");
    assert_eq!(settings.changed_keys, vec!["hotkey"]);
    assert_eq!(settings.skipped_keys, vec!["webdavPassword"]);
    assert!(!settings.high_risk);

    let plugins = plan
        .items
        .iter()
        .find(|item| item.scope == "plugins")
        .unwrap();
    assert_eq!(plugins.action, "would_replace");
    assert_eq!(plugins.local_summary, "插件数据 · 1 个插件");
    assert_eq!(plugins.remote_summary, "插件数据 · 1 个插件");
    assert!(plugins.high_risk);

    let clipboard = plan
        .items
        .iter()
        .find(|item| item.scope == "clipboard")
        .unwrap();
    assert_eq!(clipboard.action, "would_replace");
    assert_eq!(clipboard.local_summary, "剪贴板历史 · 1 条");
    assert_eq!(clipboard.remote_summary, "剪贴板历史 · 2 条");
    assert!(clipboard.high_risk);

    let requests = requests.lock().unwrap().clone();
    assert!(requests.iter().all(|start| start.starts_with("GET ")));
    assert_eq!(requests.len(), 4);
}

#[tokio::test]
async fn webdav_settings_restore_requires_confirmation() {
    use atools_lib::webdav::restore_webdav_settings;

    let error = restore_webdav_settings(
        WebdavSyncConfig {
            url: "http://127.0.0.1:1/dav/".to_string(),
            username: "harris".to_string(),
            password: "secret".to_string(),
            remote_path: "/ATools/test".to_string(),
            proxy_url: None,
        },
        serde_json::json!({ "hotkey": "Option+Z" }),
        false,
    )
    .await
    .unwrap_err();

    assert!(error.contains("confirmation"));
}

#[tokio::test]
async fn webdav_settings_restore_applies_only_settings_and_skips_redacted_secrets() {
    use atools_lib::webdav::restore_webdav_settings;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let requests: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}/dav/", listener.local_addr().unwrap());
    let server_requests = requests.clone();

    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let requests = server_requests.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0; 64 * 1024];
                let bytes_read = socket.read(&mut buffer).await.unwrap();
                let request = String::from_utf8_lossy(&buffer[..bytes_read]).to_string();
                let start = request.lines().next().unwrap_or_default().to_string();
                let path = start
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or_default()
                    .to_string();
                requests.lock().unwrap().push(start);

                let body = if path.ends_with("/manifest.json") {
                    r#"{
                      "version": 1,
                      "kind": "atools-webdav-sync",
                      "exportedAt": "2026-06-03T10:00:00Z",
                      "files": [
                        { "name": "settings.json", "bytes": 160 },
                        { "name": "plugin-data.json", "bytes": 120 },
                        { "name": "clipboard-history.json", "bytes": 80 }
                      ]
                    }"#
                } else if path.ends_with("/settings.json") {
                    r#"{
                      "hotkey": "Command+Space",
                      "theme": "dark",
                      "aiApiKey": "<redacted>",
                      "webdavPassword": "<redacted>",
                      "webdavSyncClipboard": true
                    }"#
                } else {
                    "{}"
                };

                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                            body.len(),
                            body
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            });
        }
    });

    let result = restore_webdav_settings(
        WebdavSyncConfig {
            url: base_url,
            username: "harris".to_string(),
            password: "secret".to_string(),
            remote_path: "/ATools/test".to_string(),
            proxy_url: None,
        },
        serde_json::json!({
            "hotkey": "Option+Z",
            "theme": "system",
            "aiApiKey": "sk-local",
            "webdavPassword": "local-secret",
            "webdavSyncClipboard": false
        }),
        true,
    )
    .await
    .unwrap();

    assert_eq!(result.status, "applied");
    assert_eq!(result.remote_path, "/ATools/test");
    assert_eq!(result.manifest_kind.as_deref(), Some("atools-webdav-sync"));
    assert_eq!(result.exported_at.as_deref(), Some("2026-06-03T10:00:00Z"));
    assert_eq!(
        result.applied_keys,
        vec!["hotkey", "theme", "webdavSyncClipboard"]
    );
    assert_eq!(result.skipped_keys, vec!["aiApiKey", "webdavPassword"]);
    assert_eq!(result.merged_settings["hotkey"], "Command+Space");
    assert_eq!(result.merged_settings["theme"], "dark");
    assert_eq!(result.merged_settings["webdavSyncClipboard"], true);
    assert_eq!(result.merged_settings["aiApiKey"], "sk-local");
    assert_eq!(result.merged_settings["webdavPassword"], "local-secret");

    let requests = requests.lock().unwrap().clone();
    assert!(requests.iter().all(|start| start.starts_with("GET ")));
    assert!(requests
        .iter()
        .any(|start| start.contains("/manifest.json")));
    assert!(requests
        .iter()
        .any(|start| start.contains("/settings.json")));
    assert!(requests
        .iter()
        .all(|start| !start.contains("/plugin-data.json")));
    assert!(requests
        .iter()
        .all(|start| !start.contains("/clipboard-history.json")));
}

#[tokio::test]
async fn webdav_clipboard_restore_requires_confirmation() {
    use atools_lib::webdav::restore_webdav_clipboard_history;

    let error = restore_webdav_clipboard_history(
        WebdavSyncConfig {
            url: "http://127.0.0.1:1/dav/".to_string(),
            username: "harris".to_string(),
            password: "secret".to_string(),
            remote_path: "/ATools/test".to_string(),
            proxy_url: None,
        },
        false,
    )
    .await
    .unwrap_err();

    assert!(error.contains("confirmation"));
}

#[tokio::test]
async fn webdav_clipboard_restore_downloads_only_clipboard_history_and_extracts_text_entries() {
    use atools_lib::webdav::restore_webdav_clipboard_history;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let requests: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}/dav/", listener.local_addr().unwrap());
    let server_requests = requests.clone();

    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let requests = server_requests.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0; 64 * 1024];
                let bytes_read = socket.read(&mut buffer).await.unwrap();
                let request = String::from_utf8_lossy(&buffer[..bytes_read]).to_string();
                let start = request.lines().next().unwrap_or_default().to_string();
                let path = start
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or_default()
                    .to_string();
                requests.lock().unwrap().push(start);

                let body = if path.ends_with("/manifest.json") {
                    r#"{
                      "version": 1,
                      "kind": "atools-webdav-sync",
                      "exportedAt": "2026-06-03T11:00:00Z",
                      "files": [
                        { "name": "settings.json", "bytes": 160 },
                        { "name": "plugin-data.json", "bytes": 120 },
                        { "name": "clipboard-history.json", "bytes": 220 }
                      ]
                    }"#
                } else if path.ends_with("/clipboard-history.json") {
                    r#"{
                      "version": 1,
                      "entries": [
                        {
                          "text": "remote invoice copied",
                          "first_copied_at": "2026-06-03T09:00:00Z",
                          "last_copied_at": "2026-06-03T09:30:00Z",
                          "used_count": 2
                        },
                        {
                          "text": "  ",
                          "last_copied_at": "2026-06-03T09:40:00Z"
                        },
                        {
                          "text": "remote API error",
                          "first_copied_at": "2026-06-03T10:00:00Z"
                        }
                      ]
                    }"#
                } else {
                    "{}"
                };

                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                            body.len(),
                            body
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            });
        }
    });

    let result = restore_webdav_clipboard_history(
        WebdavSyncConfig {
            url: base_url,
            username: "harris".to_string(),
            password: "secret".to_string(),
            remote_path: "/ATools/test".to_string(),
            proxy_url: None,
        },
        true,
    )
    .await
    .unwrap();

    assert_eq!(result.status, "ready");
    assert_eq!(result.remote_path, "/ATools/test");
    assert_eq!(result.manifest_kind.as_deref(), Some("atools-webdav-sync"));
    assert_eq!(result.exported_at.as_deref(), Some("2026-06-03T11:00:00Z"));
    assert_eq!(result.remote_entries, 3);
    assert_eq!(result.skipped_entries, 1);
    assert_eq!(result.entries.len(), 2);
    assert_eq!(result.entries[0].text, "remote invoice copied");
    assert_eq!(result.entries[0].copied_at, "2026-06-03T09:30:00Z");
    assert_eq!(result.entries[1].text, "remote API error");
    assert_eq!(result.entries[1].copied_at, "2026-06-03T10:00:00Z");

    let requests = requests.lock().unwrap().clone();
    assert!(requests.iter().all(|start| start.starts_with("GET ")));
    assert!(requests
        .iter()
        .any(|start| start.contains("/manifest.json")));
    assert!(requests
        .iter()
        .any(|start| start.contains("/clipboard-history.json")));
    assert!(requests
        .iter()
        .all(|start| !start.contains("/settings.json")));
    assert!(requests
        .iter()
        .all(|start| !start.contains("/plugin-data.json")));
}
