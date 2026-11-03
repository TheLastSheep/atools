use super::{
    clipboard::{ClipboardAccess, MAX_TEXT_BYTES},
    clipboard_image::{
        exact_read, normalize, run_limited, success_value, validate_dimensions, EncodedImageFormat,
        ImageJobGate, ImageSource, MAX_ENCODED_INPUT, MAX_PNG_OUTPUT,
    },
    registry::Access,
    request::ClipboardRequest,
    sessions::Invocation,
};
use image::ImageEncoder;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{
    io::Cursor,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

struct FakeClipboard {
    image: Mutex<Option<ImageSource>>,
}
impl FakeClipboard {
    fn with_image(image: Option<ImageSource>) -> Self {
        Self {
            image: Mutex::new(image),
        }
    }
}
impl ClipboardAccess for FakeClipboard {
    fn read(&self) -> Result<String, String> {
        Ok(String::new())
    }
    fn write(&self, _text: &str) -> Result<(), String> {
        Ok(())
    }
    fn read_image(&self) -> Result<Option<ImageSource>, String> {
        Ok(self.image.lock().take())
    }
}

fn png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    let mut output = Vec::new();
    image::codecs::png::PngEncoder::new(&mut output)
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .unwrap();
    output
}

#[test]
fn generated_png_is_decoded_and_returned_as_bounded_png_data_url() {
    let source = ImageSource::Encoded {
        bytes: png(2, 1, &[255, 0, 0, 255, 0, 255, 0, 128]),
        format: EncodedImageFormat::Png,
    };
    let (normalized, width, height) = normalize(source).unwrap();
    let decoded =
        image::load_from_memory_with_format(&normalized, image::ImageFormat::Png).unwrap();
    assert_eq!((width, height), (2, 1));
    assert_eq!(
        decoded.to_rgba8().as_raw(),
        &[255, 0, 0, 255, 0, 255, 0, 128]
    );
    assert!(normalized.len() <= MAX_PNG_OUTPUT);
}

#[test]
fn generated_jpeg_and_tiff_are_decoded_and_normalized_to_png() {
    let source = image::DynamicImage::ImageRgba8(
        image::RgbaImage::from_raw(2, 1, vec![255, 10, 20, 255, 5, 240, 30, 128]).unwrap(),
    );
    for (input_format, source_format) in [
        (image::ImageFormat::Jpeg, EncodedImageFormat::Jpeg),
        (image::ImageFormat::Tiff, EncodedImageFormat::Tiff),
    ] {
        let mut encoded = Cursor::new(Vec::new());
        source.clone().write_to(&mut encoded, input_format).unwrap();
        let (output, width, height) = normalize(ImageSource::Encoded {
            bytes: encoded.into_inner(),
            format: source_format,
        })
        .unwrap();
        let decoded =
            image::load_from_memory_with_format(&output, image::ImageFormat::Png).unwrap();
        assert_eq!((width, height), (2, 1));
        assert_eq!((decoded.width(), decoded.height()), (2, 1));
    }
}

#[test]
fn empty_clipboard_is_null_and_image_errors_do_not_leak_backend_details() {
    let empty = FakeClipboard::with_image(None);
    assert_eq!(exact_read(&empty).unwrap(), Value::Null);
    struct Failing;
    impl ClipboardAccess for Failing {
        fn read(&self) -> Result<String, String> {
            Ok(String::new())
        }
        fn write(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn read_image(&self) -> Result<Option<ImageSource>, String> {
            Err("private provider detail".into())
        }
    }
    assert_eq!(
        exact_read(&Failing).unwrap_err(),
        "Native clipboard image read failed"
    );
}

#[test]
fn malformed_input_input_cap_dimensions_and_pixel_budget_fail_closed() {
    let malformed = ImageSource::Encoded {
        bytes: b"not an image".to_vec(),
        format: EncodedImageFormat::Png,
    };
    assert!(normalize(malformed).is_err());
    let too_large = ImageSource::Encoded {
        bytes: vec![0; MAX_ENCODED_INPUT + 1],
        format: EncodedImageFormat::Png,
    };
    assert!(normalize(too_large).unwrap_err().contains("encoded-input"));
    assert!(normalize(ImageSource::Rgba {
        bytes: vec![],
        width: 8193,
        height: 1
    })
    .is_err());
    assert!(normalize(ImageSource::Rgba {
        bytes: vec![],
        width: 4097,
        height: 4097
    })
    .is_err());
    assert!(validate_dimensions(3840, 2160).is_ok());
}

#[test]
fn png_output_and_complete_success_envelope_have_independent_caps() {
    let mut noise = vec![0u8; 1024 * 1024 * 4];
    let mut state = 0x1234_5678u32;
    for byte in &mut noise {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        *byte = state as u8;
    }
    assert!(normalize(ImageSource::Rgba {
        bytes: noise,
        width: 1024,
        height: 1024
    })
    .is_err());

    let small_png = png(1, 1, &[4, 3, 2, 255]);
    assert!(success_value(&small_png, 1, 1, 32)
        .unwrap_err()
        .contains("response limit"));
    assert!(
        success_value(&vec![0; MAX_PNG_OUTPUT + 1], 1, 1, usize::MAX)
            .unwrap_err()
            .contains("output limit")
    );
    let result = success_value(&small_png, 1, 1, 700 * 1024).unwrap();
    assert_eq!(result["width"], 1);
    assert!(result["dataUrl"]
        .as_str()
        .unwrap()
        .starts_with("data:image/png;base64,"));
}

#[test]
fn image_permission_is_separate_and_request_shape_is_exact() {
    assert_eq!(Access::parse("image").unwrap(), Access::Image);
    assert_eq!(Access::Image.scope(), Access::Read.scope());
    assert_ne!(
        super::registry::tool_name("plugin", Access::Image),
        super::registry::tool_name("plugin", Access::Read)
    );
    assert!(ClipboardRequest::parse(Access::Read, &json!({"format":"image"})).is_err());
    assert!(ClipboardRequest::parse(Access::Image, &json!({})).is_err());
    assert!(ClipboardRequest::parse(Access::Image, &json!({"format":"files"})).is_err());
    assert!(
        ClipboardRequest::parse(Access::Image, &json!({"format":"image","extra":true})).is_err()
    );
    let image_request = ClipboardRequest::parse(Access::Image, &json!({"format":"image"})).unwrap();
    assert!(matches!(&image_request, ClipboardRequest::ReadImage));
    assert!(image_request
        .execute(Access::Image, &FakeClipboard::with_image(None))
        .unwrap_err()
        .contains("bounded blocking worker"));
    assert_eq!(MAX_TEXT_BYTES, 256 * 1024);
}

#[test]
fn image_requires_its_own_exact_registered_tool_grant() {
    let db = atools_core::db::Database::in_memory().unwrap();
    let plugin = super::tests::plugin();
    let read = super::registry::ensure_tool(&db, &plugin, Access::Read).unwrap();
    let image = super::registry::ensure_tool(&db, &plugin, Access::Image).unwrap();
    db.grant_agent_tool("atools-ui", &read).unwrap();
    assert_eq!(
        crate::agent_tools::permission_decision_for_tool(&db, "atools-ui", &read).unwrap(),
        atools_core::agent::PermissionDecision::Allow
    );
    assert_eq!(
        crate::agent_tools::permission_decision_for_tool(&db, "atools-ui", &image).unwrap(),
        atools_core::agent::PermissionDecision::Confirm
    );
    db.grant_agent_tool("atools-ui", &image).unwrap();
    assert_eq!(
        crate::agent_tools::permission_decision_for_tool(&db, "atools-ui", &image).unwrap(),
        atools_core::agent::PermissionDecision::Allow
    );

    let stored = db.get_agent_tool(&image).unwrap().unwrap();
    for mutate in [
        |tool: &mut atools_core::agent::ToolDefinition| tool.source = "other".into(),
        |tool: &mut atools_core::agent::ToolDefinition| tool.name = "other".into(),
        |tool: &mut atools_core::agent::ToolDefinition| tool.plugin_id = Some("other".into()),
        |tool: &mut atools_core::agent::ToolDefinition| tool.scopes.clear(),
    ] {
        let mut forged = stored.clone();
        mutate(&mut forged);
        assert!(super::registry::access_for(&forged).is_err());
    }
}

#[test]
fn request_ticket_is_one_shot_and_only_transport_metadata_enters_audit() {
    let invocation = Invocation {
        session: "session".into(),
        request: Mutex::new(Some(
            ClipboardRequest::parse(Access::Image, &json!({"format":"image"})).unwrap(),
        )),
        claimed: AtomicBool::new(false),
        run: Mutex::new(None),
        result: Mutex::new(None),
    };
    super::claim_invocation(&invocation).unwrap();
    assert_eq!(
        super::claim_invocation(&invocation).unwrap_err(),
        "Clipboard invocation already consumed"
    );

    let args = super::invocation_audit_args("session", "ticket");
    assert_eq!(
        args,
        json!({"operation":"request","sessionId":"session","invocationId":"ticket"})
    );
    let summary = super::invocation_audit_summary("ticket", Access::Image);
    assert_eq!(summary["access"], "image");
    assert_eq!(summary["transportOnly"], true);
    assert!(summary.get("dataUrl").is_none());
    assert!(summary.get("image").is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn timed_out_worker_keeps_the_only_slot_until_real_completion() {
    let gate = Arc::new(ImageJobGate::new());
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (deadline_tx, deadline_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let task = tokio::spawn({
        let gate = gate.clone();
        async move {
            run_limited(
                gate,
                async move {
                    let _ = deadline_rx.await;
                },
                move |cancelled| {
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    assert!(cancelled.load(Ordering::Acquire));
                    Ok::<_, String>(())
                },
            )
            .await
        }
    });
    started_rx.await.unwrap();
    assert_eq!(
        run_limited(
            gate.clone(),
            std::future::pending(),
            |_| Ok::<_, String>(())
        )
        .await
        .unwrap_err(),
        "Native clipboard image operation is busy"
    );
    deadline_tx.send(()).unwrap();
    assert_eq!(
        task.await.unwrap().unwrap_err(),
        "Native clipboard image operation timed out"
    );
    assert_eq!(
        run_limited(
            gate.clone(),
            std::future::pending(),
            |_| Ok::<_, String>(())
        )
        .await
        .unwrap_err(),
        "Native clipboard image operation is busy"
    );
    release_tx.send(()).unwrap();
    gate.wait_until_released().await;
    assert_eq!(
        run_limited(gate, std::future::pending(), |_| Ok::<_, String>(()))
            .await
            .unwrap(),
        ()
    );
}
