//! Bounded verifier and evidence retention for the original Image-Toolbox export.
use image::{ImageFormat, ImageReader, Limits};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Cursor, Read, Seek, SeekFrom, Write},
    path::Path,
};

const OUTPUT_NAME: &str = "image-toolbox-export.png";
const EVIDENCE_NAME: &str = "image-toolbox-export.png";
const MAX_OUTPUT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_DECODE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 8192;

pub(super) struct OutputVerification {
    pub(super) passed: bool,
    pub(super) report: Value,
}

struct DecodedPng {
    width: u32,
    height: u32,
}

/// Reads and fully decodes the original output, then retains identical bytes beside the report.
/// Both source and evidence are bounded regular files; an existing destination is never replaced.
pub(super) fn verify_output(
    root: &Path,
    report_path: &Path,
    smoke_report: &Value,
) -> OutputVerification {
    let mut report = json!({
        "passed": false,
        "bytes": null,
        "sha256": null,
        "width": null,
        "height": null,
        "errorCode": null,
        "evidenceFile": EVIDENCE_NAME,
        "evidenceRetained": false,
        "evidenceErrorCode": null
    });
    let path = root.join(OUTPUT_NAME);
    let bytes = match read_bounded_output(&path) {
        Ok(bytes) => bytes,
        Err(code) => {
            report["errorCode"] = json!(code);
            return OutputVerification {
                passed: false,
                report,
            };
        }
    };
    report["bytes"] = json!(bytes.len());
    report["sha256"] = json!(sha256(&bytes));

    let retained = match retain_sibling(report_path, &bytes) {
        Ok(()) => true,
        Err(code) => {
            report["evidenceErrorCode"] = json!(code);
            false
        }
    };
    report["evidenceRetained"] = json!(retained);

    let decoded = match decode_png(&bytes) {
        Ok(decoded) => decoded,
        Err(code) => {
            report["errorCode"] = json!(code);
            return OutputVerification {
                passed: false,
                report,
            };
        }
    };
    report["width"] = json!(decoded.width);
    report["height"] = json!(decoded.height);
    let expected = canvas_dimensions(smoke_report);
    report["expectedCanvasWidth"] = expected.map(|value| value.0.into()).unwrap_or(Value::Null);
    report["expectedCanvasHeight"] = expected.map(|value| value.1.into()).unwrap_or(Value::Null);
    let dimensions_match = expected == Some((decoded.width, decoded.height));
    if expected.is_none() {
        report["errorCode"] = json!("image-output-canvas-geometry-missing");
    } else if !dimensions_match {
        report["errorCode"] = json!("image-output-canvas-dimensions-mismatch");
    } else if !retained {
        report["errorCode"] = json!("image-output-evidence-retention-failed");
    }
    let passed = dimensions_match && retained;
    report["passed"] = json!(passed);
    OutputVerification { passed, report }
}

fn read_bounded_output(path: &Path) -> Result<Vec<u8>, &'static str> {
    let path_metadata = fs::symlink_metadata(path).map_err(|_| "image-output-missing")?;
    if path_metadata.file_type().is_symlink() || !path_metadata.is_file() {
        return Err("image-output-not-regular-file");
    }
    if path_metadata.len() == 0 || path_metadata.len() > MAX_OUTPUT_BYTES {
        return Err("image-output-size-out-of-bounds");
    }
    let mut file = File::open(path).map_err(|_| "image-output-open-failed")?;
    let opened_metadata = file.metadata().map_err(|_| "image-output-stat-failed")?;
    if !opened_metadata.is_file() || opened_metadata.len() != path_metadata.len() {
        return Err("image-output-changed-during-open");
    }
    let mut bytes = Vec::with_capacity(opened_metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(MAX_OUTPUT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "image-output-read-failed")?;
    if bytes.len() as u64 != opened_metadata.len() || bytes.len() as u64 > MAX_OUTPUT_BYTES {
        return Err("image-output-changed-during-read");
    }
    Ok(bytes)
}

fn retain_sibling(report_path: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_OUTPUT_BYTES {
        return Err("image-output-size-out-of-bounds");
    }
    let report_parent = report_path
        .parent()
        .ok_or("image-output-evidence-parent-invalid")?;
    let parent_meta =
        fs::symlink_metadata(report_parent).map_err(|_| "image-output-evidence-parent-invalid")?;
    if parent_meta.file_type().is_symlink() || !parent_meta.is_dir() {
        return Err("image-output-evidence-parent-invalid");
    }
    let canonical_parent = report_parent
        .canonicalize()
        .map_err(|_| "image-output-evidence-parent-invalid")?;
    let destination = canonical_parent.join(EVIDENCE_NAME);
    if fs::symlink_metadata(&destination).is_ok() {
        return Err("image-output-evidence-already-exists");
    }
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&destination)
        .map_err(|_| "image-output-evidence-create-failed")?;
    file.write_all(bytes)
        .map_err(|_| "image-output-evidence-write-failed")?;
    file.sync_all()
        .map_err(|_| "image-output-evidence-write-failed")?;
    let opened_metadata = file
        .metadata()
        .map_err(|_| "image-output-evidence-stat-failed")?;
    if !opened_metadata.is_file() || opened_metadata.len() != bytes.len() as u64 {
        return Err("image-output-evidence-mismatch");
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|_| "image-output-evidence-read-failed")?;
    let mut buffer = [0u8; 8192];
    let mut offset = 0usize;
    let mut hash = Sha256::new();
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "image-output-evidence-read-failed")?;
        if count == 0 {
            break;
        }
        let end = offset.saturating_add(count);
        if end > bytes.len() || bytes[offset..end] != buffer[..count] {
            return Err("image-output-evidence-mismatch");
        }
        hash.update(&buffer[..count]);
        offset = end;
    }
    if offset != bytes.len() || format!("{:x}", hash.finalize()) != sha256(bytes) {
        return Err("image-output-evidence-mismatch");
    }
    drop(file);
    let actual_parent = destination
        .parent()
        .and_then(|parent| parent.canonicalize().ok());
    if actual_parent.as_deref() != Some(canonical_parent.as_path()) {
        return Err("image-output-evidence-parent-invalid");
    }
    let metadata =
        fs::symlink_metadata(&destination).map_err(|_| "image-output-evidence-stat-failed")?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() != bytes.len() as u64
    {
        return Err("image-output-evidence-mismatch");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.dev() != opened_metadata.dev() || metadata.ino() != opened_metadata.ino() {
            return Err("image-output-evidence-mismatch");
        }
    }
    Ok(())
}

fn decode_png(bytes: &[u8]) -> Result<DecodedPng, &'static str> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_OUTPUT_BYTES {
        return Err("image-output-size-out-of-bounds");
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), ImageFormat::Png);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|_| "image-output-png-decode-failed")?;
    let rgba_bytes = u64::from(image.width())
        .checked_mul(u64::from(image.height()))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or("image-output-decode-budget-exceeded")?;
    if rgba_bytes > MAX_DECODE_BYTES {
        return Err("image-output-decode-budget-exceeded");
    }
    Ok(DecodedPng {
        width: image.width(),
        height: image.height(),
    })
}

fn canvas_dimensions(report: &Value) -> Option<(u32, u32)> {
    let canvas = report.get("geometry")?.get("canvas")?;
    let width = bounded_dimension(canvas.get("width"))?;
    let height = bounded_dimension(canvas.get("height"))?;
    Some((width, height))
}

fn bounded_dimension(value: Option<&Value>) -> Option<u32> {
    let value = value?.as_f64()?;
    if !value.is_finite()
        || value < 1.0
        || value > f64::from(MAX_IMAGE_DIMENSION)
        || value.fract() != 0.0
    {
        return None;
    }
    Some(value as u32)
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Accepts only the fixed numeric geometry schema; unavailable values remain explicit nulls.
pub(super) fn geometry_passed(report: &Value) -> bool {
    let Some(geometry) = report.get("geometry").and_then(Value::as_object) else {
        return false;
    };
    exact_keys(geometry, &["canvas", "container", "child"])
        && canvas_valid(geometry.get("canvas").unwrap())
        && container_valid(geometry.get("container").unwrap())
        && child_valid(geometry.get("child").unwrap())
}

fn exact_keys(value: &Map<String, Value>, keys: &[&str]) -> bool {
    value.len() == keys.len() && keys.iter().all(|key| value.contains_key(*key))
}
fn object_with_keys<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Map<String, Value>> {
    let object = value.as_object()?;
    exact_keys(object, keys).then_some(object)
}
fn number(value: &Value, min: f64, max: f64) -> bool {
    value
        .as_f64()
        .is_some_and(|value| value.is_finite() && value >= min && value <= max)
}
fn canvas_valid(value: &Value) -> bool {
    let Some(fields) = object_with_keys(value, &["width", "height", "zoom"]) else {
        return false;
    };
    number(&fields["width"], 1.0, 8192.0)
        && number(&fields["height"], 1.0, 8192.0)
        && number(&fields["zoom"], 0.01, 100.0)
}
fn container_valid(value: &Value) -> bool {
    let Some(fields) = object_with_keys(
        value,
        &["left", "top", "right", "bottom", "width", "height"],
    ) else {
        return false;
    };
    number(&fields["left"], -1_000_000.0, 1_000_000.0)
        && number(&fields["top"], -1_000_000.0, 1_000_000.0)
        && number(&fields["right"], -1_000_000.0, 1_000_000.0)
        && number(&fields["bottom"], -1_000_000.0, 1_000_000.0)
        && number(&fields["width"], 1.0, 32768.0)
        && number(&fields["height"], 1.0, 32768.0)
}
fn child_valid(value: &Value) -> bool {
    let Some(fields) = object_with_keys(value, &["innerWidth", "innerHeight", "devicePixelRatio"])
    else {
        return false;
    };
    number(&fields["innerWidth"], 1.0, 32768.0)
        && number(&fields["innerHeight"], 1.0, 32768.0)
        && number(&fields["devicePixelRatio"], 0.1, 16.0)
}

#[cfg(test)]
#[path = "desktop_smoke_native_image_toolbox_artifact_tests.rs"]
mod tests;
