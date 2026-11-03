use std::path::Path;

pub(super) const ICON_EDGE: u32 = 64;
pub(super) const MAX_PNG_BYTES: usize = 65_536;

#[cfg(target_os = "macos")]
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

pub(super) fn load_icon_png(path: &Path) -> Option<Vec<u8>> {
    #[cfg(target_os = "macos")]
    {
        load_macos_icon_png(path)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        None
    }
}

#[cfg(target_os = "macos")]
fn load_macos_icon_png(path: &Path) -> Option<Vec<u8>> {
    use objc2::rc::autoreleasepool;
    use objc2::runtime::AnyObject;
    use objc2::AnyThread;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSCalibratedRGBColorSpace, NSGraphicsContext,
        NSWorkspace,
    };
    use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString};

    if !is_app_bundle_path(path) {
        return None;
    }
    let path = NSString::from_str(path.to_str()?);

    autoreleasepool(|_| {
        // NSWorkspace::iconForFile is callable on worker threads. Keep this image's
        // raster and graphics context local to this call; no window is created.
        let image = NSWorkspace::sharedWorkspace().iconForFile(&path);
        let bytes_per_row = ICON_EDGE as usize * 4;
        let bitmap_bytes = bytes_per_row * ICON_EDGE as usize;
        let bitmap = unsafe {
            NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
                NSBitmapImageRep::alloc(),
                std::ptr::null_mut(),
                ICON_EDGE as isize,
                ICON_EDGE as isize,
                8,
                4,
                true,
                false,
                NSCalibratedRGBColorSpace,
                bytes_per_row as isize,
                32,
            )
        }?;
        let bitmap_data = bitmap.bitmapData();
        if bitmap.pixelsWide() != ICON_EDGE as isize
            || bitmap.pixelsHigh() != ICON_EDGE as isize
            || bitmap.bytesPerRow() != bytes_per_row as isize
            || bitmap.bytesPerPlane() != bitmap_bytes as isize
            || bitmap.numberOfPlanes() != 1
            || bitmap.isPlanar()
            || bitmap_data.is_null()
        {
            return None;
        }
        // SAFETY: the bitmap is interleaved RGBA8 with one plane, an exact
        // 256-byte stride, 64 rows, and the returned plane was checked non-null.
        unsafe { std::ptr::write_bytes(bitmap_data, 0, bitmap_bytes) };

        let context = NSGraphicsContext::graphicsContextWithBitmapImageRep(&bitmap)?;
        NSGraphicsContext::saveGraphicsState_class();
        let _restore_graphics_state = RestoreGraphicsState;
        NSGraphicsContext::setCurrentContext(Some(&context));
        image.drawInRect(NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(f64::from(ICON_EDGE), f64::from(ICON_EDGE)),
        ));
        // Secondary-thread drawing contexts require an explicit flush.
        context.flushGraphics();
        drop(_restore_graphics_state);

        let properties =
            NSDictionary::<objc2_app_kit::NSBitmapImageRepPropertyKey, AnyObject>::new();
        let encoded = unsafe {
            bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
        }?;
        let bytes = encoded.to_vec();
        has_bounded_icon_png(&bytes).then_some(bytes)
    })
}

#[cfg(target_os = "macos")]
fn is_app_bundle_path(path: &Path) -> bool {
    path.is_absolute()
        && path.is_dir()
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
}

#[cfg(target_os = "macos")]
struct RestoreGraphicsState;

#[cfg(target_os = "macos")]
impl Drop for RestoreGraphicsState {
    fn drop(&mut self) {
        use objc2_app_kit::NSGraphicsContext;
        NSGraphicsContext::restoreGraphicsState_class();
    }
}

#[cfg(target_os = "macos")]
fn has_bounded_icon_png(bytes: &[u8]) -> bool {
    bytes.len() <= MAX_PNG_BYTES
        && bytes.len() >= 24
        && bytes.starts_with(PNG_SIGNATURE)
        && bytes[8..12] == 13_u32.to_be_bytes()
        && &bytes[12..16] == b"IHDR"
        && bytes[16..20] == ICON_EDGE.to_be_bytes()
        && bytes[20..24] == ICON_EDGE.to_be_bytes()
}

#[cfg(test)]
#[path = "image_tests.rs"]
mod tests;
