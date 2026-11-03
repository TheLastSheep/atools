use std::io::Cursor;

use image::{DynamicImage, ImageBuffer, ImageFormat, Rgba};
use serde_json::json;

use super::{
    evidence_for_png, png_dimensions, validate_pixel_dimensions, validate_point_dimensions,
    MAX_PNG_BYTES, PNG_SIGNATURE, SNAPSHOT_BLANK, SNAPSHOT_DIMENSIONS_INVALID,
    SNAPSHOT_INTERMEDIATE_TOO_LARGE, SNAPSHOT_PNG_DECODE_FAILED, SNAPSHOT_PNG_INVALID,
};

fn encode_png(width: u32, height: u32, mut pixel: impl FnMut(u32, u32) -> [u8; 4]) -> Vec<u8> {
    let image = ImageBuffer::from_fn(width, height, |x, y| Rgba(pixel(x, y)));
    let mut output = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image)
        .write_to(&mut output, ImageFormat::Png)
        .unwrap();
    output.into_inner()
}

fn png_header(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = PNG_SIGNATURE.to_vec();
    bytes.extend_from_slice(&13u32.to_be_bytes());
    bytes.extend_from_slice(b"IHDR");
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
    bytes.extend_from_slice(&[0; 4]);
    bytes
}

#[test]
fn evidence_accepts_visible_nonuniform_png_and_returns_only_bounded_metadata() {
    let png = encode_png(24, 16, |x, _| {
        if x < 12 {
            [20, 30, 40, 255]
        } else {
            [200, 210, 220, 255]
        }
    });

    let evidence = evidence_for_png(&png).unwrap();

    assert_eq!(evidence["width"], json!(24));
    assert_eq!(evidence["height"], json!(16));
    assert_eq!(evidence["pngBytes"], json!(png.len()));
    assert_eq!(evidence["sha256"].as_str().map(str::len), Some(64));
    assert_eq!(evidence["nonUniform"], json!(true));
    assert_eq!(evidence["nonTransparent"], json!(true));
    assert_eq!(evidence.as_object().unwrap().len(), 6);
}

#[test]
fn evidence_rejects_uniform_visible_and_varying_fully_transparent_images() {
    let uniform = encode_png(16, 16, |_, _| [30, 40, 50, 255]);
    assert_eq!(evidence_for_png(&uniform), Err(SNAPSHOT_BLANK));

    let transparent = encode_png(16, 16, |x, y| [x as u8, y as u8, 100, 0]);
    assert_eq!(evidence_for_png(&transparent), Err(SNAPSHOT_BLANK));
}

#[test]
fn png_header_rejects_truncated_and_out_of_bounds_dimensions_before_decode() {
    assert_eq!(png_dimensions(b"\x89PNG"), Err(SNAPSHOT_PNG_INVALID));
    let mut truncated = png_header(16, 16);
    truncated.truncate(24);
    assert_eq!(png_dimensions(&truncated), Ok((16, 16)));
    assert_eq!(
        evidence_for_png(&truncated),
        Err(SNAPSHOT_PNG_DECODE_FAILED)
    );
    assert_eq!(
        png_dimensions(&png_header(15, 16)),
        Err(SNAPSHOT_DIMENSIONS_INVALID)
    );
    assert_eq!(
        png_dimensions(&png_header(4097, 16)),
        Err(SNAPSHOT_DIMENSIONS_INVALID)
    );
    assert_eq!(
        png_dimensions(&png_header(4096, 2049)),
        Err(SNAPSHOT_DIMENSIONS_INVALID)
    );
    assert_eq!(validate_pixel_dimensions(4096, 2048), Ok(()));
    assert_eq!(
        validate_pixel_dimensions(4096, 2049),
        Err(SNAPSHOT_DIMENSIONS_INVALID)
    );
}

#[test]
fn png_bytes_are_capped_before_header_parsing_or_decompression() {
    let oversized = vec![0; MAX_PNG_BYTES + 1];
    assert_eq!(
        evidence_for_png(&oversized),
        Err(SNAPSHOT_INTERMEDIATE_TOO_LARGE)
    );
}

#[test]
fn native_point_size_is_checked_against_backing_scale_and_pixel_budget() {
    assert_eq!(validate_point_dimensions(1024.0, 768.0, 2.0), Ok(()));
    assert_eq!(
        validate_point_dimensions(2048.0, 1536.0, 2.0),
        Err(SNAPSHOT_DIMENSIONS_INVALID)
    );
    assert_eq!(
        validate_point_dimensions(640.0, 480.0, f64::NAN),
        Err(SNAPSHOT_DIMENSIONS_INVALID)
    );
}
