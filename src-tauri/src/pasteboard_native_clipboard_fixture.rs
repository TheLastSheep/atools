//! Opt-in, isolated named pasteboard backend for the renderer clipboard smoke.
use crate::pasteboard_runtime::{NativePasteboardSnapshot, PasteboardBackend};
use async_trait::async_trait;
use atools_core::PasteboardItem;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{msg_send, ClassType};
use objc2_app_kit::{
    NSPasteboard, NSPasteboardItem, NSPasteboardTypeFileURL, NSPasteboardTypePNG,
    NSPasteboardTypeString, NSPasteboardWriting,
};
use objc2_foundation::{NSArray, NSData, NSString, NSURL};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

const ROOT_PREFIX: &str = "atools-renderer-clipboard-";
const FIXTURE_DIRECTORY: &str = "clipboard-fixture";
const FILE_BYTES: &[u8] = b"ATools private named clipboard fixture\n";
const ROOT_INVALID: &str = "CLIPBOARD_FIXTURE_ROOT_INVALID";
const FILE_CREATE_FAILED: &str = "CLIPBOARD_FIXTURE_FILE_CREATE_FAILED";
const PASTEBOARD_UNAVAILABLE: &str = "CLIPBOARD_FIXTURE_PASTEBOARD_UNAVAILABLE";
const PASTEBOARD_WRITE_FAILED: &str = "CLIPBOARD_FIXTURE_PASTEBOARD_WRITE_FAILED";
const CLEAR_UNVERIFIED: &str = "CLIPBOARD_FIXTURE_CLEAR_UNVERIFIED";
const WRITE_REJECTED: &str = "CLIPBOARD_FIXTURE_WRITE_REJECTED";
const PASTE_REJECTED: &str = "CLIPBOARD_FIXTURE_PASTE_REJECTED";

pub(crate) const FIXTURE_TEXT: &str = "  ATools R62 private clipboard text \n";
pub(crate) const FIXTURE_FILE_NAME: &str = "atools-r62-private-clipboard.txt";

pub(crate) enum FixtureContent {
    Text,
    Image,
    Files,
    Empty,
}

#[derive(Default)]
struct Metrics {
    snapshots: AtomicU64,
    change_counts: AtomicU64,
    background_captures: AtomicU64,
    writes_rejected: AtomicU64,
    pastes_rejected: AtomicU64,
    clear_verified: AtomicBool,
}

struct FileIdentity {
    dev: u64,
    ino: u64,
    uid: u32,
    mode: u32,
}

struct OwnedRoot {
    path: PathBuf,
    file_path: PathBuf,
    directory: FileIdentity,
    file: Option<FileIdentity>,
}

impl Drop for OwnedRoot {
    fn drop(&mut self) {
        let Ok(directory) = fs::symlink_metadata(&self.path) else {
            return;
        };
        if !directory.file_type().is_dir() || !same_identity(&directory, &self.directory) {
            return;
        }
        if let Some(identity) = &self.file {
            if let Ok(file) = fs::symlink_metadata(&self.file_path) {
                if file.file_type().is_file() && same_identity(&file, identity) {
                    let _ = fs::remove_file(&self.file_path);
                }
            }
        }
        let _ = fs::remove_dir(&self.path);
    }
}

/// Owns one random named pasteboard and one private file fixture. It never selects the system board.
pub(crate) struct NamedClipboardFixture {
    name: String,
    root: OwnedRoot,
    gate: Mutex<()>,
    metrics: Metrics,
}

impl NamedClipboardFixture {
    pub(crate) fn new(run_id: &str, root: &Path) -> Result<Arc<Self>, String> {
        let expected_root = Path::new("/private/tmp").join(format!("{ROOT_PREFIX}{run_id}"));
        if !profile_root_path_matches(run_id, root)
            || root != expected_root
            || !private_profile_root_is_valid(root, &expected_root)
        {
            return Err(ROOT_INVALID.into());
        }

        let fixture_root = root.join(FIXTURE_DIRECTORY);
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        builder
            .create(&fixture_root)
            .map_err(|_| ROOT_INVALID.to_string())?;
        let directory = match private_directory_identity(&fixture_root, &fixture_root) {
            Some(identity) => identity,
            None => return Err(ROOT_INVALID.into()),
        };
        let file_path = fixture_root.join(FIXTURE_FILE_NAME);
        let mut root_state = OwnedRoot {
            path: fixture_root,
            file_path: file_path.clone(),
            directory,
            file: None,
        };
        let mut options = OpenOptions::new();
        options.write(true).create_new(true).mode(0o600);
        #[cfg(target_os = "macos")]
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        let mut file = match options.open(&file_path) {
            Ok(file) => file,
            Err(_) => return Err(FILE_CREATE_FAILED.into()),
        };
        if file
            .set_permissions(fs::Permissions::from_mode(0o600))
            .is_err()
        {
            let _ = fs::remove_file(&file_path);
            return Err(FILE_CREATE_FAILED.into());
        }
        let Some(file_metadata) = file.metadata().ok().filter(private_regular_file) else {
            let _ = fs::remove_file(&file_path);
            return Err(FILE_CREATE_FAILED.into());
        };
        root_state.file = Some(file_identity(&file_metadata));
        if file
            .write_all(FILE_BYTES)
            .and_then(|_| file.sync_all())
            .is_err()
        {
            return Err(FILE_CREATE_FAILED.into());
        }
        let name = format!(
            "com.atools.renderer-clipboard-fixture.{run_id}.{}.{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        );
        let pasteboard =
            named_pasteboard(&name).ok_or_else(|| PASTEBOARD_UNAVAILABLE.to_string())?;
        pasteboard.clearContents();
        Ok(Arc::new(Self {
            name,
            root: root_state,
            gate: Mutex::new(()),
            metrics: Metrics::default(),
        }))
    }

    pub(crate) fn set_content(&self, content: FixtureContent) -> Result<(), String> {
        let _guard = self.gate.lock();
        let pasteboard = self.pasteboard()?;
        pasteboard.clearContents();
        self.metrics.clear_verified.store(false, Ordering::Relaxed);
        match content {
            FixtureContent::Text => {
                let item = NSPasteboardItem::new();
                if !item.setString_forType(&NSString::from_str(FIXTURE_TEXT), unsafe {
                    NSPasteboardTypeString
                }) {
                    return Err(PASTEBOARD_WRITE_FAILED.into());
                }
                write_item(&pasteboard, &item)
            }
            FixtureContent::Image => {
                let item = NSPasteboardItem::new();
                if !item.setData_forType(&NSData::with_bytes(&one_pixel_png()), unsafe {
                    NSPasteboardTypePNG
                }) {
                    return Err(PASTEBOARD_WRITE_FAILED.into());
                }
                write_item(&pasteboard, &item)
            }
            FixtureContent::Files => {
                let path = self
                    .root
                    .file_path
                    .to_str()
                    .ok_or(PASTEBOARD_WRITE_FAILED)?;
                let url = NSURL::fileURLWithPath(&NSString::from_str(path));
                let url = url.absoluteString().ok_or(PASTEBOARD_WRITE_FAILED)?;
                let item = NSPasteboardItem::new();
                if !item.setString_forType(&url, unsafe { NSPasteboardTypeFileURL }) {
                    return Err(PASTEBOARD_WRITE_FAILED.into());
                }
                write_item(&pasteboard, &item)
            }
            FixtureContent::Empty => self.clear_locked(&pasteboard),
        }
    }

    pub(crate) fn clear(&self) -> Result<bool, String> {
        let _guard = self.gate.lock();
        let pasteboard = self.pasteboard()?;
        pasteboard.clearContents();
        let verified = self
            .read_snapshot(&pasteboard)?
            .is_some_and(|snapshot| snapshot.representations.is_empty());
        self.metrics
            .clear_verified
            .store(verified, Ordering::Relaxed);
        Ok(verified)
    }

    pub(crate) fn metrics(&self) -> Value {
        let pasteboard_change_count = {
            let _guard = self.gate.lock();
            self.pasteboard()
                .ok()
                .map(|pasteboard| pasteboard.changeCount() as i64)
        };
        json!({
            "snapshots": self.metrics.snapshots.load(Ordering::Relaxed),
            "changeCounts": self.metrics.change_counts.load(Ordering::Relaxed),
            "pasteboardChangeCount": pasteboard_change_count,
            "backgroundCaptures": self.metrics.background_captures.load(Ordering::Relaxed),
            "writesRejected": self.metrics.writes_rejected.load(Ordering::Relaxed),
            "pastesRejected": self.metrics.pastes_rejected.load(Ordering::Relaxed),
            "clearVerified": self.metrics.clear_verified.load(Ordering::Relaxed),
        })
    }

    fn pasteboard(&self) -> Result<Retained<NSPasteboard>, String> {
        named_pasteboard(&self.name).ok_or_else(|| PASTEBOARD_UNAVAILABLE.into())
    }

    fn read_snapshot(
        &self,
        pasteboard: &NSPasteboard,
    ) -> Result<Option<NativePasteboardSnapshot>, String> {
        super::current_context::snapshot_from_pasteboard(pasteboard)
    }

    fn clear_locked(&self, pasteboard: &NSPasteboard) -> Result<(), String> {
        let verified = self
            .read_snapshot(pasteboard)?
            .is_some_and(|snapshot| snapshot.representations.is_empty());
        self.metrics
            .clear_verified
            .store(verified, Ordering::Relaxed);
        if verified {
            Ok(())
        } else {
            Err(CLEAR_UNVERIFIED.into())
        }
    }
}

impl Drop for NamedClipboardFixture {
    fn drop(&mut self) {
        if let Some(pasteboard) = named_pasteboard(&self.name) {
            pasteboard.clearContents();
        }
        // The retained name is process-global; clearing contents is the available cleanup API.
    }
}

#[async_trait]
impl PasteboardBackend for NamedClipboardFixture {
    async fn snapshot_if_changed(
        &self,
        _previous_change_count: i64,
    ) -> Result<Option<NativePasteboardSnapshot>, String> {
        self.metrics
            .background_captures
            .fetch_add(1, Ordering::Relaxed);
        Ok(None)
    }

    async fn current_context_snapshot(&self) -> Result<Option<NativePasteboardSnapshot>, String> {
        let _guard = self.gate.lock();
        let pasteboard = self.pasteboard()?;
        self.metrics.snapshots.fetch_add(1, Ordering::Relaxed);
        self.read_snapshot(&pasteboard)
    }

    async fn current_change_count(&self) -> Result<Option<i64>, String> {
        let _guard = self.gate.lock();
        let pasteboard = self.pasteboard()?;
        self.metrics.change_counts.fetch_add(1, Ordering::Relaxed);
        Ok(Some(pasteboard.changeCount() as i64))
    }

    async fn write_item(
        &self,
        _item: &PasteboardItem,
        _blob_root: &Path,
        _plain_text: bool,
    ) -> Result<(), String> {
        self.metrics.writes_rejected.fetch_add(1, Ordering::Relaxed);
        Err(WRITE_REJECTED.into())
    }

    async fn paste_frontmost(&self) -> Result<(), String> {
        self.metrics.pastes_rejected.fetch_add(1, Ordering::Relaxed);
        Err(PASTE_REJECTED.into())
    }
}

fn write_item(pasteboard: &NSPasteboard, item: &NSPasteboardItem) -> Result<(), String> {
    let writing: &ProtocolObject<dyn NSPasteboardWriting> = ProtocolObject::from_ref(item);
    if pasteboard.writeObjects(&NSArray::from_slice(&[writing])) {
        Ok(())
    } else {
        Err(PASTEBOARD_WRITE_FAILED.into())
    }
}

fn named_pasteboard(name: &str) -> Option<Retained<NSPasteboard>> {
    let name = NSString::from_str(name);
    let pasteboard: Option<Retained<NSPasteboard>> =
        unsafe { msg_send![NSPasteboard::class(), pasteboardWithName: &*name] };
    pasteboard
}

fn canonical_run_id(run_id: &str) -> bool {
    run_id.len() == 32
        && run_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn profile_root_path_matches(run_id: &str, root: &Path) -> bool {
    let expected = Path::new("/private/tmp").join(format!("{ROOT_PREFIX}{run_id}"));
    canonical_run_id(run_id) && root == expected && root.parent() == Some(Path::new("/private/tmp"))
}

fn private_profile_root_is_valid(root: &Path, expected: &Path) -> bool {
    fs::symlink_metadata(root).is_ok_and(|metadata| {
        metadata.file_type().is_dir()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o7777 == 0o700
            && fs::canonicalize(root).is_ok_and(|canonical| canonical == expected)
    })
}

fn private_directory_identity(path: &Path, expected: &Path) -> Option<FileIdentity> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.nlink() != 2
        || metadata.mode() & 0o7777 != 0o700
        || fs::canonicalize(path).ok()?.as_path() != expected
    {
        return None;
    }
    Some(file_identity(&metadata))
}

fn private_regular_file(metadata: &fs::Metadata) -> bool {
    metadata.is_file()
        && metadata.uid() == unsafe { libc::geteuid() }
        && metadata.nlink() == 1
        && metadata.mode() & 0o7777 == 0o600
}

fn file_identity(metadata: &fs::Metadata) -> FileIdentity {
    FileIdentity {
        dev: metadata.dev(),
        ino: metadata.ino(),
        uid: metadata.uid(),
        mode: metadata.mode() & 0o7777,
    }
}

fn same_identity(metadata: &fs::Metadata, identity: &FileIdentity) -> bool {
    metadata.dev() == identity.dev
        && metadata.ino() == identity.ino
        && metadata.uid() == identity.uid
        && metadata.mode() & 0o7777 == identity.mode
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
        .expect("fixed one-pixel PNG encoding is infallible");
    output.into_inner()
}

#[cfg(test)]
mod tests {
    use super::profile_root_path_matches;
    use std::path::Path;

    const RUN_ID: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn profile_root_path_is_exact_and_bound_to_canonical_run_id() {
        assert!(profile_root_path_matches(
            RUN_ID,
            Path::new("/private/tmp/atools-renderer-clipboard-0123456789abcdef0123456789abcdef")
        ));
        for (run_id, path) in [
            (
                RUN_ID,
                "/private/tmp/atools-renderer-clipboard-0123456789abcdef0123456789abcde0",
            ),
            (
                "0123456789ABCDEF0123456789ABCDEF",
                "/private/tmp/atools-renderer-clipboard-0123456789abcdef0123456789abcdef",
            ),
            (
                RUN_ID,
                "/tmp/atools-renderer-clipboard-0123456789abcdef0123456789abcdef",
            ),
            (
                RUN_ID,
                "/private/tmp/atools-renderer-clipboard-0123456789abcdef0123456789abcdef/child",
            ),
        ] {
            assert!(!profile_root_path_matches(run_id, Path::new(path)));
        }
    }
}
