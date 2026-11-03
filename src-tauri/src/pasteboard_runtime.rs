//! Native, local-first clipboard capture coordinator.

mod capture;
mod current_context;
#[cfg(test)]
mod current_context_projection_tests;
mod current_context_runtime;
#[cfg(test)]
mod current_context_tests;
mod history_projection;
#[cfg(test)]
mod history_projection_tests;
mod model;
#[cfg(test)]
mod retention_defaults_tests;
mod runtime_ops;
mod support;
#[cfg(test)]
mod tests;

#[cfg(test)]
pub(crate) use current_context::LastCopiedFile;
pub(crate) use current_context::{
    validate_time_limit, LastCopiedContent, CURRENT_CONTEXT_MAX_FILES,
    CURRENT_CONTEXT_MAX_IMAGE_INPUT_BYTES, CURRENT_CONTEXT_MAX_PATH_BYTES,
    CURRENT_CONTEXT_MAX_RESPONSE_BYTES, CURRENT_CONTEXT_MAX_TEXT_BYTES,
};
pub use model::{
    CaptureOutcome, NativePasteboardRepresentation, NativePasteboardSnapshot, PasteOutcome,
    PasteStackStatus, PasteboardBackend, PasteboardCaptureStatus,
};
pub use runtime_ops::PasteboardRuntime;
