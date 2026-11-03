use super::encoded_fixture;
use crate::legacy_runtime::native_image::codec::{check_dimensions, validate_source, SourceFormat};
use crate::legacy_runtime::native_image::{EngineLimits, NativeImageError};
use image::ImageFormat;

#[test]
fn full_decode_accepts_only_the_four_supported_formats() {
    let cases = [
        (ImageFormat::Png, SourceFormat::Png),
        (ImageFormat::Jpeg, SourceFormat::Jpeg),
        (ImageFormat::WebP, SourceFormat::Webp),
        (ImageFormat::Tiff, SourceFormat::Tiff),
    ];
    for (image_format, source_format) in cases {
        let bytes = encoded_fixture(image_format, 2, 1);
        let result = validate_source(&bytes, EngineLimits::default()).unwrap();
        assert_eq!(result, (source_format, 2, 1));
    }
}

#[test]
fn malformed_crc_and_unlisted_format_fail_closed() {
    let png = encoded_fixture(ImageFormat::Png, 2, 1);
    for chunk in [*b"IHDR", *b"IDAT", *b"IEND"] {
        let mut broken = png.clone();
        let crc = chunk_crc_offset(&broken, &chunk).expect("fixture has requested chunk");
        broken[crc] ^= 0x40;
        assert_eq!(
            validate_source(&broken, EngineLimits::default()).unwrap_err(),
            NativeImageError::InvalidImage,
            "corrupt {:?} CRC must fail before pixel decoding",
            chunk
        );
    }

    let mut truncated = png.clone();
    truncated.pop();
    assert_eq!(
        validate_source(&truncated, EngineLimits::default()).unwrap_err(),
        NativeImageError::InvalidImage
    );

    let bmp = b"BM\x00\x00\x00\x00\x00\x00";
    assert_eq!(
        validate_source(bmp, EngineLimits::default()).unwrap_err(),
        NativeImageError::UnsupportedFormat
    );
}

fn chunk_crc_offset(bytes: &[u8], wanted: &[u8; 4]) -> Option<usize> {
    let mut cursor = 8usize;
    while cursor.checked_add(12)? <= bytes.len() {
        let data_len = u32::from_be_bytes(bytes.get(cursor..cursor + 4)?.try_into().ok()?) as usize;
        let kind = bytes.get(cursor + 4..cursor + 8)?;
        let crc = cursor.checked_add(8)?.checked_add(data_len)?;
        if kind == wanted {
            return (crc.checked_add(4)? <= bytes.len()).then_some(crc);
        }
        cursor = crc.checked_add(4)?;
    }
    None
}

#[test]
fn dimensions_are_checked_before_full_pixel_decode() {
    let mut limits = EngineLimits::default();
    limits.max_side = 1;
    let source = encoded_fixture(ImageFormat::Png, 2, 1);
    assert_eq!(
        validate_source(&source, limits).unwrap_err(),
        NativeImageError::DimensionsExceeded
    );
}

#[test]
fn pixel_count_and_decode_working_set_are_preflighted() {
    assert_eq!(
        check_dimensions(4096, 4096, EngineLimits::default()),
        Err(NativeImageError::DimensionsExceeded)
    );

    let mut limits = EngineLimits::default();
    limits.decode_working_bytes = 1;
    let source = encoded_fixture(ImageFormat::Png, 1, 1);
    assert_eq!(
        validate_source(&source, limits).unwrap_err(),
        NativeImageError::DecodeBudgetExceeded
    );
}

#[test]
fn source_byte_limit_is_enforced_before_decoder_creation() {
    let mut limits = EngineLimits::default();
    limits.max_source_bytes = 8;
    assert_eq!(
        validate_source(&[0u8; 9], limits).unwrap_err(),
        NativeImageError::SourceTooLarge
    );
}
