//! Central error types for the atools-core crate.

/// The main error type for all ATools core operations.
#[derive(Debug, thiserror::Error)]
pub enum AToolsError {
    /// An error originating from the SQLite database layer.
    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),

    /// An I/O error from the standard library.
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    /// A JSON serialization/deserialization error.
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// A plugin-specific error (e.g. manifest parsing, lifecycle).
    #[error("Plugin error: {0}")]
    Plugin(String),

    /// A configuration error (e.g. missing paths, invalid settings).
    #[error("Config error: {0}")]
    Config(String),

    /// Raised when a requested feature cannot be found in the index.
    #[error("Feature not found: {0}")]
    FeatureNotFound(String),
}

/// Convenience alias used throughout the crate.
pub type Result<T> = std::result::Result<T, AToolsError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_display() {
        let e = AToolsError::Plugin("bad manifest".into());
        assert_eq!(e.to_string(), "Plugin error: bad manifest");
    }

    #[test]
    fn from_io() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "gone");
        let e: AToolsError = io_err.into();
        assert!(matches!(e, AToolsError::Io(_)));
    }
}
