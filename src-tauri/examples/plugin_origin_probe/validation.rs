//! The Rust side verifies native command entry and independently decodes actual PNGs.
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

const CHECKS: [&str; 11] = [
    "originsNonOpaqueAndDistinct",
    "originsMatchExpected",
    "parentDomDenied",
    "siblingDomDenied",
    "noChildTauri",
    "nestedCloneWorks",
    "html2canvasRendered",
    "foreignWindowProxyStable",
    "foreignOriginChanged",
    "foreignRejectedByOldIdentity",
    "parentPositiveControlWorks",
];

pub fn validate(
    mut report: Value,
    frames: &[Value],
    entered: &[String],
    output: &Path,
    run_id: &str,
) -> Value {
    let mut errors = Vec::<String>::new();
    let mut images = Vec::new();
    if entered != ["parent-positive"] {
        errors.push("Unexpected native benign command entry".into());
    }
    if report["checks"]
        .as_object()
        .is_none_or(|c| c.len() != CHECKS.len())
    {
        errors.push("Browser check schema is incomplete".into());
    }
    for check in CHECKS {
        if report["checks"][check] != true {
            errors.push(format!("Browser invariant failed: {check}"));
        }
    }
    if report["status"] != "complete" || report["errors"].as_array().is_none_or(|e| !e.is_empty()) {
        errors.push("Browser run did not complete without errors".into());
    }
    let storage_isolated = report["classifications"]["storage"] == "observed-isolated";
    let storage_denied = report["children"].as_array().is_some_and(|children| {
        children.len() == 3
            && children.iter().all(|child| {
                child["initial"]["storageWrite"]["available"] == false
                    && child["storage"]["available"] == false
            })
    });
    if !storage_isolated && !storage_denied {
        errors.push("Independent-origin storage behavior remains unverified or shared".into());
    }
    if let Some(children) = report["children"].as_array_mut() {
        if children.len() != 3 {
            errors.push("Expected three independent child instances".into());
        }
        for (index, expected) in frames.iter().enumerate() {
            let Some(child) = children.get_mut(index) else {
                continue;
            };
            if child["id"] != expected["id"]
                || child["initialEventOrigin"] != expected["expectedOrigin"]
            {
                errors.push(format!("Actual child identity/origin mismatch at {index}"));
            }
            let canvas = &mut child["initial"]["canvas"];
            let encoded = canvas.as_object_mut().and_then(|c| c.remove("pngBase64"));
            let decoded = encoded
                .as_ref()
                .and_then(Value::as_str)
                .filter(|s| s.len() <= 96 * 1024)
                .and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
            let evidence = decoded.as_ref().and_then(|bytes| {
                if bytes.len() > 64 * 1024 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") { return None }
                let reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), image::ImageFormat::Png);
                if reader.into_dimensions().ok()? != (128,48) { return None }
                let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), image::ImageFormat::Png);
                let mut limits = image::Limits::default();
                limits.max_image_width=Some(128); limits.max_image_height=Some(48); limits.max_alloc=Some(64 * 1024);
                reader.limits(limits);
                let image = reader.decode().ok()?.to_rgba8();
                let background = image.get_pixel(1, 1).0;
                let swatch = image.get_pixel(12, 12).0;
                if background != [18,52,86,255] || swatch != [255,102,0,255] { return None }
                let path = output.parent()?.join(format!("origin-{run_id}-{}.png", expected["id"].as_str()?));
                let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).ok()?;
                std::io::Write::write_all(&mut file, bytes).ok()?;
                Some(json!({"independentPngDecode":true,"width":128,"height":48,"bytes":bytes.len(),
                    "backgroundPixel":background,"swatchPixel":swatch,"sha256":format!("{:x}",Sha256::digest(bytes)),"artifact":path}))
            });
            if let Some(evidence) = evidence {
                images.push(evidence);
            } else {
                errors.push(format!(
                    "Independent html2canvas PNG verification failed at {index}"
                ));
            }
        }
    } else {
        errors.push("No child browser observations".into());
    }
    json!({"status":if errors.is_empty(){"pass"}else{"failed"},"productionReady":false,
        "scope":"Synthetic native WKWebView origin/clone feasibility only. No original plugin page, production bridge or system capability is exercised.",
        "errors":errors,"nativeBenignEntries":entered,"nativeBenignObservationBoundary":"Only this bounded run through its late snapshot; missing callbacks are not rejection evidence",
        "pngEvidence":images,"browser":report,
        "remaining":["Generation-bound generated-page authorization and revocation","Exact Origin/CORS for four production transports","Per-document bridge tokens, navigation and pending permission/result invalidation","BrowserWindow children, storage/worker budgets and cross-platform runtime","Original file-tree save/PNG acceptance and production performance"]})
}
