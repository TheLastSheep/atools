use super::current_context::{
    image_data_url, parse_timestamp_ms, project_snapshot, validate_response_budget,
    validate_time_limit, within_time_limit, BoundedJsonCounter, LastCopiedContent, LastCopiedFile,
    CURRENT_CONTEXT_MAX_FILES, CURRENT_CONTEXT_MAX_IMAGE_INPUT_BYTES,
    CURRENT_CONTEXT_MAX_PATH_BYTES, CURRENT_CONTEXT_MAX_RESPONSE_BYTES,
};
use super::current_context_runtime::{observe_snapshot, CurrentContextObservation};
use super::{NativePasteboardRepresentation, NativePasteboardSnapshot};
use std::time::Duration;

fn snapshot(
    change_count: i64,
    copied_at: &str,
    representations: Vec<NativePasteboardRepresentation>,
) -> NativePasteboardSnapshot {
    NativePasteboardSnapshot {
        change_count,
        copied_at: copied_at.to_string(),
        source_app: None,
        is_confidential: false,
        is_transient: false,
        representations,
    }
}

#[test]
fn validates_optional_millisecond_limits_and_safe_range() {
    assert_eq!(validate_time_limit(None).unwrap(), None);
    assert_eq!(validate_time_limit(Some(0.0)).unwrap(), None);
    assert_eq!(validate_time_limit(Some(-10.5)).unwrap(), None);
    assert_eq!(
        validate_time_limit(Some(1250.5)).unwrap(),
        Some(Duration::from_millis(1250) + Duration::from_micros(500))
    );
    assert!(validate_time_limit(Some(f64::NAN)).is_err());
    assert!(validate_time_limit(Some(f64::INFINITY)).is_err());
    assert!(validate_time_limit(Some(9_007_199_254_740_992.0)).is_err());
}

#[test]
fn timestamp_and_age_limits_preserve_the_inclusive_millisecond_boundary() {
    let timestamp = parse_timestamp_ms("2020-01-02T03:04:05.006Z").unwrap();
    assert_eq!(timestamp, 1_577_934_245_006);
    assert!(within_time_limit(
        timestamp,
        Some(Duration::from_millis(10)),
        timestamp + 10
    ));
    assert!(!within_time_limit(
        timestamp,
        Some(Duration::from_millis(10)),
        timestamp + 11
    ));
    assert!(parse_timestamp_ms("not-a-time").is_err());
}

#[test]
fn observed_snapshot_keeps_its_timestamp_when_a_new_copy_is_observed_before_projection() {
    let observation = parking_lot::Mutex::new(CurrentContextObservation::default());
    let old = observe_snapshot(
        &observation,
        snapshot(
            70,
            "2020-01-02T03:04:05.006Z",
            vec![NativePasteboardRepresentation::Text("old".into())],
        ),
    );
    let new = observe_snapshot(
        &observation,
        snapshot(
            71,
            "2021-01-02T03:04:05.006Z",
            vec![NativePasteboardRepresentation::Text("new".into())],
        ),
    );

    let projected_old = project_snapshot(old.snapshot, old.timestamp_ms.unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(projected_old).unwrap()["timestamp"],
        1_577_934_245_006u64
    );
    assert_eq!(
        new.timestamp_ms,
        Some(parse_timestamp_ms("2021-01-02T03:04:05.006Z").unwrap())
    );
    assert_eq!(observation.lock().timestamp_ms, new.timestamp_ms);
}

#[test]
fn projection_uses_file_then_image_then_exact_text_and_serializes_the_frozen_shape() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("copied file.txt");
    std::fs::write(
        &path,
        b"private file contents are never opened by the projector",
    )
    .unwrap();
    let png = test_png();
    let content = project_snapshot(
        snapshot(
            4,
            "2020-01-02T03:04:05.006Z",
            vec![
                NativePasteboardRepresentation::Text("  exact\ntext  ".into()),
                NativePasteboardRepresentation::Image {
                    bytes: png.clone(),
                    media_type: "image/png".into(),
                },
                NativePasteboardRepresentation::Files(vec![path.to_string_lossy().into_owned()]),
            ],
        ),
        1_577_934_245_006,
    )
    .unwrap()
    .unwrap();
    let value = serde_json::to_value(content).unwrap();
    assert_eq!(value["type"], "file");
    assert_eq!(value["timestamp"], 1_577_934_245_006u64);
    assert_eq!(value["data"][0]["path"], path.to_string_lossy().as_ref());
    assert_eq!(value["data"][0]["name"], "copied file.txt");
    assert_eq!(value["data"][0]["isFile"], true);
    assert_eq!(value["data"][0]["isDirectory"], false);
    assert_eq!(value.as_object().unwrap().len(), 3);

    let image = project_snapshot(
        snapshot(
            5,
            "2020-01-02T03:04:05.006Z",
            vec![
                NativePasteboardRepresentation::Text("  keep whitespace  ".into()),
                NativePasteboardRepresentation::Image {
                    bytes: png,
                    media_type: "image/png".into(),
                },
            ],
        ),
        1_577_934_245_006,
    )
    .unwrap()
    .unwrap();
    let image = serde_json::to_value(image).unwrap();
    assert_eq!(image["type"], "image");
    assert_eq!(
        image["data"].as_str().unwrap().split(',').next(),
        Some("data:image/png;base64")
    );

    let text = project_snapshot(
        snapshot(
            6,
            "2020-01-02T03:04:05.006Z",
            vec![NativePasteboardRepresentation::Text(
                "  keep whitespace  ".into(),
            )],
        ),
        1_577_934_245_006,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        serde_json::to_value(text).unwrap(),
        serde_json::json!({"type":"text","data":"  keep whitespace  ","timestamp":1_577_934_245_006u64})
    );
}

#[test]
fn image_input_and_file_projection_fail_closed_at_bounds() {
    assert!(image_data_url(
        &vec![0; CURRENT_CONTEXT_MAX_IMAGE_INPUT_BYTES + 1],
        "image/png"
    )
    .is_err());

    let too_wide = png_with_dimensions(16_385, 1);
    assert!(image_data_url(&too_wide, "image/png")
        .unwrap_err()
        .contains("CLIPBOARD_CONTEXT_BUDGET"));
    let too_many_pixels = png_with_dimensions(16_384, 2_500);
    assert!(image_data_url(&too_many_pixels, "image/png")
        .unwrap_err()
        .contains("CLIPBOARD_CONTEXT_BUDGET"));
    assert!(project_snapshot(
        snapshot(
            1,
            "2020-01-02T03:04:05.006Z",
            vec![NativePasteboardRepresentation::Text("x".repeat(
                super::current_context::CURRENT_CONTEXT_MAX_TEXT_BYTES + 1
            ))],
        ),
        1_577_934_245_006
    )
    .is_err());

    let too_many = (0..=CURRENT_CONTEXT_MAX_FILES)
        .map(|index| format!("/tmp/copied-{index}"))
        .collect::<Vec<_>>();
    assert!(project_snapshot(
        snapshot(
            2,
            "2020-01-02T03:04:05.006Z",
            vec![NativePasteboardRepresentation::Files(too_many)],
        ),
        1_577_934_245_006
    )
    .is_err());

    assert!(project_snapshot(
        snapshot(
            3,
            "2020-01-02T03:04:05.006Z",
            vec![NativePasteboardRepresentation::Files(vec![format!(
                "/{}",
                "a".repeat(CURRENT_CONTEXT_MAX_PATH_BYTES)
            )])],
        ),
        1_577_934_245_006
    )
    .is_err());
}

#[test]
fn audit_summary_contains_only_type_sizes_count_and_timestamp() {
    let content = LastCopiedContent::Text {
        data: "never serialize this clipboard text".into(),
        timestamp: 10,
    };
    let summary = content.audit_summary();
    assert_eq!(
        summary,
        serde_json::json!({
            "type":"text",
            "payloadBytes":"never serialize this clipboard text".len(),
            "fileCount":0,
            "timestamp":10
        })
    );
    assert!(!summary.to_string().contains("never serialize"));

    let files = LastCopiedContent::File {
        data: vec![LastCopiedFile {
            path: "/private/path/secret.txt".into(),
            name: "secret.txt".into(),
            is_file: true,
            is_directory: false,
        }],
        timestamp: 11,
    }
    .audit_summary();
    assert_eq!(files["fileCount"], 1);
    assert_eq!(
        files["payloadBytes"],
        "/private/path/secret.txtsecret.txt".len()
    );
    assert!(!files.to_string().contains("secret"));
}

#[test]
fn wire_response_budget_rejects_large_file_metadata_without_serializing_into_audit() {
    let content = LastCopiedContent::File {
        data: vec![LastCopiedFile {
            path: "p".repeat(CURRENT_CONTEXT_MAX_RESPONSE_BYTES + 1),
            name: "n".into(),
            is_file: true,
            is_directory: false,
        }],
        timestamp: 10,
    };
    assert!(validate_response_budget(&content).is_err());
}

#[test]
fn response_budget_stops_counting_escaped_control_text_at_the_limit() {
    let content = LastCopiedContent::Text {
        data: "\u{0001}".repeat(super::current_context::CURRENT_CONTEXT_MAX_TEXT_BYTES),
        timestamp: 10,
    };
    let mut counter = BoundedJsonCounter::default();
    assert!(serde_json::to_writer(&mut counter, &content).is_err());
    assert!(counter.exceeded);
    assert!(counter.written_bytes <= CURRENT_CONTEXT_MAX_RESPONSE_BYTES);
    assert_eq!(
        validate_response_budget(&content).unwrap_err(),
        "CLIPBOARD_CONTEXT_BUDGET: clipboard content exceeds its limit"
    );
}

fn test_png() -> Vec<u8> {
    let image = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        1,
        1,
        image::Rgba([40, 80, 120, 255]),
    ));
    let mut output = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut output, image::ImageFormat::Png)
        .unwrap();
    output.into_inner()
}

fn png_with_dimensions(width: u32, height: u32) -> Vec<u8> {
    let mut png = test_png();
    png[16..20].copy_from_slice(&width.to_be_bytes());
    png[20..24].copy_from_slice(&height.to_be_bytes());
    png
}
