#[cfg(any(target_os = "macos", target_os = "linux"))]
mod child_io;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod error;
mod launch;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod managed_child;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod owner;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod protocol;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod requests;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod spawn;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod transport;

pub(crate) use launch::NodeChildrenLaunch;

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) use owner::NodeChildrenOwner;

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
#[derive(Clone)]
pub(crate) struct NodeChildrenOwner;

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
impl NodeChildrenOwner {
    pub(crate) async fn close(&self) -> Result<(), super::SidecarError> {
        Ok(())
    }

    pub(super) fn unsupported() -> Self {
        Self
    }
}
