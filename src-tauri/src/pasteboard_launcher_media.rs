//! One explicit, bounded media read on the existing native pasteboard backend.
use crate::launcher_media::ClipboardMedia;
#[cfg(target_os = "macos")]
pub(super) fn read(files_only: bool) -> Result<Option<ClipboardMedia>, String> {
    use crate::launcher_media::{clipboard_files, image};
    use atools_core::matcher::{MAX_MEDIA_FILES, MAX_MEDIA_PATH_BYTES, MAX_MEDIA_PATH_TOTAL_BYTES};
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::NSString;
    let pasteboard = NSPasteboard::generalPasteboard();
    let mut paths = Vec::new();
    let mut total = 0usize;
    if let Some(items) = pasteboard.pasteboardItems() {
        if items.len() > MAX_MEDIA_FILES {
            return Err("FILE_INPUT_BUDGET: clipboard exceeds 1000 selected entries".into());
        }
        let file_type = NSString::from_str("public.file-url");
        for item in items.to_vec() {
            let Some(value) = item.stringForType(&file_type) else {
                continue;
            };
            // NSString length is checked before materializing its potentially large UTF-8 value.
            if value.len() > MAX_MEDIA_PATH_BYTES * 3 + 128 {
                return Err("FILE_INPUT_BUDGET: clipboard path is too long".into());
            }
            let value = value.to_string();
            let path = url::Url::parse(&value)
                .ok()
                .and_then(|url| url.to_file_path().ok())
                .ok_or("FILE_INPUT_INVALID: clipboard contains an invalid local file URL")?;
            let path = crate::launcher_media::clipboard_path(&path)?;
            total = total
                .checked_add(path.len())
                .ok_or("FILE_INPUT_BUDGET: path bytes overflow")?;
            if path.len() > MAX_MEDIA_PATH_BYTES || total > MAX_MEDIA_PATH_TOTAL_BYTES {
                return Err("FILE_INPUT_BUDGET: clipboard paths exceed the path allowance".into());
            }
            paths.push(path);
        }
    }
    if !paths.is_empty() {
        return clipboard_files(&paths).map(Some);
    }
    if files_only {
        return Ok(None);
    }
    // Do not copy unrelated PDF/RTF/HTML/text representations into a launcher paste.
    for (native, media) in [
        ("public.png", "image/png"),
        ("public.jpeg", "image/jpeg"),
        ("public.tiff", "image/tiff"),
    ] {
        if let Some(data) = pasteboard.dataForType(&NSString::from_str(native)) {
            if data.len() > image::MAX_IMAGE_ENCODED_BYTES {
                return Err("IMAGE_INPUT_BUDGET: clipboard image exceeds 6 MiB".into());
            }
            let bytes = data.to_vec();
            return Ok(Some(ClipboardMedia::Img {
                data_url: image::encode_data_url(&bytes, media)?,
            }));
        }
    }
    Ok(None)
}
#[cfg(not(target_os = "macos"))]
pub(super) fn read(_files_only: bool) -> Result<Option<ClipboardMedia>, String> {
    Ok(None)
}
