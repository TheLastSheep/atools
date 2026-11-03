//! Explicit macOS integration tests for isolated named pasteboards only.
use super::{snapshot_from_pasteboard, BUDGET};
use crate::pasteboard_runtime::NativePasteboardRepresentation as Representation;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_app_kit::{
    NSPasteboard, NSPasteboardItem, NSPasteboardTypeFileURL, NSPasteboardTypePNG,
    NSPasteboardTypeString, NSPasteboardWriting,
};
use objc2_foundation::{NSArray, NSData, NSString, NSURL};

struct NamedPasteboard {
    _name: String,
    pasteboard: Retained<NSPasteboard>,
}

impl NamedPasteboard {
    fn new() -> Self {
        let name = format!(
            "com.atools.current-context-test.{}.{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        );
        let pasteboard = NSPasteboard::pasteboardWithName(&NSString::from_str(&name));
        pasteboard.clearContents();
        Self {
            _name: name,
            pasteboard,
        }
    }

    fn write_item(&self, item: &NSPasteboardItem) {
        let object: &ProtocolObject<dyn NSPasteboardWriting> = ProtocolObject::from_ref(item);
        self.pasteboard.clearContents();
        assert!(self
            .pasteboard
            .writeObjects(&NSArray::from_slice(&[object])));
    }
}

impl Drop for NamedPasteboard {
    fn drop(&mut self) {
        self.pasteboard.clearContents();
        // objc2-app-kit 0.3.2 exposes no releaseGloballyNamedPasteboard binding.
    }
}

#[test]
#[ignore = "touches an isolated named macOS pasteboard; run explicitly on macOS"]
fn named_pasteboard_snapshot_preserves_text_and_observes_clear_and_change_count() {
    let pasteboard = NamedPasteboard::new();
    let before = pasteboard.pasteboard.changeCount() as i64;
    let text = " \tNamed clipboard text\n  ";
    let item = NSPasteboardItem::new();
    assert!(item.setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString }));
    pasteboard.write_item(&item);

    let after_write = pasteboard.pasteboard.changeCount() as i64;
    assert_ne!(after_write, before);
    let snapshot = snapshot_from_pasteboard(&pasteboard.pasteboard)
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.change_count, after_write);
    assert_eq!(
        snapshot.representations,
        vec![Representation::Text(text.to_string())]
    );
    assert_eq!(
        snapshot_from_pasteboard(&pasteboard.pasteboard)
            .unwrap()
            .unwrap()
            .change_count,
        after_write
    );

    pasteboard.pasteboard.clearContents();
    let cleared = snapshot_from_pasteboard(&pasteboard.pasteboard)
        .unwrap()
        .unwrap();
    assert_ne!(cleared.change_count, after_write);
    assert!(cleared.representations.is_empty());
}

#[test]
#[ignore = "touches an isolated named macOS pasteboard; run explicitly on macOS"]
fn named_pasteboard_snapshot_prefers_file_then_image_and_rejects_image_budget_header() {
    let pasteboard = NamedPasteboard::new();
    let temp = tempfile::tempdir().unwrap();
    let file_path = temp.path().join("r61-fixed-file.txt");
    std::fs::write(&file_path, b"fixed private fixture").unwrap();
    let file_url = NSURL::fileURLWithPath(&NSString::from_str(
        file_path.to_str().expect("temporary path is UTF8"),
    ));
    let file_url_string = file_url.absoluteString().unwrap();
    let expected_path = file_url.path().unwrap().to_string();
    let png = one_pixel_png();

    let all_types = NSPasteboardItem::new();
    assert!(all_types.setString_forType(&file_url_string, unsafe { NSPasteboardTypeFileURL }));
    assert!(all_types.setData_forType(&NSData::with_bytes(&png), unsafe { NSPasteboardTypePNG }));
    assert!(
        all_types.setString_forType(&NSString::from_str("lower-priority text"), unsafe {
            NSPasteboardTypeString
        })
    );
    pasteboard.write_item(&all_types);

    let files = snapshot_from_pasteboard(&pasteboard.pasteboard)
        .unwrap()
        .unwrap();
    assert_eq!(
        files.representations,
        vec![Representation::Files(vec![expected_path])]
    );

    let image_and_text = NSPasteboardItem::new();
    assert!(
        image_and_text.setData_forType(&NSData::with_bytes(&png), unsafe { NSPasteboardTypePNG })
    );
    assert!(
        image_and_text.setString_forType(&NSString::from_str("lower-priority text"), unsafe {
            NSPasteboardTypeString
        })
    );
    pasteboard.write_item(&image_and_text);
    let image = snapshot_from_pasteboard(&pasteboard.pasteboard)
        .unwrap()
        .unwrap();
    assert_eq!(
        image.representations,
        vec![Representation::Image {
            bytes: png.clone(),
            media_type: "image/png".into(),
        }]
    );

    let oversized = png_with_dimensions(&png, 16_385, 1);
    let oversized_item = NSPasteboardItem::new();
    assert!(
        oversized_item.setData_forType(&NSData::with_bytes(&oversized), unsafe {
            NSPasteboardTypePNG
        })
    );
    pasteboard.write_item(&oversized_item);
    assert_eq!(
        snapshot_from_pasteboard(&pasteboard.pasteboard).unwrap_err(),
        BUDGET
    );
}

fn one_pixel_png() -> Vec<u8> {
    let image = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        1,
        1,
        image::Rgba([16, 32, 64, 255]),
    ));
    let mut output = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut output, image::ImageFormat::Png)
        .unwrap();
    output.into_inner()
}

fn png_with_dimensions(source: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut png = source.to_vec();
    png[16..20].copy_from_slice(&width.to_be_bytes());
    png[20..24].copy_from_slice(&height.to_be_bytes());
    png
}
