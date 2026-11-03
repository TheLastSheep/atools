use core_foundation::array::CFArrayRef;
use core_foundation::base::{
    CFAllocatorCopyDescriptionCallBack, CFAllocatorRef, CFAllocatorReleaseCallBack,
    CFAllocatorRetainCallBack, CFIndex,
};
use libc::c_void;
use std::ptr::NonNull;

pub(super) const CREATE_USE_CF_TYPES: u32 = 0x0000_0001;
pub(super) const CREATE_WATCH_ROOT: u32 = 0x0000_0004;
pub(super) const CREATE_FILE_EVENTS: u32 = 0x0000_0010;

pub(super) const EVENT_MUST_SCAN_SUBDIRS: u32 = 0x0000_0001;
pub(super) const EVENT_USER_DROPPED: u32 = 0x0000_0002;
pub(super) const EVENT_KERNEL_DROPPED: u32 = 0x0000_0004;
pub(super) const EVENT_ROOT_CHANGED: u32 = 0x0000_0020;
pub(super) const EVENT_ITEM_CREATED: u32 = 0x0000_0100;
pub(super) const EVENT_ITEM_REMOVED: u32 = 0x0000_0200;
pub(super) const EVENT_ITEM_RENAMED: u32 = 0x0000_0800;
pub(super) const EVENT_ITEM_IS_DIR: u32 = 0x0002_0000;

pub(super) type StreamCallback = extern "C" fn(
    stream: *const c_void,
    client_info: *mut c_void,
    event_count: usize,
    event_paths: *mut c_void,
    event_flags: *const u32,
    event_ids: *const u64,
);

#[repr(C)]
pub(super) struct StreamContext {
    pub(super) version: CFIndex,
    pub(super) info: *mut c_void,
    pub(super) retain: Option<CFAllocatorRetainCallBack>,
    pub(super) release: Option<CFAllocatorReleaseCallBack>,
    pub(super) copy_description: Option<CFAllocatorCopyDescriptionCallBack>,
}

pub(super) struct Stream(NonNull<c_void>);

impl Stream {
    pub(super) fn create(
        callback: StreamCallback,
        context: &mut StreamContext,
        paths: CFArrayRef,
        latency_seconds: f64,
        flags: u32,
    ) -> Option<Self> {
        let raw = unsafe {
            FSEventStreamCreate(
                std::ptr::null(),
                callback,
                context,
                paths,
                u64::MAX,
                latency_seconds,
                flags,
            )
        };
        NonNull::new(raw).map(Self)
    }

    pub(super) fn set_dispatch_queue(&self, queue: &DispatchQueue) {
        unsafe { FSEventStreamSetDispatchQueue(self.0.as_ptr(), queue.0.as_ptr()) }
    }

    pub(super) fn start(&self) -> bool {
        unsafe { FSEventStreamStart(self.0.as_ptr()) != 0 }
    }

    pub(super) fn stop(&self) {
        unsafe { FSEventStreamStop(self.0.as_ptr()) }
    }

    pub(super) fn invalidate(&self) {
        unsafe { FSEventStreamInvalidate(self.0.as_ptr()) }
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        unsafe { FSEventStreamRelease(self.0.as_ptr()) }
    }
}

// FSEvent streams are serialized through their dispatch queue. The unique owner
// controls start/stop and may move that ownership to the shutdown thread.
unsafe impl Send for Stream {}

pub(super) struct DispatchQueue(NonNull<c_void>);

impl DispatchQueue {
    pub(super) fn create_serial() -> Option<Self> {
        let label = std::ffi::CString::new("com.atools.launcher-app-catalog-watch").ok()?;
        let raw = unsafe { dispatch_queue_create(label.as_ptr(), std::ptr::null_mut()) };
        NonNull::new(raw).map(Self)
    }

    pub(super) fn drain(&self) {
        unsafe { dispatch_sync_f(self.0.as_ptr(), std::ptr::null_mut(), no_op) }
    }
}

impl Drop for DispatchQueue {
    fn drop(&mut self) {
        unsafe { dispatch_release(self.0.as_ptr()) }
    }
}

// Dispatch queues are thread-safe handles. The FSEventStream owner is unique.
unsafe impl Send for DispatchQueue {}

extern "C" fn no_op(_context: *mut c_void) {}

#[link(name = "CoreServices", kind = "framework")]
extern "C" {
    fn FSEventStreamCreate(
        allocator: CFAllocatorRef,
        callback: StreamCallback,
        context: *mut StreamContext,
        paths_to_watch: CFArrayRef,
        since_when: u64,
        latency: f64,
        flags: u32,
    ) -> *mut c_void;
    fn FSEventStreamSetDispatchQueue(stream: *mut c_void, queue: *mut c_void);
    fn FSEventStreamStart(stream: *mut c_void) -> u8;
    fn FSEventStreamStop(stream: *mut c_void);
    fn FSEventStreamInvalidate(stream: *mut c_void);
    fn FSEventStreamRelease(stream: *mut c_void);
}

#[link(name = "System")]
extern "C" {
    fn dispatch_queue_create(label: *const libc::c_char, attr: *mut c_void) -> *mut c_void;
    fn dispatch_sync_f(queue: *mut c_void, context: *mut c_void, work: extern "C" fn(*mut c_void));
    fn dispatch_release(object: *mut c_void);
}
