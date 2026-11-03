use std::{io::Cursor, sync::Arc, time::Duration};

use parking_lot::Mutex;
use serde_json::{json, Value};
use sha2::Digest;
use tokio::sync::oneshot;

use tauri::{Webview, Wry};

const SNAPSHOT_DEADLINE: Duration = Duration::from_secs(3);
const MAX_EDGE: u32 = 4096;
const MIN_EDGE: u32 = 16;
const MAX_DECODED_PIXELS: u64 = 8 * 1024 * 1024;
const MAX_DECODED_BYTES: u64 = MAX_DECODED_PIXELS * 4;
const MAX_PNG_BYTES: usize = 8 * 1024 * 1024;
const MAX_TIFF_BYTES: usize = 32 * 1024 * 1024;
const MAX_NATIVE_REPRESENTATIONS: usize = 32;
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

const SNAPSHOT_PLATFORM_UNAVAILABLE: &str = "settings-input-snapshot-requires-macos";
const SNAPSHOT_DISPATCH_FAILED: &str = "settings-input-snapshot-dispatch-failed";
const SNAPSHOT_TIMEOUT: &str = "settings-input-snapshot-timeout";
const SNAPSHOT_CALLBACK_INTERRUPTED: &str = "settings-input-snapshot-callback-interrupted";
const SNAPSHOT_NATIVE_FAILED: &str = "settings-input-snapshot-native-failed";
const SNAPSHOT_DIMENSIONS_INVALID: &str = "settings-input-snapshot-dimensions-invalid";
const SNAPSHOT_INTERMEDIATE_TOO_LARGE: &str = "settings-input-snapshot-intermediate-too-large";
const SNAPSHOT_ENCODING_FAILED: &str = "settings-input-snapshot-encoding-failed";
const SNAPSHOT_PNG_INVALID: &str = "settings-input-snapshot-png-invalid";
const SNAPSHOT_PNG_DECODE_FAILED: &str = "settings-input-snapshot-png-decode-failed";
const SNAPSHOT_BLANK: &str = "settings-input-snapshot-blank";

pub(super) struct CapturedSnapshot {
    pub(super) png: Vec<u8>,
    pub(super) evidence: Value,
}

type SnapshotResult = Result<CapturedSnapshot, &'static str>;
type SnapshotSender = oneshot::Sender<SnapshotResult>;
type PendingSnapshot = Arc<Mutex<Option<SnapshotSender>>>;

pub(super) async fn capture(webview: &Webview<Wry>) -> SnapshotResult {
    #[cfg(target_os = "macos")]
    {
        capture_macos(webview).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = webview;
        Err(SNAPSHOT_PLATFORM_UNAVAILABLE)
    }
}

#[cfg(target_os = "macos")]
async fn capture_macos(webview: &Webview<Wry>) -> SnapshotResult {
    let (sender, receiver) = oneshot::channel();
    let pending = Arc::new(Mutex::new(Some(sender)));
    let scheduled_pending = Arc::clone(&pending);

    tokio::time::timeout(SNAPSHOT_DEADLINE, async {
        webview
            .with_webview(move |platform| {
                use block2::RcBlock;
                use objc2::MainThreadMarker;
                use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
                use objc2_foundation::NSError;
                use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

                if !has_open_receiver(&scheduled_pending) {
                    return;
                }
                let Some(main_thread) = MainThreadMarker::new() else {
                    reject_pending(&scheduled_pending, SNAPSHOT_NATIVE_FAILED);
                    return;
                };
                let pointer = platform.inner();
                if pointer.is_null() {
                    reject_pending(&scheduled_pending, SNAPSHOT_NATIVE_FAILED);
                    return;
                }

                // Tauri provides this live WKWebView only inside the platform callback.
                let native = unsafe { &*pointer.cast::<WKWebView>() };
                let bounds = native.bounds();
                let Some(window) = native.window() else {
                    reject_pending(&scheduled_pending, SNAPSHOT_DIMENSIONS_INVALID);
                    return;
                };
                let backing_scale = window.backingScaleFactor() as f64;
                if let Err(error) = validate_point_dimensions(
                    bounds.size.width as f64,
                    bounds.size.height as f64,
                    backing_scale,
                ) {
                    reject_pending(&scheduled_pending, error);
                    return;
                }

                let configuration = unsafe { WKSnapshotConfiguration::new(main_thread) };
                unsafe { configuration.setAfterScreenUpdates(true) };
                let callback_pending = Arc::clone(&scheduled_pending);
                let completion = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                    let Some(sender) = take_pending(&callback_pending) else {
                        return;
                    };
                    if sender.is_closed() {
                        return;
                    }
                    let result = if !error.is_null() || image.is_null() {
                        Err(SNAPSHOT_NATIVE_FAILED)
                    } else if MainThreadMarker::new().is_none() {
                        Err(SNAPSHOT_NATIVE_FAILED)
                    } else {
                        // The image pointer is used only while this native completion is on stack.
                        unsafe { encode_native_image(image, backing_scale) }
                    };
                    deliver(sender, result);
                });

                // WKWebKit copies and retains this escaping completion block.
                unsafe {
                    native.takeSnapshotWithConfiguration_completionHandler(
                        Some(&configuration),
                        &completion,
                    );
                }
            })
            .map_err(|_| SNAPSHOT_DISPATCH_FAILED)?;

        receiver.await.map_err(|_| SNAPSHOT_CALLBACK_INTERRUPTED)?
    })
    .await
    .map_err(|_| SNAPSHOT_TIMEOUT)?
}

#[cfg(target_os = "macos")]
unsafe fn encode_native_image(
    image_pointer: *mut objc2_app_kit::NSImage,
    backing_scale: f64,
) -> SnapshotResult {
    use objc2::{rc::Retained, runtime::AnyObject};
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey};
    use objc2_foundation::NSDictionary;

    let image = unsafe { image_pointer.as_ref() }.ok_or(SNAPSHOT_NATIVE_FAILED)?;
    let size = image.size();
    validate_point_dimensions(size.width as f64, size.height as f64, backing_scale)?;

    let representations = image.representations();
    let representation_count =
        usize::try_from(representations.count()).map_err(|_| SNAPSHOT_DIMENSIONS_INVALID)?;
    if representation_count == 0 || representation_count > MAX_NATIVE_REPRESENTATIONS {
        return Err(SNAPSHOT_INTERMEDIATE_TOO_LARGE);
    }
    let mut representation_pixels = 0u64;
    for index in 0..representation_count {
        let representation = representations.objectAtIndex(index);
        let width = usize::try_from(representation.pixelsWide())
            .map_err(|_| SNAPSHOT_DIMENSIONS_INVALID)?;
        let height = usize::try_from(representation.pixelsHigh())
            .map_err(|_| SNAPSHOT_DIMENSIONS_INVALID)?;
        validate_pixel_dimensions(width, height)?;
        let width = u64::try_from(width).map_err(|_| SNAPSHOT_DIMENSIONS_INVALID)?;
        let height = u64::try_from(height).map_err(|_| SNAPSHOT_DIMENSIONS_INVALID)?;
        let pixels = width
            .checked_mul(height)
            .ok_or(SNAPSHOT_DIMENSIONS_INVALID)?;
        representation_pixels = representation_pixels
            .checked_add(pixels)
            .ok_or(SNAPSHOT_DIMENSIONS_INVALID)?;
        if representation_pixels > MAX_DECODED_PIXELS {
            return Err(SNAPSHOT_DIMENSIONS_INVALID);
        }
    }

    let tiff = image.TIFFRepresentation().ok_or(SNAPSHOT_NATIVE_FAILED)?;
    if tiff.len() > MAX_TIFF_BYTES {
        return Err(SNAPSHOT_INTERMEDIATE_TOO_LARGE);
    }
    let bitmap = NSBitmapImageRep::imageRepWithData(&tiff).ok_or(SNAPSHOT_NATIVE_FAILED)?;
    let pixels_wide =
        usize::try_from(bitmap.pixelsWide()).map_err(|_| SNAPSHOT_DIMENSIONS_INVALID)?;
    let pixels_high =
        usize::try_from(bitmap.pixelsHigh()).map_err(|_| SNAPSHOT_DIMENSIONS_INVALID)?;
    validate_pixel_dimensions(pixels_wide, pixels_high)?;

    let properties: Retained<NSDictionary<NSBitmapImageRepPropertyKey, AnyObject>> =
        NSDictionary::dictionary();
    // SAFETY: The empty dictionary has the exact key/value type required by AppKit.
    let png_data = unsafe {
        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &*properties)
    }
    .ok_or(SNAPSHOT_ENCODING_FAILED)?;
    if png_data.len() > MAX_PNG_BYTES {
        return Err(SNAPSHOT_INTERMEDIATE_TOO_LARGE);
    }

    let png = png_data.to_vec();
    let evidence = evidence_for_png(&png)?;
    Ok(CapturedSnapshot { png, evidence })
}

fn validate_point_dimensions(width: f64, height: f64, scale: f64) -> Result<(), &'static str> {
    if !width.is_finite()
        || !height.is_finite()
        || !scale.is_finite()
        || width <= 0.0
        || height <= 0.0
        || scale <= 0.0
        || width > f64::from(MAX_EDGE)
        || height > f64::from(MAX_EDGE)
    {
        return Err(SNAPSHOT_DIMENSIONS_INVALID);
    }
    let pixel_width = (width * scale).ceil();
    let pixel_height = (height * scale).ceil();
    if !pixel_width.is_finite()
        || !pixel_height.is_finite()
        || pixel_width < f64::from(MIN_EDGE)
        || pixel_height < f64::from(MIN_EDGE)
        || pixel_width > f64::from(MAX_EDGE)
        || pixel_height > f64::from(MAX_EDGE)
    {
        return Err(SNAPSHOT_DIMENSIONS_INVALID);
    }
    validate_pixel_dimensions(pixel_width as usize, pixel_height as usize)
}

fn validate_pixel_dimensions(width: usize, height: usize) -> Result<(), &'static str> {
    let width = u32::try_from(width).map_err(|_| SNAPSHOT_DIMENSIONS_INVALID)?;
    let height = u32::try_from(height).map_err(|_| SNAPSHOT_DIMENSIONS_INVALID)?;
    if width < MIN_EDGE || height < MIN_EDGE || width > MAX_EDGE || height > MAX_EDGE {
        return Err(SNAPSHOT_DIMENSIONS_INVALID);
    }
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or(SNAPSHOT_DIMENSIONS_INVALID)?;
    if pixels > MAX_DECODED_PIXELS {
        return Err(SNAPSHOT_DIMENSIONS_INVALID);
    }
    Ok(())
}

fn png_dimensions(bytes: &[u8]) -> Result<(u32, u32), &'static str> {
    if bytes.len() < 24
        || bytes.get(..8) != Some(PNG_SIGNATURE.as_slice())
        || bytes.get(8..12) != Some(13u32.to_be_bytes().as_slice())
        || bytes.get(12..16) != Some(b"IHDR")
    {
        return Err(SNAPSHOT_PNG_INVALID);
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().map_err(|_| SNAPSHOT_PNG_INVALID)?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().map_err(|_| SNAPSHOT_PNG_INVALID)?);
    validate_pixel_dimensions(width as usize, height as usize)?;
    Ok((width, height))
}

fn evidence_for_png(bytes: &[u8]) -> Result<Value, &'static str> {
    if bytes.len() > MAX_PNG_BYTES {
        return Err(SNAPSHOT_INTERMEDIATE_TOO_LARGE);
    }
    let (width, height) = png_dimensions(bytes)?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_EDGE);
    limits.max_image_height = Some(MAX_EDGE);
    limits.max_alloc = Some(MAX_DECODED_BYTES);
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Png);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|_| SNAPSHOT_PNG_DECODE_FAILED)?;
    if decoded.width() != width || decoded.height() != height {
        return Err(SNAPSHOT_PNG_INVALID);
    }
    let rgba = decoded.into_rgba8();
    let mut first_visible = None;
    let mut non_uniform = false;
    let mut non_transparent = false;
    for pixel in rgba.pixels() {
        let value = pixel.0;
        if value[3] == 0 {
            continue;
        }
        non_transparent = true;
        if let Some(first) = first_visible {
            if first != value {
                non_uniform = true;
                break;
            }
        } else {
            first_visible = Some(value);
        }
    }
    if !non_uniform || !non_transparent {
        return Err(SNAPSHOT_BLANK);
    }
    let png_bytes = u64::try_from(bytes.len()).map_err(|_| SNAPSHOT_INTERMEDIATE_TOO_LARGE)?;
    let sha256 = format!("{:x}", sha2::Sha256::digest(bytes));
    Ok(json!({
        "width": width,
        "height": height,
        "pngBytes": png_bytes,
        "sha256": sha256,
        "nonUniform": non_uniform,
        "nonTransparent": non_transparent
    }))
}

fn take_pending(pending: &PendingSnapshot) -> Option<SnapshotSender> {
    pending.lock().take()
}

fn has_open_receiver(pending: &PendingSnapshot) -> bool {
    let mut pending = pending.lock();
    let closed = pending
        .as_ref()
        .map(SnapshotSender::is_closed)
        .unwrap_or(true);
    if closed {
        pending.take();
    }
    !closed
}

fn reject_pending(pending: &PendingSnapshot, code: &'static str) {
    if let Some(sender) = take_pending(pending) {
        deliver(sender, Err(code));
    }
}

fn deliver(sender: SnapshotSender, result: SnapshotResult) {
    if !sender.is_closed() {
        let _ = sender.send(result);
    }
}

#[cfg(test)]
#[path = "snapshot_tests.rs"]
mod tests;
