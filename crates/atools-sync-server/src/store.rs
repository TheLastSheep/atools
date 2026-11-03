mod auth;
mod schema;
mod sync;

use std::{
    fs::OpenOptions,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};

use rusqlite::Connection;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("sqlite operation failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("document JSON encode/decode failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("checkpoint id is required")]
    MissingCheckpointId,
    #[error("sync payload is not supported: {0}")]
    UnsupportedPayload(&'static str),
    #[error("document revision update is not a supported linear extension: {0}")]
    RevisionConflict(&'static str),
    #[error("sync payload exceeds the configured size budget")]
    PayloadTooLarge,
    #[error("snapshot exceeds the configured document or byte budget")]
    SnapshotTooLarge,
    #[error("document id is required")]
    MissingDocumentId,
    #[error("document revision is required")]
    MissingRevision,
    #[error("database path may not point at the desktop ATools database")]
    DesktopDatabasePath,
    #[error("failed to prepare standalone database directory: {0}")]
    Directory(#[from] std::io::Error),
    #[error("database lock was poisoned")]
    Poisoned,
}

#[derive(Clone)]
pub struct Store {
    pub(super) database_path: Arc<PathBuf>,
    pub(super) connection: Arc<Mutex<Connection>>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        if schema::is_desktop_database(path) {
            return Err(StoreError::DesktopDatabasePath);
        }
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            crate::config::ensure_private_directory(parent)?;
        }
        if schema::is_desktop_database(path) {
            return Err(StoreError::DesktopDatabasePath);
        }
        if !path.exists() {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(path) {
                Ok(file) => drop(file),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(StoreError::Directory(error)),
            }
        }
        if schema::is_desktop_database(path) {
            return Err(StoreError::DesktopDatabasePath);
        }
        let connection = Connection::open(path)?;
        schema::initialize(&connection)?;
        let store = Self {
            database_path: Arc::new(path.to_path_buf()),
            connection: Arc::new(Mutex::new(connection)),
        };
        schema::ensure_metadata(&store)?;
        Ok(store)
    }

    pub fn database_path(&self) -> &Path {
        self.database_path.as_path()
    }

    pub(super) fn lock(&self) -> Result<MutexGuard<'_, Connection>, StoreError> {
        self.connection.lock().map_err(|_| StoreError::Poisoned)
    }
}
