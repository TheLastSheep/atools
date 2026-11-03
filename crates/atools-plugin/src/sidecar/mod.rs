mod io;
mod launch;
mod node_runtime;
mod node_runtime_selection;
pub(crate) use node_runtime::resolve_node_binary;
mod json_rpc;
mod mcp_stdio;
pub(crate) mod node_children;
pub mod node_runtime_cache;
mod process;
mod process_loop;
mod registry;
mod response;
pub(crate) mod startup_diagnostics;
#[cfg(all(test, feature = "native-smoke"))]
#[path = "startup_diagnostics_tests.rs"]
mod startup_diagnostics_tests;
mod stdout_observation;
mod supervisor;

pub use json_rpc::{JsonRpcSidecar, SidecarContent, SidecarToolResult};
pub use mcp_stdio::{McpInitializeResult, McpSidecar, McpTool};
pub use node_runtime_selection::{CompressedNodeRuntimeProvider, NodeRuntimeSelector};
pub use registry::SidecarSupervisor;
pub use startup_diagnostics::{
    StartupDiagnosticSnapshot, StartupEvent, StartupFailureDiagnostic, StartupFailureKind,
    StartupParseOutcome, StartupPhase, StartupProcessStatus, StartupResolutionSource,
    StartupResponseOutcome, StartupTryWait, StartupVersionSource,
};
pub use stdout_observation::StartupStdoutReadSnapshot;
pub use supervisor::{SidecarError, SidecarLaunchSpec, SidecarProcess, SidecarStatus};

#[cfg(all(test, feature = "native-smoke"))]
#[path = "startup_diagnostics_process_tests.rs"]
mod startup_diagnostics_process_tests;

#[cfg(all(test, feature = "native-smoke"))]
#[path = "io_observation_tests.rs"]
mod io_observation_tests;

#[cfg(all(test, unix))]
#[path = "drop_queue_tests.rs"]
mod drop_queue_tests;

#[cfg(all(test, unix))]
#[path = "process_lifecycle_tests.rs"]
mod process_lifecycle_tests;
