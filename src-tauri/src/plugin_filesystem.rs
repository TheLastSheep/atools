//! Private host-side filesystem primitives for capability-authorized plugins.
//!
//! This module is not a permission gate and exposes no IPC endpoint. Callers
//! must already hold the relevant capability and TaskRun authorization. A
//! directory picker result only selects a root; it does not grant content
//! access by itself.
//!
//! Calls perform synchronous filesystem I/O. Async callers must use a blocking
//! worker such as `spawn_blocking`, never an executor or UI thread. Temporary
//! cleanup is best-effort. If parent-directory sync fails after rename, the
//! destination may already have changed; callers must inspect state instead of
//! blindly retrying.

mod node_text_io;
pub(crate) mod node_text_read;
pub(crate) mod node_text_write;
mod scoped_documents;

#[cfg(all(test, unix))]
mod scoped_documents_tests;

pub(crate) use scoped_documents::{
    DocumentAccess, DocumentBytesFailure, DocumentMetadata, ScopedDocumentError, ScopedDocumentRoot,
};
