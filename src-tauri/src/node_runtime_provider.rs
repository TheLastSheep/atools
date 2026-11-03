use atools_plugin::sidecar::NodeRuntimeSelector;
use tauri::{AppHandle, Runtime};

#[cfg(feature = "compressed-node-runtime")]
#[path = "node_runtime_provider/configured.rs"]
mod configured;

pub(crate) fn for_app<R: Runtime>(app: &AppHandle<R>) -> NodeRuntimeSelector {
    #[cfg(feature = "compressed-node-runtime")]
    {
        configured::for_app(app)
    }
    #[cfg(not(feature = "compressed-node-runtime"))]
    {
        let _ = app;
        NodeRuntimeSelector::system_default()
    }
}
