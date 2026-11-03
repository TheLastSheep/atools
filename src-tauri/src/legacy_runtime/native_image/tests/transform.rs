use super::{encoded_fixture, rgba_fixture};
use crate::legacy_runtime::native_image::transform::{
    target_dimensions, validate_plan_for_dimensions, validate_request, EncodeRequest, OutputFormat,
    ResizeQuality, ResizeStep,
};
use crate::legacy_runtime::native_image::{
    EngineLimits, NativeImageCancellation, NativeImageEngine, NativeImageError, OpenSourceKind,
};
use image::{DynamicImage, ImageFormat};
use serde_json::json;

#[test]
fn exact_wire_request_is_strict_and_requires_jpeg_quality() {
    let unknown = serde_json::from_value::<EncodeRequest>(json!({"format":"png","extra":true}));
    assert!(unknown.is_err());
    let missing_jpeg_quality =
        serde_json::from_value::<EncodeRequest>(json!({"format":"jpeg"})).unwrap();
    assert_eq!(
        validate_request(&missing_jpeg_quality),
        Err(NativeImageError::InvalidRequest)
    );
    let png_with_jpeg_quality =
        serde_json::from_value::<EncodeRequest>(json!({"format":"png","jpegQuality":72})).unwrap();
    assert_eq!(
        validate_request(&png_with_jpeg_quality),
        Err(NativeImageError::InvalidRequest)
    );
    let valid_jpeg = serde_json::from_value::<EncodeRequest>(
        json!({"format":"jpeg","jpegQuality":72,"resizePlan":[]}),
    )
    .unwrap();
    assert!(validate_request(&valid_jpeg).is_ok());
}

#[test]
fn resize_axes_preserve_float_aspect_and_both_axes_are_direct() {
    let width_only = ResizeStep {
        width: Some(101),
        height: None,
        quality: None,
    };
    let height_only = ResizeStep {
        width: None,
        height: Some(51),
        quality: None,
    };
    let both = ResizeStep {
        width: Some(80),
        height: Some(70),
        quality: Some(ResizeQuality::Good),
    };
    assert_eq!(target_dimensions(200, 100, &width_only).unwrap(), (101, 51));
    assert_eq!(
        target_dimensions(200, 100, &height_only).unwrap(),
        (102, 51)
    );
    // Preserve the frontend's exact f32 operation order. These decimal
    // half-looking cases are not exact ties after f32 rounding.
    assert_eq!(
        target_dimensions(
            4,
            7,
            &ResizeStep {
                width: Some(2),
                height: None,
                quality: None,
            }
        )
        .unwrap(),
        (2, 3)
    );
    assert_eq!(
        target_dimensions(
            2,
            7,
            &ResizeStep {
                width: Some(3),
                height: None,
                quality: None,
            }
        )
        .unwrap(),
        (3, 10)
    );
    // An exact positive half rounds upward, as in JavaScript Math.round.
    assert_eq!(
        target_dimensions(
            2,
            5,
            &ResizeStep {
                width: Some(1),
                height: None,
                quality: None,
            }
        )
        .unwrap(),
        (1, 3)
    );
    assert_eq!(target_dimensions(200, 100, &both).unwrap(), (80, 70));
}

#[test]
fn complete_resize_plan_is_preflighted_from_stored_dimensions() {
    let over_pixels = EncodeRequest {
        format: OutputFormat::Png,
        jpeg_quality: None,
        resize_plan: vec![ResizeStep {
            width: Some(4096),
            height: Some(4096),
            quality: None,
        }],
    };
    assert_eq!(
        validate_plan_for_dimensions(64, 64, &over_pixels, EngineLimits::default()),
        Err(NativeImageError::DimensionsExceeded)
    );

    let request = EncodeRequest {
        format: OutputFormat::Png,
        jpeg_quality: None,
        resize_plan: vec![ResizeStep {
            width: Some(2),
            height: Some(2),
            quality: None,
        }],
    };
    let mut limits = EngineLimits::default();
    limits.resize_temp_bytes = 1;
    assert_eq!(
        validate_plan_for_dimensions(1, 1, &request, limits),
        Err(NativeImageError::DecodeBudgetExceeded)
    );
}

#[test]
fn valid_source_encodes_png_and_jpeg_within_bound() {
    let engine = NativeImageEngine::new();
    let session = engine.new_session();
    let source = encoded_fixture(ImageFormat::Png, 2, 1);
    let descriptor = engine
        .open_bytes(
            &session,
            engine
                .reserve_open(
                    &session,
                    OpenSourceKind::WebViewBuffer {
                        byte_length: source.len(),
                    },
                )
                .unwrap(),
            source,
            engine.try_worker().unwrap(),
            &NativeImageCancellation::default(),
        )
        .unwrap();
    let png = EncodeRequest {
        format: OutputFormat::Png,
        jpeg_quality: None,
        resize_plan: vec![],
    };
    let png_result = engine
        .encode(
            &session,
            &descriptor.handle_id,
            &png,
            engine.try_worker().unwrap(),
            &NativeImageCancellation::default(),
        )
        .unwrap();
    assert_eq!((png_result.width, png_result.height), (2, 1));
    assert!(png_result.bytes.len() <= 512 * 1024);
    assert_eq!(
        image::guess_format(&png_result.bytes).unwrap(),
        ImageFormat::Png
    );

    let jpeg = EncodeRequest {
        format: OutputFormat::Jpeg,
        jpeg_quality: Some(72),
        resize_plan: vec![],
    };
    let jpeg_result = engine
        .encode(
            &session,
            &descriptor.handle_id,
            &jpeg,
            engine.try_worker().unwrap(),
            &NativeImageCancellation::default(),
        )
        .unwrap();
    assert_eq!(
        image::guess_format(&jpeg_result.bytes).unwrap(),
        ImageFormat::Jpeg
    );
}

#[test]
fn resize_plan_limit_and_memory_preflight_reject_before_resize_allocations() {
    let many = EncodeRequest {
        format: OutputFormat::Png,
        jpeg_quality: None,
        resize_plan: (0..5)
            .map(|_| ResizeStep {
                width: Some(2),
                height: Some(2),
                quality: None,
            })
            .collect(),
    };
    assert_eq!(
        validate_request(&many),
        Err(NativeImageError::InvalidRequest)
    );

    let mut limits = EngineLimits::default();
    limits.max_source_bytes = 4 * 1024 * 1024;
    limits.resize_temp_bytes = 1;
    let engine = NativeImageEngine::with_limits(limits);
    let session = engine.new_session();
    let source = encoded_fixture(ImageFormat::Png, 1, 1);
    let descriptor = engine
        .open_bytes(
            &session,
            engine
                .reserve_open(
                    &session,
                    OpenSourceKind::WebViewBuffer {
                        byte_length: source.len(),
                    },
                )
                .unwrap(),
            source,
            engine.try_worker().unwrap(),
            &NativeImageCancellation::default(),
        )
        .unwrap();
    let request = EncodeRequest {
        format: OutputFormat::Png,
        jpeg_quality: None,
        resize_plan: vec![ResizeStep {
            width: Some(2),
            height: Some(2),
            quality: None,
        }],
    };
    assert!(matches!(
        engine.encode(
            &session,
            &descriptor.handle_id,
            &request,
            engine.try_worker().unwrap(),
            &NativeImageCancellation::default()
        ),
        Err(NativeImageError::DecodeBudgetExceeded)
    ));
}

#[test]
fn jpeg_conversion_is_rgb_and_output_cap_is_enforced() {
    let mut limits = EngineLimits::default();
    limits.max_encoded_bytes = 32;
    let engine = NativeImageEngine::with_limits(limits);
    let session = engine.new_session();
    let png = {
        let image = DynamicImage::ImageRgba8(rgba_fixture(16, 16));
        let mut cursor = std::io::Cursor::new(Vec::new());
        image.write_to(&mut cursor, ImageFormat::Png).unwrap();
        cursor.into_inner()
    };
    let descriptor = engine
        .open_bytes(
            &session,
            engine
                .reserve_open(
                    &session,
                    OpenSourceKind::WebViewBuffer {
                        byte_length: png.len(),
                    },
                )
                .unwrap(),
            png,
            engine.try_worker().unwrap(),
            &NativeImageCancellation::default(),
        )
        .unwrap();
    let request = EncodeRequest {
        format: OutputFormat::Jpeg,
        jpeg_quality: Some(100),
        resize_plan: vec![],
    };
    assert!(matches!(
        engine.encode(
            &session,
            &descriptor.handle_id,
            &request,
            engine.try_worker().unwrap(),
            &NativeImageCancellation::default()
        ),
        Err(NativeImageError::OutputTooLarge)
    ));
}

#[test]
fn cancelled_encode_does_not_return_output() {
    let engine = NativeImageEngine::new();
    let session = engine.new_session();
    let source = encoded_fixture(ImageFormat::Png, 1, 1);
    let descriptor = engine
        .open_bytes(
            &session,
            engine
                .reserve_open(
                    &session,
                    OpenSourceKind::WebViewBuffer {
                        byte_length: source.len(),
                    },
                )
                .unwrap(),
            source,
            engine.try_worker().unwrap(),
            &NativeImageCancellation::default(),
        )
        .unwrap();
    let token = NativeImageCancellation::default();
    token.cancel();
    assert!(token.is_cancelled());
    let request = EncodeRequest {
        format: OutputFormat::Png,
        jpeg_quality: None,
        resize_plan: vec![],
    };
    assert!(matches!(
        engine.encode(
            &session,
            &descriptor.handle_id,
            &request,
            engine.try_worker().unwrap(),
            &token
        ),
        Err(NativeImageError::Cancelled)
    ));
}
