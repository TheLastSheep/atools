use super::codec::{check_dimensions, decode_rgba8};
use super::store::NativeImageSnapshot;
use super::worker::CancellationToken;
use super::{EngineLimits, NativeImageError};
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::imageops::{self, FilterType};
use image::{ColorType, ImageEncoder, Rgb, RgbImage, RgbaImage};
use serde::Deserialize;
use std::io::{self, Cursor, Seek, SeekFrom, Write};

const MAX_RESIZE_STEPS: usize = 4;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub(crate) struct EncodeRequest {
    pub format: OutputFormat,
    #[serde(default)]
    pub jpeg_quality: Option<u8>,
    #[serde(default)]
    pub resize_plan: Vec<ResizeStep>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum OutputFormat {
    Png,
    Jpeg,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct ResizeStep {
    pub width: Option<u32>,
    pub height: Option<u32>,
    #[serde(default)]
    pub quality: Option<ResizeQuality>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ResizeQuality {
    Good,
    Better,
    Best,
}

pub(crate) struct EncodedImage {
    pub(crate) format: OutputFormat,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) bytes: Vec<u8>,
}

pub(crate) fn encode(
    source: &NativeImageSnapshot,
    request: &EncodeRequest,
    limits: EngineLimits,
    cancellation: &CancellationToken,
) -> Result<EncodedImage, NativeImageError> {
    let targets =
        validate_plan_for_dimensions(source.source.width, source.source.height, request, limits)?;
    if cancellation.is_cancelled() {
        return Err(NativeImageError::Cancelled);
    }
    let decoded = decode_rgba8(&source.source.bytes, limits)?;
    if decoded.format != source.source.format
        || decoded.width != source.source.width
        || decoded.height != source.source.height
    {
        return Err(NativeImageError::InvalidImage);
    }
    let mut current = decoded.rgba;
    for (step, (width, height)) in request.resize_plan.iter().zip(targets) {
        if cancellation.is_cancelled() {
            return Err(NativeImageError::Cancelled);
        }
        if (width, height) != current.dimensions() {
            let filter = filter_for(step.quality.unwrap_or(ResizeQuality::Best));
            current = imageops::resize(&current, width, height, filter);
        }
    }
    if cancellation.is_cancelled() {
        return Err(NativeImageError::Cancelled);
    }
    let (bytes, encoded_format) = match request.format {
        OutputFormat::Png => (
            encode_png(&current, limits.max_encoded_bytes)?,
            OutputFormat::Png,
        ),
        OutputFormat::Jpeg => (
            encode_jpeg(
                &current,
                request
                    .jpeg_quality
                    .ok_or(NativeImageError::InvalidRequest)?,
                limits.max_encoded_bytes,
            )?,
            OutputFormat::Jpeg,
        ),
    };
    if cancellation.is_cancelled() {
        return Err(NativeImageError::Cancelled);
    }
    Ok(EncodedImage {
        format: encoded_format,
        width: current.width(),
        height: current.height(),
        bytes,
    })
}

pub(crate) fn validate_request(request: &EncodeRequest) -> Result<(), NativeImageError> {
    if request.resize_plan.len() > MAX_RESIZE_STEPS {
        return Err(NativeImageError::InvalidRequest);
    }
    match (request.format, request.jpeg_quality) {
        (OutputFormat::Png, None) => {}
        (OutputFormat::Jpeg, Some(quality)) if quality <= 100 => {}
        _ => return Err(NativeImageError::InvalidRequest),
    }
    for step in &request.resize_plan {
        if step.width.is_none() && step.height.is_none() {
            return Err(NativeImageError::InvalidRequest);
        }
        if step.width == Some(0) || step.height == Some(0) {
            return Err(NativeImageError::DimensionsExceeded);
        }
    }
    Ok(())
}

pub(crate) fn validate_plan_for_dimensions(
    source_width: u32,
    source_height: u32,
    request: &EncodeRequest,
    limits: EngineLimits,
) -> Result<Vec<(u32, u32)>, NativeImageError> {
    validate_request(request)?;
    check_dimensions(source_width, source_height, limits)?;
    let mut current = (source_width, source_height);
    let source_pixels = u64::from(source_width)
        .checked_mul(u64::from(source_height))
        .ok_or(NativeImageError::DecodeBudgetExceeded)?;
    let source_rgba = source_pixels
        .checked_mul(4)
        .ok_or(NativeImageError::DecodeBudgetExceeded)?;
    if source_rgba > limits.controlled_pixel_bytes {
        return Err(NativeImageError::DecodeBudgetExceeded);
    }
    let mut targets = Vec::with_capacity(request.resize_plan.len());
    for step in &request.resize_plan {
        let target = target_dimensions(current.0, current.1, step)?;
        check_dimensions(target.0, target.1, limits)?;
        let source_rgba = u64::from(current.0)
            .checked_mul(u64::from(current.1))
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or(NativeImageError::DecodeBudgetExceeded)?;
        let destination_rgba = u64::from(target.0)
            .checked_mul(u64::from(target.1))
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or(NativeImageError::DecodeBudgetExceeded)?;
        if source_rgba > limits.controlled_pixel_bytes
            || destination_rgba > limits.controlled_pixel_bytes
        {
            return Err(NativeImageError::DecodeBudgetExceeded);
        }
        if current != target {
            let intermediate = u64::from(current.0)
                .checked_mul(u64::from(target.1))
                .and_then(|pixels| pixels.checked_mul(16))
                .ok_or(NativeImageError::DecodeBudgetExceeded)?;
            let working = source_rgba
                .checked_add(intermediate)
                .and_then(|bytes| bytes.checked_add(destination_rgba))
                .ok_or(NativeImageError::DecodeBudgetExceeded)?;
            if intermediate > limits.resize_temp_bytes || working > limits.resize_working_bytes {
                return Err(NativeImageError::DecodeBudgetExceeded);
            }
        }
        targets.push(target);
        current = target;
    }
    if request.format == OutputFormat::Jpeg {
        let pixels = u64::from(current.0)
            .checked_mul(u64::from(current.1))
            .ok_or(NativeImageError::DecodeBudgetExceeded)?;
        let rgb_bytes = pixels
            .checked_mul(3)
            .ok_or(NativeImageError::DecodeBudgetExceeded)?;
        let rgba_bytes = pixels
            .checked_mul(4)
            .ok_or(NativeImageError::DecodeBudgetExceeded)?;
        if rgb_bytes > limits.controlled_pixel_bytes
            || rgba_bytes.checked_add(rgb_bytes).map_or(true, |working| {
                working > limits.jpeg_conversion_working_bytes
            })
        {
            return Err(NativeImageError::DecodeBudgetExceeded);
        }
    }
    Ok(targets)
}

pub(crate) fn target_dimensions(
    source_width: u32,
    source_height: u32,
    step: &ResizeStep,
) -> Result<(u32, u32), NativeImageError> {
    match (step.width, step.height) {
        (Some(width), Some(height)) => Ok((width, height)),
        (Some(width), None) => {
            let ratio = source_width as f32 / source_height as f32;
            let factor = 1.0_f32 / ratio;
            let height = (width as f32 * factor).round();
            if !height.is_finite() || height < 1.0 || height > u32::MAX as f32 {
                return Err(NativeImageError::DimensionsExceeded);
            }
            Ok((width, height as u32))
        }
        (None, Some(height)) => {
            let ratio = source_width as f32 / source_height as f32;
            let width = (height as f32 * ratio).round();
            if !width.is_finite() || width < 1.0 || width > u32::MAX as f32 {
                return Err(NativeImageError::DimensionsExceeded);
            }
            Ok((width as u32, height))
        }
        (None, None) => Err(NativeImageError::InvalidRequest),
    }
}

fn filter_for(quality: ResizeQuality) -> FilterType {
    match quality {
        ResizeQuality::Good => FilterType::Triangle,
        ResizeQuality::Better => FilterType::CatmullRom,
        ResizeQuality::Best => FilterType::Lanczos3,
    }
}

fn encode_png(image: &RgbaImage, max_bytes: usize) -> Result<Vec<u8>, NativeImageError> {
    let mut writer = BoundedWriter::new(max_bytes);
    let result = PngEncoder::new(&mut writer).write_image(
        image.as_raw(),
        image.width(),
        image.height(),
        ColorType::Rgba8.into(),
    );
    finish_encoding(result, writer)
}

fn encode_jpeg(
    image: &RgbaImage,
    quality: u8,
    max_bytes: usize,
) -> Result<Vec<u8>, NativeImageError> {
    // JPEG requires RGB8. This conversion is at most 48 MiB; the RGBA input
    // is at most 64 MiB. The encoder's own scratch memory is codec-managed.
    let rgb: RgbImage = RgbImage::from_fn(image.width(), image.height(), |x, y| {
        let pixel = image.get_pixel(x, y);
        Rgb([pixel[0], pixel[1], pixel[2]])
    });
    let mut writer = BoundedWriter::new(max_bytes);
    let result = JpegEncoder::new_with_quality(&mut writer, quality).encode_image(&rgb);
    finish_encoding(result, writer)
}

fn finish_encoding(
    result: image::ImageResult<()>,
    writer: BoundedWriter,
) -> Result<Vec<u8>, NativeImageError> {
    if writer.overflowed {
        return Err(NativeImageError::OutputTooLarge);
    }
    result.map_err(|_| NativeImageError::EncodeFailed)?;
    let bytes = writer.cursor.into_inner();
    if bytes.len() > writer.max_bytes {
        return Err(NativeImageError::OutputTooLarge);
    }
    Ok(bytes)
}

struct BoundedWriter {
    cursor: Cursor<Vec<u8>>,
    max_bytes: usize,
    overflowed: bool,
}

impl BoundedWriter {
    fn new(max_bytes: usize) -> Self {
        Self {
            cursor: Cursor::new(Vec::with_capacity(max_bytes.min(16 * 1024))),
            max_bytes,
            overflowed: false,
        }
    }
}

impl Write for BoundedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let position = usize::try_from(self.cursor.position()).unwrap_or(usize::MAX);
        if position.saturating_add(bytes.len()) > self.max_bytes {
            self.overflowed = true;
            return Err(io::Error::new(io::ErrorKind::Other, "bounded image output"));
        }
        self.cursor.write(bytes)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.cursor.flush()
    }
}

impl Seek for BoundedWriter {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        let next = match position {
            SeekFrom::Start(offset) => Some(offset),
            SeekFrom::End(offset) => {
                (self.cursor.get_ref().len() as u64).checked_add_signed(offset)
            }
            SeekFrom::Current(offset) => self.cursor.position().checked_add_signed(offset),
        };
        let Some(next) = next else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "bounded image output",
            ));
        };
        if next > self.max_bytes as u64 {
            self.overflowed = true;
            return Err(io::Error::new(io::ErrorKind::Other, "bounded image output"));
        }
        self.cursor.seek(position)
    }
}

#[cfg(test)]
mod tests {
    use super::BoundedWriter;
    use std::io::Write;

    #[test]
    fn bounded_writer_rejects_overflow_and_reports_exactly_capped_bytes() {
        let mut writer = BoundedWriter::new(3);
        assert_eq!(writer.write(b"abc").unwrap(), 3);
        assert!(writer.write(b"d").is_err());
        assert!(writer.overflowed);
        assert_eq!(writer.cursor.get_ref(), b"abc");
    }
}
