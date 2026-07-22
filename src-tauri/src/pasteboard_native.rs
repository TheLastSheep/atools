//! Platform pasteboard backend used by the native Paste runtime.

use crate::pasteboard_runtime::{
    NativePasteboardRepresentation, NativePasteboardSnapshot, PasteboardBackend,
};
use async_trait::async_trait;
use atools_core::{PasteboardItem, PasteboardSourceApp};
use std::path::Path;
use std::sync::Arc;

pub fn system_pasteboard_backend() -> Arc<dyn PasteboardBackend> {
    Arc::new(SystemPasteboardBackend)
}

pub struct SystemPasteboardBackend;

#[cfg(target_os = "macos")]
pub fn recognize_text(image_path: &Path) -> Result<String, String> {
    macos::recognize_text(image_path)
}

#[cfg(not(target_os = "macos"))]
pub fn recognize_text(_image_path: &Path) -> Result<String, String> {
    Err("Vision OCR is currently available on macOS".into())
}

#[cfg(target_os = "macos")]
#[async_trait]
impl PasteboardBackend for SystemPasteboardBackend {
    async fn snapshot_if_changed(
        &self,
        previous_change_count: i64,
    ) -> Result<Option<NativePasteboardSnapshot>, String> {
        macos::snapshot_if_changed(previous_change_count)
    }

    async fn write_item(
        &self,
        item: &PasteboardItem,
        blob_root: &Path,
        plain_text: bool,
    ) -> Result<(), String> {
        macos::write_item(item, blob_root, plain_text)
    }

    async fn paste_frontmost(&self) -> Result<(), String> {
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;
        macos::paste_with_command_v()
    }
}

#[cfg(not(target_os = "macos"))]
#[async_trait]
impl PasteboardBackend for SystemPasteboardBackend {
    async fn snapshot_if_changed(
        &self,
        _previous_change_count: i64,
    ) -> Result<Option<NativePasteboardSnapshot>, String> {
        Ok(None)
    }

    async fn write_item(
        &self,
        _item: &PasteboardItem,
        _blob_root: &Path,
        _plain_text: bool,
    ) -> Result<(), String> {
        Err("Native Paste clipboard writes are currently available on macOS".into())
    }

    async fn paste_frontmost(&self) -> Result<(), String> {
        Err("Direct paste is currently available on macOS".into())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, KeyCode};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use objc2::AnyThread;
    #[allow(deprecated)]
    use objc2_app_kit::NSFilenamesPboardType;
    use objc2_app_kit::{
        NSPasteboard, NSPasteboardTypeColor, NSPasteboardTypeFileURL, NSPasteboardTypeHTML,
        NSPasteboardTypePDF, NSPasteboardTypePNG, NSPasteboardTypeRTF, NSPasteboardTypeString,
        NSPasteboardTypeTIFF, NSPasteboardTypeURL, NSWorkspace,
    };
    use objc2_core_graphics::{CGPreflightPostEventAccess, CGRequestPostEventAccess};
    use objc2_foundation::{NSArray, NSData, NSString};
    use objc2_vision::{
        VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel,
    };
    use serde_json::Value;
    use std::path::{Component, PathBuf};

    const TRANSIENT_TYPES: &[&str] = &[
        "org.nspasteboard.TransientType",
        "org.chromium.chromium-ephemeral",
        "org.mozilla.firefox-private",
    ];
    const CONFIDENTIAL_TYPES: &[&str] = &[
        "org.nspasteboard.ConcealedType",
        "com.agilebits.onepassword",
        "com.1password",
    ];

    pub fn snapshot_if_changed(
        previous_change_count: i64,
    ) -> Result<Option<NativePasteboardSnapshot>, String> {
        let pasteboard = NSPasteboard::generalPasteboard();
        let change_count = pasteboard.changeCount() as i64;
        if change_count == previous_change_count {
            return Ok(None);
        }

        let source_app = frontmost_source_app();
        let type_names: Vec<String> = pasteboard
            .types()
            .map(|types| {
                types
                    .to_vec()
                    .into_iter()
                    .map(|value| value.to_string())
                    .collect()
            })
            .unwrap_or_default();
        let is_transient = type_names
            .iter()
            .any(|value| TRANSIENT_TYPES.iter().any(|candidate| value == candidate));
        let is_confidential = type_names.iter().any(|value| {
            CONFIDENTIAL_TYPES
                .iter()
                .any(|candidate| value == candidate)
        });
        let mut representations = Vec::new();

        let files = file_paths(&pasteboard);
        if !files.is_empty() {
            representations.push(NativePasteboardRepresentation::Files(files));
        }
        if let Some(bytes) = pasteboard.dataForType(pasteboard_type_png()) {
            representations.push(NativePasteboardRepresentation::Image {
                bytes: bytes.to_vec(),
                media_type: "image/png".into(),
            });
        } else if let Some(bytes) = data_for_custom_type(&pasteboard, "public.jpeg") {
            representations.push(NativePasteboardRepresentation::Image {
                bytes,
                media_type: "image/jpeg".into(),
            });
        } else if let Some(bytes) = pasteboard.dataForType(pasteboard_type_tiff()) {
            representations.push(NativePasteboardRepresentation::Image {
                bytes: bytes.to_vec(),
                media_type: "image/tiff".into(),
            });
        }
        if let Some(bytes) = pasteboard.dataForType(pasteboard_type_pdf()) {
            representations.push(NativePasteboardRepresentation::Pdf(bytes.to_vec()));
        }
        if let Some(html) = pasteboard.stringForType(pasteboard_type_html()) {
            representations.push(NativePasteboardRepresentation::Html(html.to_string()));
        }
        if let Some(rtf) = pasteboard.dataForType(pasteboard_type_rtf()) {
            representations.push(NativePasteboardRepresentation::RichText {
                bytes: rtf.to_vec(),
                media_type: "text/rtf".into(),
            });
        }
        if let Some(url) = pasteboard.stringForType(pasteboard_type_url()) {
            representations.push(NativePasteboardRepresentation::Url(url.to_string()));
        }
        if let Some(text) = pasteboard.stringForType(pasteboard_type_string()) {
            let text = text.to_string();
            if is_hex_color(&text) {
                representations.push(NativePasteboardRepresentation::Color(text.clone()));
            }
            representations.push(NativePasteboardRepresentation::Text(text));
        }

        Ok(Some(NativePasteboardSnapshot {
            change_count,
            copied_at: atools_core::utils::now_iso(),
            source_app,
            is_confidential,
            is_transient,
            representations,
        }))
    }

    pub fn write_item(
        item: &PasteboardItem,
        blob_root: &Path,
        plain_text: bool,
    ) -> Result<(), String> {
        let pasteboard = NSPasteboard::generalPasteboard();
        pasteboard.clearContents();
        let text = item_text(item);
        if plain_text {
            let text = text.ok_or_else(|| "Paste item has no text representation".to_string())?;
            return set_string(&pasteboard, &text, pasteboard_type_string());
        }

        let mut wrote = false;
        if let Some(files) = item.payload.get("files").and_then(Value::as_array) {
            #[allow(deprecated)]
            {
                let paths = files
                    .iter()
                    .filter_map(Value::as_str)
                    .map(NSString::from_str)
                    .collect::<Vec<_>>();
                if !paths.is_empty() {
                    let array = NSArray::from_retained_slice(&paths);
                    wrote |= unsafe {
                        pasteboard.setPropertyList_forType(&array, filenames_pasteboard_type())
                    };
                }
            }
        }
        if let Some(path) = payload_blob_path(item, "imageBlobPath") {
            let bytes = read_blob(blob_root, path)?;
            let media_type = item
                .payload
                .get("imageMediaType")
                .and_then(Value::as_str)
                .unwrap_or("image/png");
            let pasteboard_type = if media_type == "image/tiff" {
                pasteboard_type_tiff()
            } else if media_type == "image/jpeg" {
                let jpeg_type = NSString::from_str("public.jpeg");
                wrote |= pasteboard.setData_forType(Some(&NSData::with_bytes(&bytes)), &jpeg_type);
                pasteboard_type_png()
            } else {
                pasteboard_type_png()
            };
            if media_type != "image/jpeg" {
                wrote |=
                    pasteboard.setData_forType(Some(&NSData::with_bytes(&bytes)), pasteboard_type);
            }
        }
        if let Some(path) = payload_blob_path(item, "pdfBlobPath") {
            let bytes = read_blob(blob_root, path)?;
            wrote |= pasteboard
                .setData_forType(Some(&NSData::with_bytes(&bytes)), pasteboard_type_pdf());
        }
        if let Some(path) = payload_blob_path(item, "richTextBlobPath") {
            let bytes = read_blob(blob_root, path)?;
            wrote |= pasteboard
                .setData_forType(Some(&NSData::with_bytes(&bytes)), pasteboard_type_rtf());
        }
        if let Some(html) = item.payload.get("html").and_then(Value::as_str) {
            wrote |= set_string(&pasteboard, html, pasteboard_type_html()).is_ok();
        }
        if let Some(url) = item.payload.get("url").and_then(Value::as_str) {
            wrote |= set_string(&pasteboard, url, pasteboard_type_url()).is_ok();
        }
        if let Some(color) = item.payload.get("color").and_then(Value::as_str) {
            wrote |= set_string(&pasteboard, color, pasteboard_type_color()).is_ok();
        }
        if let Some(text) = text {
            wrote |= set_string(&pasteboard, &text, pasteboard_type_string()).is_ok();
        }
        if wrote {
            Ok(())
        } else {
            Err("Paste item has no available local representation".into())
        }
    }

    pub fn paste_with_command_v() -> Result<(), String> {
        if !CGPreflightPostEventAccess() && !CGRequestPostEventAccess() {
            return Err("请在系统设置中允许 ATools 使用辅助功能后重试".into());
        }
        let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .map_err(|_| "Failed to create native keyboard event source".to_string())?;
        let down = CGEvent::new_keyboard_event(source.clone(), KeyCode::ANSI_V, true)
            .map_err(|_| "Failed to create Command-V key-down event".to_string())?;
        down.set_flags(CGEventFlags::CGEventFlagCommand);
        let up = CGEvent::new_keyboard_event(source, KeyCode::ANSI_V, false)
            .map_err(|_| "Failed to create Command-V key-up event".to_string())?;
        up.set_flags(CGEventFlags::CGEventFlagCommand);
        down.post(CGEventTapLocation::HID);
        up.post(CGEventTapLocation::HID);
        Ok(())
    }

    pub fn recognize_text(image_path: &Path) -> Result<String, String> {
        let bytes = std::fs::read(image_path).map_err(|error| error.to_string())?;
        let data = NSData::with_bytes(&bytes);
        let options = objc2_foundation::NSDictionary::new();
        let handler = VNImageRequestHandler::initWithData_options(
            VNImageRequestHandler::alloc(),
            &data,
            &options,
        );
        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        request.setUsesLanguageCorrection(true);
        request.setAutomaticallyDetectsLanguage(true);
        let request_base: objc2::rc::Retained<VNRequest> =
            request.clone().into_super().into_super();
        let requests = NSArray::from_retained_slice(&[request_base]);
        handler
            .performRequests_error(&requests)
            .map_err(|error| error.localizedDescription().to_string())?;
        let mut lines = Vec::new();
        if let Some(observations) = request.results() {
            for observation in observations.to_vec() {
                if let Some(candidate) = observation.topCandidates(1).to_vec().into_iter().next() {
                    let value = candidate.string().to_string();
                    if !value.trim().is_empty() {
                        lines.push(value);
                    }
                }
            }
        }
        Ok(lines.join("\n"))
    }

    fn frontmost_source_app() -> Option<PasteboardSourceApp> {
        let app = NSWorkspace::sharedWorkspace().frontmostApplication()?;
        Some(PasteboardSourceApp {
            bundle_id: app.bundleIdentifier().map(|value| value.to_string()),
            name: app.localizedName().map(|value| value.to_string()),
        })
    }

    fn file_paths(pasteboard: &NSPasteboard) -> Vec<String> {
        pasteboard
            .pasteboardItems()
            .map(|items| {
                items
                    .to_vec()
                    .into_iter()
                    .filter_map(|item| item.stringForType(pasteboard_type_file_url()))
                    .filter_map(|value| url::Url::parse(&value.to_string()).ok())
                    .filter_map(|url| url.to_file_path().ok())
                    .map(|path| path.to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn data_for_custom_type(pasteboard: &NSPasteboard, type_name: &str) -> Option<Vec<u8>> {
        let pasteboard_type = NSString::from_str(type_name);
        pasteboard
            .dataForType(&pasteboard_type)
            .map(|data| data.to_vec())
    }

    fn item_text(item: &PasteboardItem) -> Option<String> {
        for key in ["text", "url", "color", "previewText"] {
            if let Some(value) = item.payload.get(key).and_then(Value::as_str) {
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
        None
    }

    fn set_string(
        pasteboard: &NSPasteboard,
        value: &str,
        pasteboard_type: &NSString,
    ) -> Result<(), String> {
        if pasteboard.setString_forType(&NSString::from_str(value), pasteboard_type) {
            Ok(())
        } else {
            Err(format!("Failed to write pasteboard type {pasteboard_type}"))
        }
    }

    fn payload_blob_path<'a>(item: &'a PasteboardItem, key: &str) -> Option<&'a str> {
        item.payload.get(key).and_then(Value::as_str)
    }

    fn read_blob(root: &Path, relative_path: &str) -> Result<Vec<u8>, String> {
        let relative = PathBuf::from(relative_path);
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err("Unsafe Paste blob path".into());
        }
        std::fs::read(root.join(relative)).map_err(|error| error.to_string())
    }

    fn is_hex_color(value: &str) -> bool {
        let value = value.trim();
        let Some(hex) = value.strip_prefix('#') else {
            return false;
        };
        matches!(hex.len(), 3 | 4 | 6 | 8)
            && hex.chars().all(|character| character.is_ascii_hexdigit())
    }

    fn pasteboard_type_string() -> &'static NSString {
        unsafe { NSPasteboardTypeString }
    }

    fn pasteboard_type_pdf() -> &'static NSString {
        unsafe { NSPasteboardTypePDF }
    }

    fn pasteboard_type_png() -> &'static NSString {
        unsafe { NSPasteboardTypePNG }
    }

    fn pasteboard_type_tiff() -> &'static NSString {
        unsafe { NSPasteboardTypeTIFF }
    }

    fn pasteboard_type_rtf() -> &'static NSString {
        unsafe { NSPasteboardTypeRTF }
    }

    fn pasteboard_type_html() -> &'static NSString {
        unsafe { NSPasteboardTypeHTML }
    }

    fn pasteboard_type_color() -> &'static NSString {
        unsafe { NSPasteboardTypeColor }
    }

    fn pasteboard_type_url() -> &'static NSString {
        unsafe { NSPasteboardTypeURL }
    }

    fn pasteboard_type_file_url() -> &'static NSString {
        unsafe { NSPasteboardTypeFileURL }
    }

    #[allow(deprecated)]
    fn filenames_pasteboard_type() -> &'static NSString {
        unsafe { NSFilenamesPboardType }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_factory_is_available_without_starting_capture() {
        let _backend = system_pasteboard_backend();
    }
}
