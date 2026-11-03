use super::{
    clipboard::{ClipboardAccess, MAX_TEXT_BYTES},
    clipboard_image::{run_limited, ImageJobGate},
    clipboard_image_write::{
        decode, write_decoded, ImageWriteRequest, MAX_DATA_URL_BYTES, MAX_PNG_BYTES,
        PNG_DATA_URL_PREFIX,
    },
    registry::{self, Access},
    request::ClipboardRequest,
    sessions::Sessions,
};
use atools_core::{agent::PermissionDecision, db::Database, Plugin, PluginManifest};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::ImageEncoder;
use parking_lot::Mutex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};

#[derive(Default)]
struct FakeClipboard {
    image: Mutex<Option<(Vec<u8>, u32, u32)>>,
    writes: AtomicUsize,
    fail: AtomicBool,
}
impl ClipboardAccess for FakeClipboard {
    fn read(&self) -> Result<String, String> {
        Ok(String::new())
    }
    fn write(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn write_image(
        &self,
        image: super::clipboard_image_write::RgbaClipboardImage,
    ) -> Result<(), String> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        if self.fail.load(Ordering::SeqCst) {
            return Err("private provider detail".into());
        }
        *self.image.lock() = Some((image.rgba, image.width, image.height));
        Ok(())
    }
}

fn png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .unwrap();
    bytes
}

fn image_payload(bytes: &[u8], width: u32, height: u32) -> Value {
    json!({"image": {
        "dataUrl": format!("{PNG_DATA_URL_PREFIX}{}", STANDARD.encode(bytes)),
        "width": width,
        "height": height
    }})
}

fn request(bytes: &[u8], width: u32, height: u32) -> ImageWriteRequest {
    ImageWriteRequest::parse(&image_payload(bytes, width, height)["image"]).unwrap()
}

#[test]
fn valid_png_decodes_and_fake_backend_receives_exact_rgba_once() {
    let expected = vec![255, 0, 12, 255, 6, 220, 19, 128];
    let bytes = png(2, 1, &expected);
    let payload =
        ClipboardRequest::parse(Access::ImageWrite, &image_payload(&bytes, 2, 1)).unwrap();
    assert!(payload.is_image_write());
    let ClipboardRequest::WriteImage(payload) = payload else {
        panic!("expected image write request");
    };
    let decoded = decode(&payload).unwrap();
    let backend = FakeClipboard::default();
    write_decoded(&backend, decoded, &AtomicBool::new(false), || true).unwrap();
    assert_eq!(backend.writes.load(Ordering::SeqCst), 1);
    assert_eq!(*backend.image.lock(), Some((expected, 2, 1)));
}

#[test]
fn original_plugin_png_decodes_to_independently_verified_rgba_before_fake_write() {
    const ORIGINAL_PNG: &[u8] =
        include_bytes!("../../../ZTools-plugins/plugins/calculation-paper/logo.png");
    const EXPECTED_PNG_SHA256: &str =
        "390aaa92636d3b3811341f418ca05497bc8751f6df760fa64c3aa5de6c5f3353";
    const EXPECTED_RGBA_SHA256: &str =
        "d80fd181b48e9b41efbd6f4ff600e7aee3de5680383f84acab2cfab9ce4d147d";

    let png_hash = format!("{:x}", Sha256::digest(ORIGINAL_PNG));
    assert_eq!(png_hash, EXPECTED_PNG_SHA256);
    let parsed =
        ClipboardRequest::parse(Access::ImageWrite, &image_payload(ORIGINAL_PNG, 200, 200))
            .unwrap();
    let ClipboardRequest::WriteImage(request) = parsed else {
        panic!("expected image-write request");
    };
    let decoded = decode(&request).unwrap();
    assert_eq!((decoded.width, decoded.height), (200, 200));
    assert_eq!(
        format!("{:x}", Sha256::digest(&decoded.rgba)),
        EXPECTED_RGBA_SHA256
    );

    let backend = FakeClipboard::default();
    write_decoded(&backend, decoded, &AtomicBool::new(false), || true).unwrap();
    assert_eq!(backend.writes.load(Ordering::SeqCst), 1);
    let image = backend.image.lock().clone().unwrap();
    assert_eq!((image.1, image.2), (200, 200));
    assert_eq!(
        format!("{:x}", Sha256::digest(&image.0)),
        EXPECTED_RGBA_SHA256
    );
}

#[test]
fn exact_outer_and_inner_shapes_and_grants_are_distinct_from_text_and_image_read() {
    let db = Database::in_memory().unwrap();
    let manifest: PluginManifest = serde_json::from_value(
        json!({"name":"image-write-fixture","version":"1","main":"index.html"}),
    )
    .unwrap();
    let plugin = Plugin {
        id: "image-write-fixture".into(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        path: "/fixture/plugin".into(),
        enabled: true,
        manifest,
        created_at: "now".into(),
        updated_at: "now".into(),
    };
    let text_write = registry::ensure_tool(&db, &plugin, Access::Write).unwrap();
    let image_read = registry::ensure_tool(&db, &plugin, Access::Image).unwrap();
    let image_write = registry::ensure_tool(&db, &plugin, Access::ImageWrite).unwrap();
    assert_ne!(text_write, image_write);
    assert_ne!(image_read, image_write);
    assert_eq!(Access::parse("image_write").unwrap(), Access::ImageWrite);
    assert!(Access::parse("imagewrite").is_err());
    assert_eq!(
        db.get_agent_tool(&image_write).unwrap().unwrap().scopes,
        Access::ImageWrite.scopes()
    );
    db.grant_agent_tool("atools-ui", &text_write).unwrap();
    db.grant_agent_tool("atools-ui", &image_read).unwrap();
    assert_eq!(
        crate::agent_tools::permission_decision_for_tool(&db, "atools-ui", &image_write).unwrap(),
        PermissionDecision::Confirm
    );
    let write_tool = db.get_agent_tool(&image_write).unwrap().unwrap();
    assert_eq!(
        registry::access_for(&write_tool).unwrap(),
        Access::ImageWrite
    );
    let mut forged = write_tool;
    forged.name = text_write;
    assert_eq!(registry::access_for(&forged).unwrap(), Access::Write);

    let valid_png = png(1, 1, &[1, 2, 3, 255]);
    let valid = image_payload(&valid_png, 1, 1);
    assert!(ClipboardRequest::parse(Access::ImageWrite, &valid).is_ok());
    assert!(ClipboardRequest::parse(Access::Write, &valid).is_err());
    assert!(ClipboardRequest::parse(Access::Image, &valid).is_err());
    assert!(ClipboardRequest::parse(
        Access::ImageWrite,
        &json!({"image":valid["image"],"extra":true})
    )
    .is_err());
    assert!(ClipboardRequest::parse(
        Access::ImageWrite,
        &json!({"image":{"dataUrl":valid["image"]["dataUrl"],"width":1,"height":1,"extra":0}})
    )
    .is_err());
    assert!(ClipboardRequest::parse(
        Access::ImageWrite,
        &json!({"image":{"dataUrl":valid["image"]["dataUrl"],"width":1,"height":1.5}})
    )
    .is_err());
    assert!(ImageWriteRequest::parse(
        &json!({"dataUrl":valid["image"]["dataUrl"],"width":8193,"height":1})
    )
    .is_err());
    assert!(ImageWriteRequest::parse(
        &json!({"dataUrl":valid["image"]["dataUrl"],"width":8192,"height":8192})
    )
    .is_err());
    assert_eq!(MAX_TEXT_BYTES, 256 * 1024);
}

#[test]
fn malformed_truncated_mismatched_and_oversized_pngs_fail_closed() {
    let original = png(2, 1, &[255, 0, 0, 255, 0, 0, 255, 255]);
    assert!(decode(&request(&original, 1, 1)).is_err());
    assert!(decode(&request(&original[..original.len() - 12], 2, 1)).is_err());
    assert!(decode(&request(b"not-png", 1, 1)).is_err());

    let mut invalid_base64 = image_payload(&original, 2, 1);
    invalid_base64["image"]["dataUrl"] = json!(format!("{PNG_DATA_URL_PREFIX}%%"));
    let ClipboardRequest::WriteImage(invalid_base64) =
        ClipboardRequest::parse(Access::ImageWrite, &invalid_base64).unwrap()
    else {
        unreachable!()
    };
    assert!(decode(&invalid_base64).is_err());

    let oversized_data_url = format!(
        "{PNG_DATA_URL_PREFIX}{}",
        STANDARD.encode(vec![0u8; MAX_PNG_BYTES + 1])
    );
    assert!(oversized_data_url.len() <= MAX_DATA_URL_BYTES);
    let ClipboardRequest::WriteImage(oversized_request) = ClipboardRequest::parse(
        Access::ImageWrite,
        &json!({"image":{"dataUrl":oversized_data_url,"width":1,"height":1}}),
    )
    .unwrap() else {
        unreachable!()
    };
    assert!(decode(&oversized_request).is_err());
    let jpeg_url = ImageWriteRequest::parse(
        &json!({"dataUrl":"data:image/jpeg;base64,AA==","width":1,"height":1}),
    )
    .unwrap();
    assert!(decode(&jpeg_url).is_err());
}

#[test]
fn cancellation_or_stale_authorization_prevents_provider_call_and_provider_errors_are_redacted() {
    let backend = FakeClipboard::default();
    let decoded = decode(&request(&png(1, 1, &[3, 4, 5, 255]), 1, 1)).unwrap();
    let cancelled = AtomicBool::new(true);
    assert_eq!(
        write_decoded(&backend, decoded, &cancelled, || true).unwrap_err(),
        "Clipboard image request was cancelled"
    );
    assert_eq!(backend.writes.load(Ordering::SeqCst), 0);

    let decoded = decode(&request(&png(1, 1, &[3, 4, 5, 255]), 1, 1)).unwrap();
    assert_eq!(
        write_decoded(&backend, decoded, &AtomicBool::new(false), || false).unwrap_err(),
        "Clipboard session closed or access revoked"
    );
    assert_eq!(backend.writes.load(Ordering::SeqCst), 0);

    backend.fail.store(true, Ordering::SeqCst);
    let decoded = decode(&request(&png(1, 1, &[3, 4, 5, 255]), 1, 1)).unwrap();
    assert_eq!(
        write_decoded(&backend, decoded, &AtomicBool::new(false), || true).unwrap_err(),
        "Native clipboard image write failed"
    );
    assert_eq!(backend.writes.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn image_write_shares_singleflight_gate_without_queueing_a_second_provider_call() {
    let gate = Arc::new(ImageJobGate::new());
    let backend = Arc::new(FakeClipboard::default());
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let first = tokio::spawn({
        let gate = gate.clone();
        let backend = backend.clone();
        async move {
            run_limited(gate, std::future::pending(), move |cancelled| {
                let decoded = decode(&request(&png(1, 1, &[8, 9, 10, 255]), 1, 1))?;
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                write_decoded(backend.as_ref(), decoded, &cancelled, || true)
            })
            .await
        }
    });
    started_rx.await.unwrap();
    let second_backend = backend.clone();
    assert_eq!(
        run_limited(gate.clone(), std::future::pending(), move |cancelled| {
            let decoded = decode(&request(&png(1, 1, &[1, 2, 3, 255]), 1, 1))?;
            write_decoded(second_backend.as_ref(), decoded, &cancelled, || true)
        })
        .await
        .unwrap_err(),
        "Native clipboard image operation is busy"
    );
    assert_eq!(backend.writes.load(Ordering::SeqCst), 0);
    release_tx.send(()).unwrap();
    first.await.unwrap().unwrap();
    assert_eq!(backend.writes.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn timed_out_write_cancels_before_a_waiting_worker_can_reach_the_provider() {
    let gate = Arc::new(ImageJobGate::new());
    let backend = Arc::new(FakeClipboard::default());
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (deadline_tx, deadline_rx) = tokio::sync::oneshot::channel::<()>();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let (finished_tx, finished_rx) = std::sync::mpsc::channel();

    let result = tokio::spawn({
        let gate = gate.clone();
        let backend = backend.clone();
        async move {
            run_limited(
                gate,
                async move {
                    let _ = deadline_rx.await;
                },
                move |cancelled| {
                    let decoded = decode(&request(&png(1, 1, &[8, 9, 10, 255]), 1, 1))?;
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    let result = write_decoded(backend.as_ref(), decoded, &cancelled, || true);
                    finished_tx.send(result.clone()).unwrap();
                    result
                },
            )
            .await
        }
    });

    started_rx.await.unwrap();
    deadline_tx.send(()).unwrap();
    assert_eq!(
        result.await.unwrap().unwrap_err(),
        "Native clipboard image operation timed out"
    );
    release_tx.send(()).unwrap();
    assert_eq!(
        finished_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap()
            .unwrap_err(),
        "Clipboard image request was cancelled"
    );
    assert_eq!(backend.writes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn manual_rotation_does_not_mint_an_unused_image_write_successor() {
    let db = Database::in_memory().unwrap();
    let manifest: PluginManifest =
        serde_json::from_value(json!({"name":"rotate-fixture","version":"1","main":"index.html"}))
            .unwrap();
    let plugin = Plugin {
        id: "rotate-fixture".into(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        path: "/fixture/plugin".into(),
        enabled: true,
        manifest,
        created_at: "now".into(),
        updated_at: "now".into(),
    };
    let image_write = registry::ensure_tool(&db, &plugin, Access::ImageWrite).unwrap();
    db.grant_agent_tool("atools-ui", &image_write).unwrap();
    let runtime = Sessions::new(Arc::new(FakeClipboard::default()));
    let intent = runtime
        .intent("old-owner".into(), plugin.id.clone(), Access::ImageWrite)
        .unwrap();
    let session = runtime.open(&intent, &plugin, Access::ImageWrite).unwrap();
    let token = session.token.clone();
    assert!(runtime
        .rotate("old-owner", "new-owner", &plugin.id, &[session.id.clone()])
        .unwrap()
        .is_empty());
    assert!(runtime.by_token(&token).is_none());
    assert!(runtime.store.lock().sessions.is_empty());
    assert_eq!(
        crate::agent_tools::permission_decision_for_tool(&db, "atools-ui", &image_write).unwrap(),
        PermissionDecision::Allow
    );
}
