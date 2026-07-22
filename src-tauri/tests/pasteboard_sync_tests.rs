use atools_core::{
    AppConfig, Database, PasteboardBlob, PasteboardItem, PasteboardItemKind, PasteboardSourceApp,
    PasteboardTombstone,
};
use atools_lib::pasteboard_sync::sync_pasteboard_vault;
use atools_lib::webdav::WebdavSyncConfig;
use parking_lot::Mutex;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

#[derive(Default)]
struct WebDavState {
    files: Mutex<HashMap<String, (Vec<u8>, String)>>,
    revision: AtomicUsize,
    reject_next_snapshot: AtomicBool,
}

struct FixtureServer {
    base_url: String,
    state: Arc<WebDavState>,
    shutdown: Option<oneshot::Sender<()>>,
}

impl FixtureServer {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}/", listener.local_addr().unwrap());
        let state = Arc::new(WebDavState::default());
        let (shutdown_tx, mut shutdown_rx) = oneshot::channel();
        let task_state = state.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { break };
                        let state = task_state.clone();
                        tokio::spawn(async move { serve_request(stream, state).await; });
                    }
                }
            }
        });
        Self {
            base_url,
            state,
            shutdown: Some(shutdown_tx),
        }
    }
}

impl Drop for FixtureServer {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

async fn serve_request(mut stream: TcpStream, state: Arc<WebDavState>) {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    let header_end = loop {
        let Ok(read) = stream.read(&mut chunk).await else {
            return;
        };
        if read == 0 {
            return;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(index) = buffer.windows(4).position(|value| value == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let header = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
    let mut lines = header.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut request = request_line.split_whitespace();
    let method = request.next().unwrap_or_default().to_string();
    let path = request.next().unwrap_or_default().to_string();
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect::<HashMap<_, _>>();
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    while buffer.len() < header_end + content_length {
        let Ok(read) = stream.read(&mut chunk).await else {
            return;
        };
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    let body = buffer
        .get(header_end..header_end + content_length)
        .unwrap_or_default()
        .to_vec();

    match method.as_str() {
        "MKCOL" => respond(&mut stream, 201, None, &[]).await,
        "GET" | "HEAD" => {
            let file = state.files.lock().get(&path).cloned();
            match file {
                Some((bytes, etag)) => {
                    respond(
                        &mut stream,
                        200,
                        Some(&etag),
                        if method == "HEAD" { &[] } else { &bytes },
                    )
                    .await
                }
                None => respond(&mut stream, 404, None, &[]).await,
            }
        }
        "PUT" => {
            if path.ends_with("/snapshot.enc")
                && state.reject_next_snapshot.swap(false, Ordering::SeqCst)
            {
                respond(&mut stream, 412, None, &[]).await;
                return;
            }
            let existing = state.files.lock().get(&path).cloned();
            let failed = headers
                .get("if-none-match")
                .is_some_and(|value| value == "*" && existing.is_some())
                || headers.get("if-match").is_some_and(|expected| {
                    existing
                        .as_ref()
                        .is_none_or(|(_, actual)| expected != actual)
                });
            if failed {
                respond(&mut stream, 412, None, &[]).await;
                return;
            }
            let revision = state.revision.fetch_add(1, Ordering::SeqCst) + 1;
            let etag = format!("\"fixture-{revision}\"");
            state.files.lock().insert(path, (body, etag.clone()));
            respond(
                &mut stream,
                if existing.is_some() { 204 } else { 201 },
                Some(&etag),
                &[],
            )
            .await;
        }
        _ => respond(&mut stream, 405, None, &[]).await,
    }
}

async fn respond(stream: &mut TcpStream, status: u16, etag: Option<&str>, body: &[u8]) {
    let reason = match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        404 => "Not Found",
        405 => "Method Not Allowed",
        412 => "Precondition Failed",
        _ => "Error",
    };
    let etag = etag
        .map(|value| format!("ETag: {value}\r\n"))
        .unwrap_or_default();
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\n{etag}Connection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes()).await;
    let _ = stream.write_all(body).await;
    let _ = stream.shutdown().await;
}

fn item(id: &str, text: &str, updated_at: &str, device_id: &str) -> PasteboardItem {
    PasteboardItem {
        id: id.into(),
        kind: PasteboardItemKind::Text,
        title: None,
        source_app: Some(PasteboardSourceApp {
            bundle_id: Some("dev.atools.sync-test".into()),
            name: Some("Sync Test".into()),
        }),
        source_device_id: device_id.into(),
        copied_at: updated_at.into(),
        updated_at: updated_at.into(),
        content_fingerprint: format!("fingerprint-{id}-{text}"),
        payload: serde_json::json!({"text": text}),
        ocr_text: None,
        pinboard_id: None,
        pinboard_order_key: None,
        pinned: false,
        field_clocks: serde_json::json!({}),
    }
}

fn database(root: &tempfile::TempDir, device_id: &str) -> (AppConfig, Database) {
    let config = AppConfig::with_base_dir(root.path().to_path_buf());
    config.ensure_dirs().unwrap();
    let db = Database::open(&config.db_path()).unwrap();
    db.set_setting("pasteboard.device_id", device_id).unwrap();
    (config, db)
}

fn sync_config(base_url: &str) -> WebdavSyncConfig {
    WebdavSyncConfig {
        url: base_url.into(),
        username: "fixture".into(),
        password: "correct horse battery staple".into(),
        remote_path: "sync-tests".into(),
        proxy_url: None,
    }
}

#[tokio::test]
async fn encrypted_webdav_sync_round_trips_updates_tombstones_and_conflict_retry() {
    let server = FixtureServer::start().await;
    let root_a = tempfile::tempdir().unwrap();
    let root_b = tempfile::tempdir().unwrap();
    let (config_a, db_a) = database(&root_a, "device-a");
    let (config_b, db_b) = database(&root_b, "device-b");
    let remote = sync_config(&server.base_url);
    db_a.upsert_pasteboard_item(&item(
        "shared-item",
        "cross-device secret text",
        "2026-07-21T01:00:00Z",
        "device-a",
    ))
    .unwrap();

    let first = sync_pasteboard_vault(&db_a, &config_a, remote.clone())
        .await
        .unwrap();
    assert_eq!(first.items, 1);
    sync_pasteboard_vault(&db_b, &config_b, remote.clone())
        .await
        .unwrap();
    assert_eq!(
        db_b.get_pasteboard_item("shared-item")
            .unwrap()
            .unwrap()
            .payload["text"],
        "cross-device secret text"
    );

    let mut updated = db_b.get_pasteboard_item("shared-item").unwrap().unwrap();
    updated.title = Some("renamed remotely".into());
    updated.updated_at = "2026-07-21T02:00:00Z".into();
    db_b.upsert_pasteboard_item(&updated).unwrap();
    server
        .state
        .reject_next_snapshot
        .store(true, Ordering::SeqCst);
    let retried = sync_pasteboard_vault(&db_b, &config_b, remote.clone())
        .await
        .unwrap();
    assert_eq!(retried.retries, 1);
    sync_pasteboard_vault(&db_a, &config_a, remote.clone())
        .await
        .unwrap();
    assert_eq!(
        db_a.get_pasteboard_item("shared-item")
            .unwrap()
            .unwrap()
            .title
            .as_deref(),
        Some("renamed remotely")
    );

    db_a.delete_pasteboard_item("shared-item").unwrap();
    db_a.upsert_pasteboard_tombstone(&PasteboardTombstone {
        entity_id: "shared-item".into(),
        entity_kind: "paste_item".into(),
        deleted_at: "2026-07-21T03:00:00Z".into(),
        deleted_clock: serde_json::json!({}),
        source_device_id: "device-a".into(),
    })
    .unwrap();
    sync_pasteboard_vault(&db_a, &config_a, remote.clone())
        .await
        .unwrap();
    sync_pasteboard_vault(&db_b, &config_b, remote)
        .await
        .unwrap();
    assert!(db_b.get_pasteboard_item("shared-item").unwrap().is_none());

    let remote_bytes = server
        .state
        .files
        .lock()
        .values()
        .flat_map(|(bytes, _)| bytes.clone())
        .collect::<Vec<_>>();
    assert!(!String::from_utf8_lossy(&remote_bytes).contains("cross-device secret text"));
    assert!(!String::from_utf8_lossy(&remote_bytes).contains("renamed remotely"));
}

#[tokio::test]
async fn encrypted_webdav_sync_transfers_content_addressed_blob_bytes() {
    let server = FixtureServer::start().await;
    let root_a = tempfile::tempdir().unwrap();
    let root_b = tempfile::tempdir().unwrap();
    let (config_a, db_a) = database(&root_a, "device-a");
    let (config_b, db_b) = database(&root_b, "device-b");
    let bytes = b"encrypted image fixture bytes".to_vec();
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let blob = PasteboardBlob {
        id: format!("blob-{hash}"),
        content_hash: hash.clone(),
        relative_path: format!("{}/{}.bin", &hash[..2], hash),
        media_type: "image/png".into(),
        byte_size: bytes.len() as u64,
        created_at: "2026-07-21T01:00:00Z".into(),
        last_accessed_at: "2026-07-21T01:00:00Z".into(),
    };
    let source_path = config_a.pasteboard_blobs_dir().join(&blob.relative_path);
    std::fs::create_dir_all(source_path.parent().unwrap()).unwrap();
    std::fs::write(&source_path, &bytes).unwrap();
    db_a.upsert_pasteboard_blob(&blob).unwrap();
    let mut image = item("image-item", "", "2026-07-21T01:00:00Z", "device-a");
    image.kind = PasteboardItemKind::Image;
    image.payload = serde_json::json!({
        "imageBlobId": blob.id,
        "imageBlobPath": blob.relative_path,
        "imageMediaType": blob.media_type,
    });
    db_a.upsert_pasteboard_item(&image).unwrap();
    db_a.link_pasteboard_blob(&image.id, &blob.id).unwrap();

    let remote = sync_config(&server.base_url);
    sync_pasteboard_vault(&db_a, &config_a, remote.clone())
        .await
        .unwrap();
    let result = sync_pasteboard_vault(&db_b, &config_b, remote)
        .await
        .unwrap();
    assert_eq!(result.downloaded_blobs, 1);
    assert_eq!(
        std::fs::read(config_b.pasteboard_blobs_dir().join(&blob.relative_path)).unwrap(),
        bytes
    );
    assert_eq!(db_b.get_pasteboard_blob(&blob.id).unwrap(), Some(blob));
    let repeated = sync_pasteboard_vault(&db_b, &config_b, sync_config(&server.base_url))
        .await
        .unwrap();
    assert_eq!(repeated.uploaded_blobs, 0);
}
