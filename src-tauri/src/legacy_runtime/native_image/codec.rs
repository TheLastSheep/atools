use super::{EngineLimits, NativeImageError};
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits, RgbaImage};
use std::io::Cursor;

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SourceFormat {
    Png,
    Jpeg,
    Webp,
    Tiff,
}

impl SourceFormat {
    fn image_format(self) -> ImageFormat {
        match self {
            Self::Png => ImageFormat::Png,
            Self::Jpeg => ImageFormat::Jpeg,
            Self::Webp => ImageFormat::WebP,
            Self::Tiff => ImageFormat::Tiff,
        }
    }

    fn from_image_format(format: ImageFormat) -> Result<Self, NativeImageError> {
        match format {
            ImageFormat::Png => Ok(Self::Png),
            ImageFormat::Jpeg => Ok(Self::Jpeg),
            ImageFormat::WebP => Ok(Self::Webp),
            ImageFormat::Tiff => Ok(Self::Tiff),
            _ => Err(NativeImageError::UnsupportedFormat),
        }
    }
}

pub(crate) struct DecodedSource {
    pub(crate) format: SourceFormat,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) rgba: RgbaImage,
}

pub(crate) fn validate_source(
    bytes: &[u8],
    limits: EngineLimits,
) -> Result<(SourceFormat, u32, u32), NativeImageError> {
    let decoded = decode_rgba8(bytes, limits)?;
    Ok((decoded.format, decoded.width, decoded.height))
}

pub(crate) fn decode_rgba8(
    bytes: &[u8],
    limits: EngineLimits,
) -> Result<DecodedSource, NativeImageError> {
    if bytes.is_empty() || bytes.len() > limits.max_source_bytes {
        return Err(NativeImageError::SourceTooLarge);
    }
    let guessed = image::guess_format(bytes).map_err(|_| NativeImageError::InvalidImage)?;
    let format = SourceFormat::from_image_format(guessed)?;
    if format == SourceFormat::Png {
        super::png_validation::validate_png_structure(bytes)
            .map_err(|_| NativeImageError::InvalidImage)?;
    }
    let mut decoder_limits = Limits::default();
    decoder_limits.max_image_width = Some(limits.max_side);
    decoder_limits.max_image_height = Some(limits.max_side);
    decoder_limits.max_alloc = Some(limits.decoder_alloc_bytes);
    // Limits are installed on the reader before into_decoder. PNG's decoder
    // captures its allocation limit during construction.
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format.image_format());
    reader.limits(decoder_limits);
    let decoder = reader.into_decoder().map_err(map_decoder_error)?;
    let (width, height) = decoder.dimensions();
    check_dimensions(width, height, limits)?;
    let decoded_bytes = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|pixels| pixels.checked_mul(u64::from(decoder.color_type().bytes_per_pixel())))
        .ok_or(NativeImageError::DecodeBudgetExceeded)?;
    if decoded_bytes > limits.controlled_pixel_bytes {
        return Err(NativeImageError::DecodeBudgetExceeded);
    }
    let rgba_bytes = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or(NativeImageError::DecodeBudgetExceeded)?;
    if rgba_bytes > limits.controlled_pixel_bytes {
        return Err(NativeImageError::DecodeBudgetExceeded);
    }
    if decoded_bytes
        .checked_add(rgba_bytes)
        .map_or(true, |working| working > limits.decode_working_bytes)
    {
        return Err(NativeImageError::DecodeBudgetExceeded);
    }
    let dynamic = DynamicImage::from_decoder(decoder).map_err(map_decoder_error)?;
    let rgba = dynamic.into_rgba8();
    Ok(DecodedSource {
        format,
        width,
        height,
        rgba,
    })
}

pub(crate) fn check_dimensions(
    width: u32,
    height: u32,
    limits: EngineLimits,
) -> Result<(), NativeImageError> {
    if width == 0 || height == 0 || width > limits.max_side || height > limits.max_side {
        return Err(NativeImageError::DimensionsExceeded);
    }
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or(NativeImageError::DimensionsExceeded)?;
    if pixels > limits.max_pixels {
        return Err(NativeImageError::DimensionsExceeded);
    }
    Ok(())
}

fn map_decoder_error(error: image::ImageError) -> NativeImageError {
    match error {
        image::ImageError::Limits(limit) => match limit.kind() {
            image::error::LimitErrorKind::DimensionError => NativeImageError::DimensionsExceeded,
            image::error::LimitErrorKind::InsufficientMemory => {
                NativeImageError::DecodeBudgetExceeded
            }
            _ => NativeImageError::DecodeBudgetExceeded,
        },
        image::ImageError::Unsupported(_) => NativeImageError::UnsupportedFormat,
        _ => NativeImageError::InvalidImage,
    }
}
