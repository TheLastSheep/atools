use super::*;
use std::io::Cursor;

fn encoded(format: ::image::ImageFormat) -> Vec<u8> {
    let image = ::image::DynamicImage::new_rgb8(2, 3);
    let mut out = Cursor::new(Vec::new());
    image.write_to(&mut out, format).unwrap();
    out.into_inner()
}
#[test]
fn all_supported_formats_read_dimensions_without_pixel_decode_and_preserve_data_url() {
    for (format, media) in [
        (::image::ImageFormat::Png, "image/png"),
        (::image::ImageFormat::Jpeg, "image/jpeg"),
        (::image::ImageFormat::WebP, "image/webp"),
        (::image::ImageFormat::Tiff, "image/tiff"),
    ] {
        let bytes = encoded(format);
        assert_eq!(validate_encoded(&bytes, media).unwrap(), (2, 3), "{media}");
        let url = encode_data_url(&bytes, media).unwrap();
        assert_eq!(validate_data_url(&url).unwrap(), (2, 3));
        assert_eq!(
            STANDARD.decode(url.split_once(',').unwrap().1).unwrap(),
            bytes
        );
    }
}
#[test]
fn image_envelope_size_format_and_dimension_errors_are_private_and_complete() {
    let marker = "PRIVATE_MEDIA_BODY";
    for value in [
        format!("data:text/html;base64,{marker}"),
        format!("data:image/png,{marker}"),
        format!("data:image/png;base64,{marker}"),
        format!(
            "data:image/png;base64,{}",
            "A".repeat(MAX_IMAGE_DATA_URL_BYTES)
        ),
    ] {
        let error = validate_data_url(&value).unwrap_err();
        assert!(!error.contains(marker));
        assert!(!error.contains("data:"));
    }
    let mut bytes = encoded(::image::ImageFormat::Png);
    for (width, height) in [(0, 2), (16_385, 1), (10_000, 10_000)] {
        bytes[16..20].copy_from_slice(&u32::to_be_bytes(width));
        bytes[20..24].copy_from_slice(&u32::to_be_bytes(height));
        assert!(validate_encoded(&bytes, "image/png")
            .unwrap_err()
            .starts_with("IMAGE_INPUT_BUDGET:"));
    }
    assert!(
        validate_encoded(&vec![0; MAX_IMAGE_ENCODED_BYTES + 1], "image/png")
            .unwrap_err()
            .starts_with("IMAGE_INPUT_BUDGET:")
    );
    assert!(validate_encoded(&encoded(::image::ImageFormat::Png), "image/jpeg").is_err());
}
#[test]
fn bounded_headers_reject_truncation_offsets_and_unsupported_tiff_without_panics() {
    for media in ["image/png", "image/jpeg", "image/webp", "image/tiff"] {
        for length in 0..128 {
            let b = vec![0xff; length];
            assert!(validate_encoded(&b, media).is_err());
        }
    }
    let mut tiff = encoded(::image::ImageFormat::Tiff);
    tiff[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(validate_encoded(&tiff, "image/tiff").is_err());
    let mut png = encoded(::image::ImageFormat::Png);
    png.truncate(32);
    assert!(validate_encoded(&png, "image/png").is_err());
}
