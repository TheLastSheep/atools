//! Ephemeral, bounded system-image reads. OS provider allocation is not bounded here.
use super::clipboard::ClipboardAccess;
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Limits};
use serde_json::{json, Value};
use std::{
    future::Future,
    io::{self, Cursor, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
    time::Duration,
};
use tokio::sync::Semaphore;

pub(super) const MAX_ENCODED_INPUT: usize = 4 * 1024 * 1024;
pub(super) const MAX_PNG_OUTPUT: usize = 512 * 1024;
const MAX_SIDE: u32 = 8192;
const MAX_PIXELS: u64 = 16_000_000;
const DECODER_ALLOC_BEST_EFFORT: u64 = 64 * 1024 * 1024;
const MAX_SUCCESS_ENVELOPE: usize = 700 * 1024;
const IMAGE_WAIT: Duration = Duration::from_millis(1_000);

#[derive(Clone, Copy, Debug)]
pub enum EncodedImageFormat {
    Png,
    Jpeg,
    Tiff,
}

#[allow(dead_code)]
pub enum ImageSource {
    Encoded {
        bytes: Vec<u8>,
        format: EncodedImageFormat,
    },
    Rgba {
        bytes: Vec<u8>,
        width: u32,
        height: u32,
    },
}

pub(super) fn read_system(_app: &tauri::AppHandle) -> Result<Option<ImageSource>, String> {
    #[cfg(target_os = "macos")]
    {
        read_macos()
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        // The plugin has already obtained an owned provider image before these limits run.
        let image = _app
            .clipboard()
            .read_image()
            .map_err(|_| "Native clipboard image read failed".to_string())?;
        let (width, height) = (image.width(), image.height());
        validate_dimensions(width, height)?;
        let expected = rgba_bytes(width, height)?;
        let rgba = image.rgba();
        if rgba.len() != expected {
            return Err("Native clipboard image is invalid".into());
        }
        Ok(Some(ImageSource::Rgba {
            bytes: rgba.to_vec(),
            width,
            height,
        }))
    }
}

#[cfg(target_os = "macos")]
fn read_macos() -> Result<Option<ImageSource>, String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeTIFF};
    use objc2_foundation::NSString;

    let pasteboard = NSPasteboard::generalPasteboard();
    let jpeg_type = NSString::from_str("public.jpeg");
    for (paste_type, format) in [
        (unsafe { NSPasteboardTypePNG }, EncodedImageFormat::Png),
        (&*jpeg_type, EncodedImageFormat::Jpeg),
        (unsafe { NSPasteboardTypeTIFF }, EncodedImageFormat::Tiff),
    ] {
        if let Some(data) = pasteboard.dataForType(paste_type) {
            // `dataForType` can materialize provider data before this length check.
            if data.len() > MAX_ENCODED_INPUT {
                return Err("Native clipboard image exceeds the encoded-input limit".into());
            }
            return Ok(Some(ImageSource::Encoded {
                bytes: data.to_vec(),
                format,
            }));
        }
    }
    Ok(None)
}

#[cfg(test)]
pub(super) fn exact_read(backend: &dyn ClipboardAccess) -> Result<Value, String> {
    exact_read_cancellable(backend, None)
}

pub(super) fn exact_read_cancellable(
    backend: &dyn ClipboardAccess,
    cancelled: Option<&AtomicBool>,
) -> Result<Value, String> {
    let source = backend
        .read_image()
        .map_err(|_| "Native clipboard image read failed".to_string())?;
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err("Clipboard image request was cancelled".into());
    }
    let Some(source) = source else {
        return Ok(Value::Null);
    };
    let (png, width, height) = normalize(source)?;
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err("Clipboard image request was cancelled".into());
    }
    success_value(&png, width, height, MAX_SUCCESS_ENVELOPE)
}

pub(super) fn success_value(
    png: &[u8],
    width: u32,
    height: u32,
    envelope_limit: usize,
) -> Result<Value, String> {
    if png.len() > MAX_PNG_OUTPUT {
        return Err("Native clipboard PNG exceeds the output limit".into());
    }
    let data_url_len = "data:image/png;base64,".len() + png.len().div_ceil(3) * 4;
    if data_url_len > envelope_limit {
        return Err("Native clipboard image exceeds the response limit".into());
    }
    let data_url = format!("data:image/png;base64,{}", STANDARD.encode(png));
    let result = json!({"dataUrl":data_url,"width":width,"height":height});
    let envelope = serde_json::to_vec(&json!({"ok":true,"result":result}))
        .map_err(|_| "Native clipboard image response is invalid".to_string())?;
    if envelope.len() > envelope_limit {
        return Err("Native clipboard image exceeds the response limit".into());
    }
    Ok(result)
}

pub(super) fn normalize(source: ImageSource) -> Result<(Vec<u8>, u32, u32), String> {
    let image = match source {
        ImageSource::Encoded { bytes, format } => {
            if bytes.is_empty() || bytes.len() > MAX_ENCODED_INPUT {
                return Err("Native clipboard image exceeds the encoded-input limit".into());
            }
            let format = match format {
                EncodedImageFormat::Png => ImageFormat::Png,
                EncodedImageFormat::Jpeg => ImageFormat::Jpeg,
                EncodedImageFormat::Tiff => ImageFormat::Tiff,
            };
            let mut limits = Limits::default();
            limits.max_image_width = Some(MAX_SIDE);
            limits.max_image_height = Some(MAX_SIDE);
            limits.max_alloc = Some(DECODER_ALLOC_BEST_EFFORT);
            let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
            reader.limits(limits);
            let decoder = reader
                .into_decoder()
                .map_err(|_| "Native clipboard image encoding is invalid".to_string())?;
            let (width, height) = decoder.dimensions();
            validate_dimensions(width, height)?;
            image::DynamicImage::from_decoder(decoder)
                .map_err(|_| "Native clipboard image encoding is invalid".to_string())?
        }
        ImageSource::Rgba {
            bytes,
            width,
            height,
        } => {
            validate_dimensions(width, height)?;
            if bytes.len() != rgba_bytes(width, height)? {
                return Err("Native clipboard image is invalid".into());
            }
            image::DynamicImage::ImageRgba8(
                image::RgbaImage::from_raw(width, height, bytes)
                    .ok_or("Native clipboard image is invalid")?,
            )
        }
    };
    let (width, height) = (image.width(), image.height());
    validate_dimensions(width, height)?;
    let mut output = BoundedBuffer::default();
    // This caps the app-owned output Vec; the image/PNG codec may use internal buffers.
    if image::codecs::png::PngEncoder::new(&mut output)
        .write_image(image.as_bytes(), width, height, image.color().into())
        .is_err()
    {
        return Err(if output.overflowed {
            "Native clipboard PNG exceeds the output limit".into()
        } else {
            "Native clipboard PNG encoding failed".into()
        });
    }
    Ok((output.bytes, width, height))
}

pub(super) fn validate_dimensions(width: u32, height: u32) -> Result<(), String> {
    if width == 0
        || height == 0
        || width > MAX_SIDE
        || height > MAX_SIDE
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err("Native clipboard image dimensions exceed the limit".into());
    }
    Ok(())
}

fn rgba_bytes(width: u32, height: u32) -> Result<usize, String> {
    usize::try_from(u64::from(width) * u64::from(height) * 4)
        .map_err(|_| "Native clipboard image is invalid".to_string())
}

#[derive(Default)]
struct BoundedBuffer {
    bytes: Vec<u8>,
    overflowed: bool,
}
impl Write for BoundedBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let Some(next) = self
            .bytes
            .len()
            .checked_add(bytes.len())
            .filter(|size| *size <= MAX_PNG_OUTPUT)
        else {
            self.overflowed = true;
            return Err(io::Error::new(io::ErrorKind::Other, "image output cap"));
        };
        let written = bytes.len();
        self.bytes.extend_from_slice(bytes);
        debug_assert_eq!(self.bytes.len(), next);
        Ok(written)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(super) struct ImageJobGate(Arc<Semaphore>);
impl ImageJobGate {
    pub(super) fn new() -> Self {
        Self(Arc::new(Semaphore::new(1)))
    }
    #[cfg(test)]
    pub(super) async fn wait_until_released(&self) {
        drop(
            self.0
                .clone()
                .acquire_owned()
                .await
                .expect("image slot remains open"),
        );
    }
}

static IMAGE_GATE: OnceLock<Arc<ImageJobGate>> = OnceLock::new();
pub(super) fn system_gate() -> Arc<ImageJobGate> {
    IMAGE_GATE
        .get_or_init(|| Arc::new(ImageJobGate::new()))
        .clone()
}

struct CancelWhenDropped(Arc<AtomicBool>);
impl Drop for CancelWhenDropped {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

pub(super) async fn run_limited<T, F>(
    gate: Arc<ImageJobGate>,
    deadline: impl Future<Output = ()> + Send,
    work: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(Arc<AtomicBool>) -> Result<T, String> + Send + 'static,
{
    let permit = gate
        .0
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Native clipboard image operation is busy".to_string())?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let _cancel_on_drop = CancelWhenDropped(cancelled.clone());
    let job = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        work(cancelled)
    });
    tokio::select! {
        result = job => result.map_err(|_| "Native clipboard image worker failed".to_string())?,
        _ = deadline => Err("Native clipboard image operation timed out".into()),
    }
}

pub(super) async fn run_system_limited<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(Arc<AtomicBool>) -> Result<T, String> + Send + 'static,
{
    run_limited(system_gate(), tokio::time::sleep(IMAGE_WAIT), work).await
}
