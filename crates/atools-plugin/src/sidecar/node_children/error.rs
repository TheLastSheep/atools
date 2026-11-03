use crate::sidecar::SidecarError;
use serde_json::{json, Value};
use std::io;

#[derive(Clone, Debug)]
pub(super) struct RequestFailure {
    pub(super) code: String,
    pub(super) message: String,
    pub(super) errno: Option<i32>,
    pub(super) fatal_cleanup: Option<SidecarError>,
}

impl RequestFailure {
    pub(super) fn new(code: &str, message: impl Into<String>, errno: Option<i32>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            errno: errno.filter(|errno| *errno > 0),
            fatal_cleanup: None,
        }
    }

    pub(super) fn invalid(message: impl Into<String>) -> Self {
        Self::new("ERR_ATOOLS_CHILD_INVALID_REQUEST", message, None)
    }

    pub(super) fn limit(scope: &str, limit: usize) -> Self {
        Self::new(
            "ERR_ATOOLS_CHILD_LIMIT",
            format!("managed child {scope} limit {limit} is reached"),
            Some(libc::EAGAIN),
        )
    }

    pub(super) fn spawn(error: io::Error) -> Self {
        Self::new(
            "ERR_ATOOLS_CHILD_SPAWN_FAILED",
            error.to_string(),
            error.raw_os_error(),
        )
    }

    pub(super) fn signal(error: io::Error) -> Self {
        Self::new(
            "ERR_ATOOLS_CHILD_SIGNAL_FAILED",
            error.to_string(),
            error.raw_os_error(),
        )
    }

    pub(super) fn cleanup(cause: Self, cleanup: SidecarError) -> Self {
        let mut failure = Self::new(
            "ERR_ATOOLS_CHILD_CLEANUP_FAILED",
            format!("{}; cleanup failed: {cleanup}", cause.message),
            cause.errno,
        );
        failure.fatal_cleanup = Some(cleanup);
        failure
    }

    pub(super) fn to_value(&self) -> Value {
        let mut error = json!({"code":self.code,"message":self.message});
        if let Some(errno) = self.errno {
            error["errno"] = json!(errno);
        }
        error
    }
}
