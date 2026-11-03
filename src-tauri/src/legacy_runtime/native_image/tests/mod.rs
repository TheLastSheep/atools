mod codec;
mod smoke_diagnostics;
mod store;
mod transform;

use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use std::io::Cursor;

fn rgba_fixture(width: u32, height: u32) -> RgbaImage {
    RgbaImage::from_fn(width, height, |x, y| {
        Rgba([(x % 251) as u8, (y % 239) as u8, ((x + y) % 233) as u8, 255])
    })
}

fn encoded_fixture(format: ImageFormat, width: u32, height: u32) -> Vec<u8> {
    let rgba = rgba_fixture(width, height);
    let image = if format == ImageFormat::Jpeg {
        DynamicImage::ImageRgb8(DynamicImage::ImageRgba8(rgba).to_rgb8())
    } else {
        DynamicImage::ImageRgba8(rgba)
    };
    let mut cursor = Cursor::new(Vec::new());
    image
        .write_to(&mut cursor, format)
        .expect("fixture encodes");
    cursor.into_inner()
}
