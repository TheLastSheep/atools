#[cfg(not(target_os = "macos"))]
use super::load_icon_png;
#[cfg(target_os = "macos")]
use super::{has_bounded_icon_png, load_icon_png, ICON_EDGE, MAX_PNG_BYTES};
#[cfg(not(target_os = "macos"))]
use std::path::Path;
#[cfg(target_os = "macos")]
use std::path::PathBuf;

#[cfg(target_os = "macos")]
#[test]
fn renders_owned_temporary_app_icon_as_bounded_64_pixel_png() {
    let app = OwnedTemporaryApp::create();
    let encoded = load_icon_png(&app.app_path).expect("AppKit should return the owned app icon");

    assert!(encoded.len() <= MAX_PNG_BYTES);
    assert!(has_bounded_icon_png(&encoded));

    let decoded = image::load_from_memory_with_format(&encoded, image::ImageFormat::Png)
        .expect("encoded system icon should decode as PNG")
        .to_rgba8();
    assert_eq!(decoded.dimensions(), (ICON_EDGE, ICON_EDGE));
    assert!(decoded.pixels().any(|pixel| pixel.0[3] > 0));
}

#[cfg(target_os = "macos")]
#[test]
fn rejects_missing_and_non_bundle_paths_without_fabricating_an_icon() {
    let scratch = TemporaryDirectory::create();
    let missing_app = scratch.path.join("Missing.app");
    assert!(load_icon_png(&missing_app).is_none());
    assert!(load_icon_png(&scratch.path).is_none());
}

#[cfg(not(target_os = "macos"))]
#[test]
fn other_platforms_do_not_claim_to_render_appkit_icons() {
    assert!(load_icon_png(Path::new("/tmp/not-a-real-app.app")).is_none());
}

#[cfg(target_os = "macos")]
struct OwnedTemporaryApp {
    _scratch: TemporaryDirectory,
    app_path: PathBuf,
}

#[cfg(target_os = "macos")]
impl OwnedTemporaryApp {
    fn create() -> Self {
        let scratch = TemporaryDirectory::create();
        let app_path = scratch.path.join("OwnedIconProbe.app");
        let contents = app_path.join("Contents");
        std::fs::create_dir_all(&contents).expect("create temporary bundle contents");
        std::fs::write(
            contents.join("Info.plist"),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.atools.owned-icon-probe</string>
  <key>CFBundleName</key><string>OwnedIconProbe</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
</dict></plist>
"#,
        )
        .expect("write temporary bundle metadata");
        Self {
            _scratch: scratch,
            app_path,
        }
    }
}

#[cfg(target_os = "macos")]
struct TemporaryDirectory {
    path: PathBuf,
}

#[cfg(target_os = "macos")]
impl TemporaryDirectory {
    fn create() -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);

        let path = std::env::temp_dir().join(format!(
            "atools-owned-app-icon-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).expect("create owned temporary icon fixture");
        Self { path }
    }
}

#[cfg(target_os = "macos")]
impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
