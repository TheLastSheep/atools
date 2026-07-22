mod json_rpc;
mod mcp_stdio;
mod supervisor;

pub use json_rpc::{JsonRpcSidecar, SidecarContent, SidecarToolResult};
pub use mcp_stdio::{McpInitializeResult, McpSidecar, McpTool};
pub use supervisor::{
    SidecarError, SidecarLaunchSpec, SidecarProcess, SidecarStatus, SidecarSupervisor,
};
