//! Private bounded NativeImage source and transform engine.
//!
//! The host must reserve before asking the Node sidecar to read a path, then move
//! the reservation and worker permit into the blocking operation. This module
//! performs no filesystem, clipboard, persistence, or WebView work.

mod codec;
mod png_validation;
#[cfg(any(test, feature = "legacy-node-smoke"))]
mod smoke_diagnostics;
mod store;
mod transform;
mod worker;
#[cfg(any(test, feature = "legacy-node-smoke"))]
pub(crate) use smoke_diagnostics::NativeImageSmokeSnapshot;

#[cfg(test)]
mod tests;

use std::fmt;
use std::sync::Arc;
use worker::{CancellationToken, WorkerGate};

pub(crate) use codec::SourceFormat;
pub(crate) use store::{NativeImageSession, OpenReservation};
pub(crate) use transform::{EncodeRequest, EncodedImage, OutputFormat, ResizeQuality, ResizeStep};
pub(crate) use worker::CancellationToken as NativeImageCancellation;
pub(crate) use worker::WorkerPermit;

const MAX_SOURCE_BYTES: usize = 4 * 1024 * 1024;
const MAX_BUFFER_BYTES: usize = 512 * 1024;
const MAX_SESSION_HANDLES: usize = 64;
const MAX_SESSION_BYTES: usize = 32 * 1024 * 1024;
const MAX_GLOBAL_BYTES: usize = 64 * 1024 * 1024;
const MAX_OPEN_RESERVATIONS_PER_SESSION: usize = 2;
const MAX_SIDE: u32 = 8192;
const MAX_PIXELS: u64 = 16_000_000;
const MAX_DECODER_ALLOC: u64 = 64 * 1024 * 1024;
const MAX_CONTROLLED_PIXEL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DECODE_WORKING_BYTES: u64 = 128 * 1024 * 1024;
const MAX_RESIZE_TEMP_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RESIZE_WORKING_BYTES: u64 = 192 * 1024 * 1024;
const MAX_JPEG_CONVERSION_WORKING_BYTES: u64 = 112 * 1024 * 1024;
const MAX_ENCODED_BYTES: usize = 512 * 1024;

// These limits bound app-owned pixel buffers, not total RSS. Decoding may
// briefly hold up to 64 MiB of decoder output plus 64 MiB of RGBA conversion.
// A resize can hold source RGBA + 16-byte-per-pixel intermediate + destination
// RGBA (up to 192 MiB total); JPEG conversion can add up to 48 MiB RGB. Codec
// internals and allocator overhead remain outside these explicit estimates.

#[derive(Clone, Copy, Debug)]
struct EngineLimits {
    max_source_bytes: usize,
    max_handles_per_session: usize,
    max_session_bytes: usize,
    max_global_bytes: usize,
    max_open_per_session: usize,
    max_side: u32,
    max_pixels: u64,
    decoder_alloc_bytes: u64,
    controlled_pixel_bytes: u64,
    decode_working_bytes: u64,
    resize_temp_bytes: u64,
    resize_working_bytes: u64,
    jpeg_conversion_working_bytes: u64,
    max_encoded_bytes: usize,
}

impl Default for EngineLimits {
    fn default() -> Self {
        Self {
            max_source_bytes: MAX_SOURCE_BYTES,
            max_handles_per_session: MAX_SESSION_HANDLES,
            max_session_bytes: MAX_SESSION_BYTES,
            max_global_bytes: MAX_GLOBAL_BYTES,
            max_open_per_session: MAX_OPEN_RESERVATIONS_PER_SESSION,
            max_side: MAX_SIDE,
            max_pixels: MAX_PIXELS,
            decoder_alloc_bytes: MAX_DECODER_ALLOC,
            controlled_pixel_bytes: MAX_CONTROLLED_PIXEL_BYTES,
            decode_working_bytes: MAX_DECODE_WORKING_BYTES,
            resize_temp_bytes: MAX_RESIZE_TEMP_BYTES,
            resize_working_bytes: MAX_RESIZE_WORKING_BYTES,
            jpeg_conversion_working_bytes: MAX_JPEG_CONVERSION_WORKING_BYTES,
            max_encoded_bytes: MAX_ENCODED_BYTES,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NativeImageError {
    InvalidRequest,
    InvalidImage,
    UnsupportedFormat,
    DimensionsExceeded,
    DecodeBudgetExceeded,
    SourceTooLarge,
    BudgetExceeded,
    OpenBusy,
    WorkerBusy,
    SessionClosed,
    HandleUnavailable,
    OutputTooLarge,
    EncodeFailed,
    Cancelled,
}

impl NativeImageError {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "ERR_ATOOLS_NATIVE_IMAGE_INVALID_REQUEST",
            Self::InvalidImage => "ERR_ATOOLS_NATIVE_IMAGE_INVALID_IMAGE",
            Self::UnsupportedFormat => "ERR_ATOOLS_NATIVE_IMAGE_UNSUPPORTED_FORMAT",
            Self::DimensionsExceeded => "ERR_ATOOLS_NATIVE_IMAGE_DIMENSIONS",
            Self::DecodeBudgetExceeded => "ERR_ATOOLS_NATIVE_IMAGE_DECODE_BUDGET",
            Self::SourceTooLarge => "ERR_ATOOLS_NATIVE_IMAGE_SOURCE_TOO_LARGE",
            Self::BudgetExceeded => "ERR_ATOOLS_NATIVE_IMAGE_BUDGET",
            Self::OpenBusy => "ERR_ATOOLS_NATIVE_IMAGE_OPEN_BUSY",
            Self::WorkerBusy => "ERR_ATOOLS_NATIVE_IMAGE_WORKER_BUSY",
            Self::SessionClosed => "ERR_ATOOLS_NATIVE_IMAGE_SESSION_CLOSED",
            Self::HandleUnavailable => "ERR_ATOOLS_NATIVE_IMAGE_HANDLE_UNAVAILABLE",
            Self::OutputTooLarge => "ERR_ATOOLS_NATIVE_IMAGE_OUTPUT_TOO_LARGE",
            Self::EncodeFailed => "ERR_ATOOLS_NATIVE_IMAGE_ENCODE_FAILED",
            Self::Cancelled => "ERR_ATOOLS_NATIVE_IMAGE_CANCELLED",
        }
    }

    pub(crate) fn message(self) -> &'static str {
        match self {
            Self::InvalidRequest => "Unsupported image request",
            Self::InvalidImage => "Image data is invalid or incomplete",
            Self::UnsupportedFormat => "Image format is not supported",
            Self::DimensionsExceeded => "Image dimensions exceed the supported limit",
            Self::DecodeBudgetExceeded => "Image decode exceeds the memory budget",
            Self::SourceTooLarge => "Image source exceeds the supported byte limit",
            Self::BudgetExceeded => "Native image session budget is exhausted",
            Self::OpenBusy => "Native image source capacity is busy",
            Self::WorkerBusy => "Native image processor is busy",
            Self::SessionClosed => "Native image session is closed",
            Self::HandleUnavailable => "Native image handle is unavailable",
            Self::OutputTooLarge => "Encoded image exceeds the supported byte limit",
            Self::EncodeFailed => "Image encoding failed",
            Self::Cancelled => "Image operation was cancelled",
        }
    }
}

impl fmt::Display for NativeImageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for NativeImageError {}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageDescriptor {
    pub handle_id: String,
    pub format: SourceFormat,
    pub width: u32,
    pub height: u32,
}

pub(crate) struct NativeImageEngine {
    ledger: Arc<store::BudgetLedger>,
    gate: WorkerGate,
    limits: EngineLimits,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OpenSourceKind {
    NodePath,
    WebViewBuffer { byte_length: usize },
}

impl NativeImageEngine {
    pub(crate) fn new() -> Self {
        Self::with_limits(EngineLimits::default())
    }

    fn with_limits(limits: EngineLimits) -> Self {
        Self {
            ledger: Arc::new(store::BudgetLedger::default()),
            gate: WorkerGate::default(),
            limits,
        }
    }

    pub(crate) fn new_session(&self) -> NativeImageSession {
        NativeImageSession::new(Arc::clone(&self.ledger))
    }

    /// The caller must move this permit into the blocking closure and keep it
    /// alive until that closure actually exits. Dropping an async waiter does
    /// not release the permit while the worker still owns it.
    pub(crate) fn try_worker(&self) -> Result<WorkerPermit, NativeImageError> {
        self.gate.try_acquire()
    }

    pub(crate) fn reserve_open(
        &self,
        session: &NativeImageSession,
        kind: OpenSourceKind,
    ) -> Result<OpenReservation, NativeImageError> {
        if !session.belongs_to(&self.ledger) {
            return Err(NativeImageError::InvalidRequest);
        }
        let (requested_bytes, exact_bytes) = match kind {
            OpenSourceKind::NodePath => (None, None),
            OpenSourceKind::WebViewBuffer { byte_length } => {
                if byte_length == 0 || byte_length > MAX_BUFFER_BYTES {
                    return Err(NativeImageError::SourceTooLarge);
                }
                (Some(byte_length), Some(byte_length))
            }
        };
        session.reserve_open(requested_bytes, exact_bytes, self.limits)
    }

    pub(crate) fn open_bytes(
        &self,
        session: &NativeImageSession,
        reservation: OpenReservation,
        bytes: Vec<u8>,
        _permit: WorkerPermit,
        cancellation: &CancellationToken,
    ) -> Result<ImageDescriptor, NativeImageError> {
        if !session.belongs_to(&self.ledger) {
            return Err(NativeImageError::InvalidRequest);
        }
        if !reservation.is_for(session) {
            return Err(NativeImageError::InvalidRequest);
        }
        if cancellation.is_cancelled() {
            return Err(NativeImageError::Cancelled);
        }
        if bytes.is_empty() || bytes.len() > reservation.max_bytes() {
            return Err(if bytes.len() > reservation.max_bytes() {
                NativeImageError::SourceTooLarge
            } else {
                NativeImageError::InvalidImage
            });
        }
        let validated = codec::validate_source(&bytes, self.limits)?;
        if cancellation.is_cancelled() {
            return Err(NativeImageError::Cancelled);
        }
        let opened = session.commit_open(reservation, bytes, validated)?;
        if session.is_closed() {
            return Err(NativeImageError::SessionClosed);
        }
        Ok(opened)
    }

    pub(crate) fn encode(
        &self,
        session: &NativeImageSession,
        handle_id: &str,
        request: &EncodeRequest,
        _permit: WorkerPermit,
        cancellation: &CancellationToken,
    ) -> Result<EncodedImage, NativeImageError> {
        if !session.belongs_to(&self.ledger) {
            return Err(NativeImageError::InvalidRequest);
        }
        if cancellation.is_cancelled() {
            return Err(NativeImageError::Cancelled);
        }
        let snapshot = session.snapshot(handle_id)?;
        let encoded = transform::encode(&snapshot, request, self.limits, cancellation)?;
        if cancellation.is_cancelled() || session.is_closed() {
            return Err(if cancellation.is_cancelled() {
                NativeImageError::Cancelled
            } else {
                NativeImageError::SessionClosed
            });
        }
        Ok(encoded)
    }
}
