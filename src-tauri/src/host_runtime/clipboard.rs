//! Exact native text access. No trimming, history capture, or payload logging.
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

pub const MAX_TEXT_BYTES: usize = 256 * 1024;
pub trait ClipboardAccess: Send + Sync {
    fn read(&self) -> Result<String, String>;
    fn write(&self, text: &str) -> Result<(), String>;
    fn read_image(&self) -> Result<Option<super::clipboard_image::ImageSource>, String> {
        Err("Native clipboard images are unsupported on this platform".into())
    }
    fn write_image(
        &self,
        _image: super::clipboard_image_write::RgbaClipboardImage,
    ) -> Result<(), String> {
        Err("Native clipboard image writes are unsupported on this platform".into())
    }
    fn read_files(&self) -> Result<Vec<super::copied_files::CopiedFile>, String> {
        Err("Native clipboard files are unsupported on this platform".into())
    }
    fn has_format(&self, _format: &str) -> Result<bool, String> {
        Err("Native clipboard format queries are unsupported on this platform".into())
    }
    fn read_format(&self, _format: &str) -> Result<Vec<u8>, String> {
        Err("Native clipboard format reads are unsupported on this platform".into())
    }
    fn write_files(&self, _paths: &[String]) -> Result<(), String> {
        Err("Native clipboard file writes are unsupported on this platform".into())
    }
    fn write_html(&self, _html: &str, _text: Option<&str>) -> Result<(), String> {
        Err("Native clipboard HTML writes are unsupported on this platform".into())
    }
}
pub struct SystemClipboard(pub AppHandle);
impl ClipboardAccess for SystemClipboard {
    fn has_format(&self, format: &str) -> Result<bool, String> {
        super::clipboard_formats::validate_format(format)?;
        #[cfg(target_os = "macos")]
        {
            super::clipboard_formats::mac_has_format(None, format)
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err("Native clipboard format queries are unsupported on this platform".into())
        }
    }
    fn read_format(&self, format: &str) -> Result<Vec<u8>, String> {
        super::clipboard_formats::validate_format(format)?;
        #[cfg(target_os = "macos")]
        {
            super::clipboard_formats::mac_read_format(None, format)
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err("Native clipboard format reads are unsupported on this platform".into())
        }
    }
    #[cfg(not(target_os = "macos"))]
    fn write_html(&self, html: &str, text: Option<&str>) -> Result<(), String> {
        self.0
            .clipboard()
            .write_html(html.to_owned(), text.map(str::to_owned))
            .map_err(|_| "Native clipboard HTML write failed".into())
    }
    fn read_image(&self) -> Result<Option<super::clipboard_image::ImageSource>, String> {
        super::clipboard_image::read_system(&self.0)
    }
    fn write_image(
        &self,
        image: super::clipboard_image_write::RgbaClipboardImage,
    ) -> Result<(), String> {
        let native = tauri::image::Image::new_owned(image.rgba, image.width, image.height);
        self.0
            .clipboard()
            .write_image(&native)
            .map_err(|_| "Native clipboard image write failed".into())
    }
    #[cfg(target_os = "macos")]
    fn read_files(&self) -> Result<Vec<super::copied_files::CopiedFile>, String> {
        super::copied_files::mac_read(None)
    }
    #[cfg(target_os = "macos")]
    fn write_files(&self, paths: &[String]) -> Result<(), String> {
        super::copied_files::mac_write(None, paths)
    }
    #[cfg(target_os = "macos")]
    fn write_html(&self, html: &str, text: Option<&str>) -> Result<(), String> {
        super::clipboard_html::mac_write_html(None, html, text)
    }
    fn read(&self) -> Result<String, String> {
        #[cfg(target_os = "macos")]
        {
            Ok(mac_read(None))
        }
        #[cfg(not(target_os = "macos"))]
        {
            self.0
                .clipboard()
                .read_text()
                .map_err(|_| "Native clipboard text is unavailable".into())
        }
    }
    fn write(&self, text: &str) -> Result<(), String> {
        self.0
            .clipboard()
            .write_text(text)
            .map_err(|_| "Native clipboard write failed".into())
    }
}
#[cfg(target_os = "macos")]
pub(super) fn mac_read(name: Option<&str>) -> String {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::NSString;
    let pasteboard = match name {
        Some(name) => NSPasteboard::pasteboardWithName(&NSString::from_str(name)),
        None => NSPasteboard::generalPasteboard(),
    };
    pasteboard
        .stringForType(unsafe { NSPasteboardTypeString })
        .map(|s| s.to_string())
        .unwrap_or_default()
}
#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
pub(super) struct NamedClipboard(pub String);
#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
impl Drop for NamedClipboard {
    fn drop(&mut self) {
        use objc2_app_kit::NSPasteboard;
        use objc2_foundation::NSString;
        NSPasteboard::pasteboardWithName(&NSString::from_str(&self.0)).clearContents();
    }
}
#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
impl ClipboardAccess for NamedClipboard {
    fn has_format(&self, format: &str) -> Result<bool, String> {
        super::clipboard_formats::validate_format(format)?;
        super::clipboard_formats::mac_has_format(Some(&self.0), format)
    }
    fn read_format(&self, format: &str) -> Result<Vec<u8>, String> {
        super::clipboard_formats::validate_format(format)?;
        super::clipboard_formats::mac_read_format(Some(&self.0), format)
    }
    fn read_files(&self) -> Result<Vec<super::copied_files::CopiedFile>, String> {
        super::copied_files::mac_read(Some(&self.0))
    }
    fn read(&self) -> Result<String, String> {
        Ok(mac_read(Some(&self.0)))
    }
    fn write(&self, text: &str) -> Result<(), String> {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
        use objc2_foundation::NSString;
        let pasteboard = NSPasteboard::pasteboardWithName(&NSString::from_str(&self.0));
        pasteboard.clearContents();
        if pasteboard
            .setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString })
        {
            Ok(())
        } else {
            Err("Named native pasteboard write failed".into())
        }
    }
    fn write_files(&self, paths: &[String]) -> Result<(), String> {
        super::copied_files::mac_write(Some(&self.0), paths)
    }
    fn write_html(&self, html: &str, text: Option<&str>) -> Result<(), String> {
        super::clipboard_html::mac_write_html(Some(&self.0), html, text)
    }
}
pub fn exact_read(backend: &dyn ClipboardAccess) -> Result<String, String> {
    let text = backend.read()?;
    if text.len() > MAX_TEXT_BYTES {
        return Err("Clipboard text exceeds 256 KiB".into());
    }
    Ok(text)
}
pub fn exact_write(backend: &dyn ClipboardAccess, text: &str) -> Result<(), String> {
    if text.len() > MAX_TEXT_BYTES {
        return Err("Clipboard text exceeds 256 KiB".into());
    }
    backend.write(text)
}
