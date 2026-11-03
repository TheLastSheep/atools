//! Bounded decode and one-shot native writes for plugin-supplied PNG images.
use super::clipboard::ClipboardAccess;
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{ImageDecoder, ImageFormat, ImageReader, Limits};
use serde_json::Value;
use std::{
    io::Cursor,
    sync::atomic::{AtomicBool, Ordering},
};

pub(super) const PNG_DATA_URL_PREFIX: &str = "data:image/png;base64,";
pub(super) const MAX_PNG_BYTES: usize = 512 * 1024;
pub(super) const MAX_DATA_URL_BYTES: usize =
    PNG_DATA_URL_PREFIX.len() + MAX_PNG_BYTES.div_ceil(3) * 4;
const MAX_SIDE: u32 = 8192;
const MAX_PIXELS: u64 = 16_000_000;
const MAX_DECODE_ALLOC: u64 = 64 * 1024 * 1024;
pub(super) const MAX_REQUEST_ENVELOPE_BYTES: usize = 700 * 1024;

pub(crate) struct ImageWriteRequest {
    data_url: String,
    width: u32,
    height: u32,
}

impl ImageWriteRequest {
    pub(super) fn parse(value: &Value) -> Result<Self, String> {
        let fields = value.as_object().ok_or("Invalid clipboard image")?;
        if fields.len() != 3 {
            return Err("Clipboard image must contain dataUrl, width, and height".into());
        }
        let data_url = fields
            .get("dataUrl")
            .and_then(Value::as_str)
            .ok_or("Invalid clipboard image")?;
        if data_url.len() > MAX_DATA_URL_BYTES {
            return Err("Clipboard image exceeds the PNG limit".into());
        }
        let width = fields
            .get("width")
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
            .ok_or("Invalid clipboard image dimensions")?;
        let height = fields
            .get("height")
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
            .ok_or("Invalid clipboard image dimensions")?;
        validate_dimensions(width, height)?;
        Ok(Self {
            data_url: data_url.to_owned(),
            width,
            height,
        })
    }
}

pub(crate) struct RgbaClipboardImage {
    pub(super) rgba: Vec<u8>,
    pub(super) width: u32,
    pub(super) height: u32,
}

pub(super) fn decode(request: &ImageWriteRequest) -> Result<RgbaClipboardImage, String> {
    let encoded = request
        .data_url
        .strip_prefix(PNG_DATA_URL_PREFIX)
        .ok_or("Clipboard image must be a PNG data URL")?;
    if encoded.is_empty() || request.data_url.len() > MAX_DATA_URL_BYTES {
        return Err("Clipboard image exceeds the PNG limit".into());
    }
    let png = STANDARD
        .decode(encoded)
        .map_err(|_| "Clipboard image encoding is invalid".to_string())?;
    if png.is_empty() || png.len() > MAX_PNG_BYTES || STANDARD.encode(&png) != encoded {
        return Err("Clipboard image encoding is invalid".into());
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    let mut reader = ImageReader::with_format(Cursor::new(png), ImageFormat::Png);
    reader.limits(limits);
    let decoder = reader
        .into_decoder()
        .map_err(|_| "Clipboard PNG is invalid".to_string())?;
    let (decoded_width, decoded_height) = decoder.dimensions();
    validate_dimensions(decoded_width, decoded_height)?;
    if (decoded_width, decoded_height) != (request.width, request.height) {
        return Err("Clipboard image dimensions do not match the PNG".into());
    }
    let rgba = image::DynamicImage::from_decoder(decoder)
        .map_err(|_| "Clipboard PNG is invalid".to_string())?
        .into_rgba8();
    let expected = usize::try_from(u64::from(request.width) * u64::from(request.height) * 4)
        .map_err(|_| "Clipboard image dimensions are invalid".to_string())?;
    if rgba.as_raw().len() != expected {
        return Err("Clipboard PNG is invalid".into());
    }
    Ok(RgbaClipboardImage {
        rgba: rgba.into_raw(),
        width: request.width,
        height: request.height,
    })
}

pub(super) fn write_decoded(
    backend: &dyn ClipboardAccess,
    image: RgbaClipboardImage,
    cancelled: &AtomicBool,
    authorized: impl FnOnce() -> bool,
) -> Result<(), String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("Clipboard image request was cancelled".into());
    }
    if !authorized() {
        return Err("Clipboard session closed or access revoked".into());
    }
    if cancelled.load(Ordering::Acquire) {
        return Err("Clipboard image request was cancelled".into());
    }
    backend
        .write_image(image)
        .map_err(|_| "Native clipboard image write failed".to_string())?;
    if cancelled.load(Ordering::Acquire) {
        return Err("Clipboard image request was cancelled".into());
    }
    Ok(())
}

fn validate_dimensions(width: u32, height: u32) -> Result<(), String> {
    if width == 0
        || height == 0
        || width > MAX_SIDE
        || height > MAX_SIDE
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err("Clipboard image dimensions exceed the limit".into());
    }
    Ok(())
}
