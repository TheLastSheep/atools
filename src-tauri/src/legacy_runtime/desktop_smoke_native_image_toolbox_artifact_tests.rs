use super::*;
use image::{DynamicImage, RgbaImage};

fn png(width: u32, height: u32) -> Vec<u8> {
    let image = DynamicImage::ImageRgba8(RgbaImage::new(width, height));
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, ImageFormat::Png).unwrap();
    bytes.into_inner()
}
fn geometry(width: u32, height: u32) -> Value {
    json!({"canvas":{"width":width,"height":height,"zoom":1.0},
        "container":{"left":0,"top":0,"right":112,"bottom":72,"width":112,"height":72},
        "child":{"innerWidth":112,"innerHeight":72,"devicePixelRatio":2}})
}

#[test]
fn fully_decodes_the_original_png_input_dimensions_without_using_them_as_export_gate() {
    let bytes = png(200, 200);
    let decoded = decode_png(&bytes).unwrap();
    assert_eq!((decoded.width, decoded.height), (200, 200));
}

#[test]
fn reports_and_retains_decodable_wrong_dimensions_without_passing() {
    let source = tempfile::tempdir().unwrap();
    let report_dir = tempfile::tempdir().unwrap();
    let bytes = png(112, 72);
    fs::write(source.path().join(OUTPUT_NAME), &bytes).unwrap();
    let report_path = report_dir.path().join("native-report.json");
    let report = json!({"geometry":geometry(100, 72)});
    let result = verify_output(source.path(), &report_path, &report);
    assert!(!result.passed);
    assert_eq!(
        result.report["errorCode"],
        "image-output-canvas-dimensions-mismatch"
    );
    assert_eq!(result.report["width"], 112);
    assert_eq!(result.report["height"], 72);
    assert_eq!(result.report["bytes"], bytes.len());
    assert_eq!(result.report["sha256"], sha256(&bytes));
    assert_eq!(result.report["evidenceRetained"], true);
    assert_eq!(
        fs::read(report_dir.path().join(EVIDENCE_NAME)).unwrap(),
        bytes
    );
}

#[test]
fn verifies_original_export_matches_measured_canvas_not_input_image_size() {
    let source = tempfile::tempdir().unwrap();
    let report_dir = tempfile::tempdir().unwrap();
    let bytes = png(528, 482);
    fs::write(source.path().join(OUTPUT_NAME), &bytes).unwrap();
    let report = json!({"geometry":geometry(528,482)});
    let result = verify_output(
        source.path(),
        &report_dir.path().join("report.json"),
        &report,
    );
    assert!(result.passed);
    assert_eq!(result.report["width"], 528);
    assert_eq!(result.report["height"], 482);
    assert_eq!(result.report["expectedCanvasWidth"], 528);
    assert_eq!(result.report["expectedCanvasHeight"], 482);
    assert_eq!(
        fs::read(report_dir.path().join(EVIDENCE_NAME)).unwrap(),
        bytes
    );
}

#[test]
fn rejects_output_over_the_existing_eight_mib_boundary_without_retaining_it() {
    let source = tempfile::tempdir().unwrap();
    let report_dir = tempfile::tempdir().unwrap();
    fs::write(
        source.path().join(OUTPUT_NAME),
        vec![0; MAX_OUTPUT_BYTES as usize + 1],
    )
    .unwrap();
    let result = verify_output(
        source.path(),
        &report_dir.path().join("report.json"),
        &json!({"geometry":geometry(112,72)}),
    );
    assert!(!result.passed);
    assert_eq!(
        result.report["errorCode"],
        "image-output-size-out-of-bounds"
    );
    assert_eq!(result.report["bytes"], Value::Null);
    assert!(!report_dir.path().join(EVIDENCE_NAME).exists());
}

#[test]
fn evidence_collision_fails_closed_and_does_not_overwrite() {
    let source = tempfile::tempdir().unwrap();
    let report_dir = tempfile::tempdir().unwrap();
    let bytes = png(200, 200);
    fs::write(source.path().join(OUTPUT_NAME), &bytes).unwrap();
    fs::write(report_dir.path().join(EVIDENCE_NAME), b"preexisting").unwrap();
    let result = verify_output(
        source.path(),
        &report_dir.path().join("report.json"),
        &json!({"geometry":geometry(200,200)}),
    );
    assert!(!result.passed);
    assert_eq!(result.report["evidenceRetained"], false);
    assert_eq!(
        result.report["errorCode"],
        "image-output-evidence-retention-failed"
    );
    assert_eq!(
        fs::read(report_dir.path().join(EVIDENCE_NAME)).unwrap(),
        b"preexisting"
    );
}

#[cfg(unix)]
#[test]
fn evidence_symlink_is_rejected_without_touching_its_target() {
    let source = tempfile::tempdir().unwrap();
    let report_dir = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let bytes = png(200, 200);
    fs::write(source.path().join(OUTPUT_NAME), &bytes).unwrap();
    let target = elsewhere.path().join("keep.png");
    fs::write(&target, b"existing-target").unwrap();
    std::os::unix::fs::symlink(&target, report_dir.path().join(EVIDENCE_NAME)).unwrap();
    let result = verify_output(
        source.path(),
        &report_dir.path().join("report.json"),
        &json!({"geometry":geometry(112,72)}),
    );
    assert!(!result.passed);
    assert_eq!(result.report["evidenceRetained"], false);
    assert_eq!(fs::read(target).unwrap(), b"existing-target");
}

#[cfg(unix)]
#[test]
fn symlinked_report_parent_cannot_escape_to_another_directory() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    fs::write(source.path().join(OUTPUT_NAME), png(200, 200)).unwrap();
    let linked_parent = parent.path().join("linked-report-dir");
    std::os::unix::fs::symlink(elsewhere.path(), &linked_parent).unwrap();
    let result = verify_output(
        source.path(),
        &linked_parent.join("report.json"),
        &json!({"geometry":geometry(200,200)}),
    );
    assert!(!result.passed);
    assert_eq!(result.report["evidenceRetained"], false);
    assert!(!elsewhere.path().join(EVIDENCE_NAME).exists());
}

#[test]
fn rejects_symlinked_source_and_preserves_evidence_error_without_deleting() {
    let source = tempfile::tempdir().unwrap();
    let report_dir = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    fs::write(elsewhere.path().join("output.png"), png(200, 200)).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        elsewhere.path().join("output.png"),
        source.path().join(OUTPUT_NAME),
    )
    .unwrap();
    #[cfg(unix)]
    {
        let result = verify_output(
            source.path(),
            &report_dir.path().join("report.json"),
            &json!({"geometry":geometry(112,72)}),
        );
        assert!(!result.passed);
        assert_eq!(result.report["errorCode"], "image-output-not-regular-file");
        assert!(!report_dir.path().join(EVIDENCE_NAME).exists());
    }
}

#[test]
fn missing_canvas_geometry_never_accepts_a_valid_decoded_image() {
    let source = tempfile::tempdir().unwrap();
    let report_dir = tempfile::tempdir().unwrap();
    let bytes = png(112, 72);
    fs::write(source.path().join(OUTPUT_NAME), &bytes).unwrap();
    let result = verify_output(
        source.path(),
        &report_dir.path().join("report.json"),
        &json!({}),
    );
    assert!(!result.passed);
    assert_eq!(
        result.report["errorCode"],
        "image-output-canvas-geometry-missing"
    );
    assert_eq!(result.report["evidenceRetained"], true);
    assert_eq!(
        fs::read(report_dir.path().join(EVIDENCE_NAME)).unwrap(),
        bytes
    );
}

#[test]
fn geometry_requires_complete_bounded_fixed_numeric_fields() {
    let good = json!({"geometry":geometry(112,72)});
    assert!(geometry_passed(&good));
    let mut unknown = good.clone();
    unknown["geometry"]["child"]["devicePixelRatio"] = Value::Null;
    assert!(!geometry_passed(&unknown));
    let mut extra = good;
    extra["geometry"]["child"]["rawPath"] = json!("private");
    assert!(!geometry_passed(&extra));
}
