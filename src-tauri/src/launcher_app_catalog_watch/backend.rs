//! Bounded macOS FSEvents backend for application-catalog structure changes.

#[cfg(target_os = "macos")]
#[path = "ffi.rs"]
mod ffi;

#[cfg(target_os = "macos")]
use crate::launcher_app_catalog::{MAX_DEPTH, MAX_ENTRIES};
#[cfg(target_os = "macos")]
use core_foundation::{
    array::{CFArray, CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef},
    base::{kCFAllocatorDefault, CFGetTypeID, TCFType},
    string::{
        CFString, CFStringCreateWithFileSystemRepresentation, CFStringGetFileSystemRepresentation,
        CFStringGetMaximumSizeOfFileSystemRepresentation, CFStringGetTypeID, CFStringRef,
    },
};
#[cfg(target_os = "macos")]
use std::{
    ffi::{CStr, CString, OsStr},
    fs,
    io::ErrorKind,
    os::unix::ffi::OsStrExt,
    panic::{catch_unwind, AssertUnwindSafe},
    path::{Component, Path},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use std::{path::PathBuf, sync::Arc};

#[cfg(not(target_os = "macos"))]
const UNSUPPORTED_PLATFORM: &str = "launcher app catalog watcher is unsupported on this platform";

/// Owns the native watcher and its callback lifetime.
pub(super) struct NativeWatcher {
    #[cfg(target_os = "macos")]
    inner: Option<MacWatcher>,
}

impl NativeWatcher {
    pub(super) fn start(
        roots: &[PathBuf],
        on_change: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Self, &'static str> {
        #[cfg(target_os = "macos")]
        {
            let inner = MacWatcher::start(roots, on_change)?;
            Ok(Self { inner: Some(inner) })
        }

        #[cfg(not(target_os = "macos"))]
        {
            let _ = (roots, on_change);
            Err(UNSUPPORTED_PLATFORM)
        }
    }

    pub(super) fn stop(&mut self) {
        #[cfg(target_os = "macos")]
        if let Some(mut inner) = self.inner.take() {
            inner.stop();
        }
    }
}

impl Drop for NativeWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(target_os = "macos")]
const MAX_ROOTS: usize = 3;
#[cfg(target_os = "macos")]
const MAX_PATH_BYTES: usize = 4096;
#[cfg(target_os = "macos")]
const FSEVENT_LATENCY_SECONDS: f64 = 1.0;

#[cfg(target_os = "macos")]
struct CallbackState {
    roots: Vec<PathBuf>,
    active: AtomicBool,
    on_change: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

#[cfg(target_os = "macos")]
impl CallbackState {
    fn notify_if_active(&self) {
        if !self.active.load(Ordering::Acquire) {
            return;
        }
        let callback = self
            .on_change
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .cloned();
        if self.active.load(Ordering::Acquire) {
            if let Some(callback) = callback {
                callback();
            }
        }
    }

    fn take_callback(&self) {
        let callback = self
            .on_change
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        drop(callback);
    }
}

#[cfg(target_os = "macos")]
struct MacWatcher {
    stream: Option<ffi::Stream>,
    queue: Option<ffi::DispatchQueue>,
    _context: Arc<CallbackState>,
    started: bool,
    invalidated: bool,
}

#[cfg(target_os = "macos")]
impl MacWatcher {
    fn start(
        roots: &[PathBuf],
        on_change: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Self, &'static str> {
        let (normalized_roots, watch_paths) = validate_roots(roots)?;
        let watch_path_array = CFArray::<CFString>::from_CFTypes(&watch_paths);
        let context = Arc::new(CallbackState {
            roots: normalized_roots,
            active: AtomicBool::new(true),
            on_change: Mutex::new(Some(on_change)),
        });
        let info = Arc::as_ptr(&context).cast_mut().cast();
        let mut stream_context = ffi::StreamContext {
            version: 0,
            info,
            retain: Some(retain_context),
            release: Some(release_context),
            copy_description: None,
        };
        let flags = ffi::CREATE_USE_CF_TYPES | ffi::CREATE_WATCH_ROOT | ffi::CREATE_FILE_EVENTS;
        let stream = ffi::Stream::create(
            event_callback,
            &mut stream_context,
            watch_path_array.as_concrete_TypeRef(),
            FSEVENT_LATENCY_SECONDS,
            flags,
        )
        .ok_or("launcher app catalog event stream unavailable")?;
        let queue = ffi::DispatchQueue::create_serial()
            .ok_or("launcher app catalog dispatch queue unavailable")?;
        let mut watcher = Self {
            stream: Some(stream),
            queue: Some(queue),
            _context: context,
            started: false,
            invalidated: false,
        };
        watcher
            .stream
            .as_ref()
            .expect("stream was just installed")
            .set_dispatch_queue(watcher.queue.as_ref().expect("queue was just installed"));
        let started = watcher
            .stream
            .as_ref()
            .expect("stream was just installed")
            .start();
        watcher.started = started;
        if !started {
            watcher.stop();
            return Err("launcher app catalog event stream could not start");
        }
        Ok(watcher)
    }

    fn stop(&mut self) {
        self._context.active.store(false, Ordering::Release);
        if let Some(stream) = self.stream.as_ref() {
            if self.started {
                stream.stop();
                self.started = false;
            }
            if !self.invalidated {
                // Keep the serial queue attached until invalidation completes.
                stream.invalidate();
                self.invalidated = true;
            }
        }
        if let Some(queue) = self.queue.as_ref() {
            // The caller must be outside this queue; the production callback never stops it.
            queue.drain();
        }
        self._context.take_callback();
        self.stream.take();
        self.queue.take();
    }
}

#[cfg(target_os = "macos")]
impl Drop for MacWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(target_os = "macos")]
fn validate_roots(roots: &[PathBuf]) -> Result<(Vec<PathBuf>, Vec<CFString>), &'static str> {
    if roots.is_empty() || roots.len() > MAX_ROOTS {
        return Err("launcher app catalog watcher received an invalid root count");
    }
    let mut normalized = Vec::with_capacity(roots.len());
    let mut strings = Vec::with_capacity(roots.len());
    for root in roots {
        if !root.is_absolute()
            || root == Path::new("/")
            || root
                .components()
                .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
        {
            return Err("launcher app catalog watcher received an invalid root");
        }
        let leaf = root
            .file_name()
            .ok_or("launcher app catalog watcher received an invalid root")?;
        let parent = root
            .parent()
            .ok_or("launcher app catalog watcher received an invalid root")?;
        let canonical_parent = fs::canonicalize(parent)
            .map_err(|_| "launcher app catalog watcher root parent unavailable")?;
        let canonical_shape = canonical_parent.join(leaf);
        match fs::symlink_metadata(&canonical_shape) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(_) => return Err("launcher app catalog watcher root is not a real directory"),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => return Err("launcher app catalog watcher root unavailable"),
        }
        let root_bytes = canonical_shape.as_os_str().as_bytes();
        if root_bytes.len() > MAX_PATH_BYTES || root_bytes.contains(&0) {
            return Err("launcher app catalog watcher received an invalid root");
        }
        if normalized.iter().any(|other: &PathBuf| {
            other == &canonical_shape
                || other.starts_with(&canonical_shape)
                || canonical_shape.starts_with(other)
        }) {
            return Err("launcher app catalog watcher received overlapping roots");
        }
        let c_root = CString::new(root_bytes)
            .map_err(|_| "launcher app catalog watcher received an invalid root")?;
        let raw_string = unsafe {
            CFStringCreateWithFileSystemRepresentation(kCFAllocatorDefault, c_root.as_ptr())
        };
        if raw_string.is_null() {
            return Err("launcher app catalog watcher received an invalid root");
        }
        normalized.push(canonical_shape);
        strings.push(unsafe { CFString::wrap_under_create_rule(raw_string) });
    }
    Ok((normalized, strings))
}

#[cfg(target_os = "macos")]
extern "C" fn retain_context(info: *mut libc::c_void) -> *mut libc::c_void {
    if info.is_null() {
        return std::ptr::null_mut();
    }
    let retained = catch_unwind(AssertUnwindSafe(|| unsafe {
        Arc::increment_strong_count(info.cast::<CallbackState>());
        info
    }));
    retained.unwrap_or(std::ptr::null_mut())
}

#[cfg(target_os = "macos")]
extern "C" fn release_context(info: *mut libc::c_void) {
    if info.is_null() {
        return;
    }
    let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
        Arc::decrement_strong_count(info.cast::<CallbackState>());
    }));
}

#[cfg(target_os = "macos")]
extern "C" fn event_callback(
    _stream: *const libc::c_void,
    client_info: *mut libc::c_void,
    event_count: usize,
    event_paths: *mut libc::c_void,
    event_flags: *const u32,
    _event_ids: *const u64,
) {
    let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
        if client_info.is_null() {
            return;
        }
        let context = &*client_info.cast::<CallbackState>();
        if batch_requires_refresh(event_count, event_paths, event_flags, &context.roots) {
            context.notify_if_active();
        }
    }));
}

#[cfg(target_os = "macos")]
unsafe fn batch_requires_refresh(
    event_count: usize,
    event_paths: *mut libc::c_void,
    event_flags: *const u32,
    roots: &[PathBuf],
) -> bool {
    if event_count == 0 {
        return false;
    }
    if event_count > MAX_ENTRIES || event_paths.is_null() || event_flags.is_null() {
        return true;
    }
    let paths = event_paths.cast::<std::ffi::c_void>() as CFArrayRef;
    let count = CFArrayGetCount(paths);
    if count < 0 || count as usize != event_count || count as usize > MAX_ENTRIES {
        return true;
    }

    for index in 0..event_count {
        let flags = *event_flags.add(index);
        if flags
            & (ffi::EVENT_MUST_SCAN_SUBDIRS
                | ffi::EVENT_USER_DROPPED
                | ffi::EVENT_KERNEL_DROPPED
                | ffi::EVENT_ROOT_CHANGED)
            != 0
        {
            return true;
        }
        let structural = flags
            & (ffi::EVENT_ITEM_CREATED | ffi::EVENT_ITEM_REMOVED | ffi::EVENT_ITEM_RENAMED)
            != 0;
        if !structural || flags & ffi::EVENT_ITEM_IS_DIR == 0 {
            continue;
        }

        let raw_path = CFArrayGetValueAtIndex(paths, index as isize);
        if raw_path.is_null() || CFGetTypeID(raw_path) != CFStringGetTypeID() {
            return true;
        }
        let Some(path) = bounded_path(raw_path as CFStringRef) else {
            return true;
        };
        if is_catalog_directory(&path, roots) {
            return true;
        }
    }
    false
}

#[cfg(target_os = "macos")]
unsafe fn bounded_path(raw: CFStringRef) -> Option<PathBuf> {
    let maximum = CFStringGetMaximumSizeOfFileSystemRepresentation(raw);
    if maximum <= 0 || maximum as usize > MAX_PATH_BYTES + 1 {
        return None;
    }
    let mut buffer = [0u8; MAX_PATH_BYTES + 1];
    if CFStringGetFileSystemRepresentation(raw, buffer.as_mut_ptr().cast(), buffer.len() as isize)
        == 0
    {
        return None;
    }
    let bytes = CStr::from_ptr(buffer.as_ptr().cast()).to_bytes();
    if bytes.is_empty() || bytes.len() > MAX_PATH_BYTES || bytes[0] != b'/' {
        return None;
    }
    Some(PathBuf::from(OsStr::from_bytes(bytes)))
}

#[cfg(target_os = "macos")]
fn is_catalog_directory(path: &Path, roots: &[PathBuf]) -> bool {
    for root in roots {
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let depth = relative.components().count();
        let app_is_ancestor = relative
            .components()
            .take(depth.saturating_sub(1))
            .any(|part| match part {
                Component::Normal(name) => has_app_extension(name),
                _ => false,
            });
        if app_is_ancestor {
            return false;
        }
        let is_app_bundle = relative
            .components()
            .next_back()
            .is_some_and(|part| match part {
                Component::Normal(name) => has_app_extension(name),
                _ => false,
            });
        return if is_app_bundle {
            depth <= MAX_DEPTH + 1
        } else {
            depth <= MAX_DEPTH
        };
    }
    false
}

#[cfg(target_os = "macos")]
fn has_app_extension(name: &OsStr) -> bool {
    let bytes = name.as_bytes();
    bytes.len() > 4 && bytes[bytes.len() - 4..].eq_ignore_ascii_case(b".app")
}

#[cfg(test)]
#[cfg(target_os = "macos")]
#[path = "backend_tests.rs"]
mod tests;
