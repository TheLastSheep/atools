use async_trait::async_trait;
use atools_core::PasteboardItem;
use std::{
    path::Path,
    sync::atomic::{AtomicUsize, Ordering},
};

use crate::pasteboard_runtime::{NativePasteboardSnapshot, PasteboardBackend};

#[derive(Default)]
pub(crate) struct DisabledClipboard {
    pub(crate) reads: AtomicUsize,
    pub(crate) writes: AtomicUsize,
    pub(crate) pastes: AtomicUsize,
}

#[async_trait]
impl PasteboardBackend for DisabledClipboard {
    async fn snapshot_if_changed(
        &self,
        _: i64,
    ) -> Result<Option<NativePasteboardSnapshot>, String> {
        self.reads.fetch_add(1, Ordering::Relaxed);
        Err("Clipboard reads are disabled in renderer acceptance".into())
    }

    async fn write_item(&self, _: &PasteboardItem, _: &Path, _: bool) -> Result<(), String> {
        self.writes.fetch_add(1, Ordering::Relaxed);
        Err("Clipboard writes are disabled in renderer acceptance".into())
    }

    async fn paste_frontmost(&self) -> Result<(), String> {
        self.pastes.fetch_add(1, Ordering::Relaxed);
        Err("System paste is disabled in renderer acceptance".into())
    }
}
