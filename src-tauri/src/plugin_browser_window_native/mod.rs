//! Restricted Tauri-native shells for plugin-owned BrowserWindow documents.

mod actions;
mod adapter;
mod background_throttling;
mod dragging;
mod options;
mod platform;
mod size_policy;
mod snapshot;

pub use actions::apply_action;
pub(crate) use actions::start_dragging;
pub use adapter::{attach_parent, create_main_from_config};
pub(crate) use dragging::StartAuthorization;
pub use options::WindowSpec;
pub use snapshot::{forget_window, snapshot, NativeBounds, NativeSnapshot};
