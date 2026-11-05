//! Optional, independently stored private sync server.
//!
//! This crate is deliberately outside the desktop core's startup path. Its
//! database defaults to `data/standalone/ztools.db`; it never opens the
//! desktop user's `~/.atools` database.

#![allow(dead_code, clippy::all)]

mod auth;
mod budgets;
mod config;
mod http;
mod model;
mod store;
mod websocket;

pub use config::{BootstrapUser, Config, ConfigError};
pub use http::router;
pub use store::{Store, StoreError};

use std::sync::{atomic::AtomicUsize, Arc};

use thiserror::Error;
use uuid::Uuid;

/// Shared state for one server instance.
#[derive(Clone)]
pub struct AppState {
    pub(crate) config: Arc<Config>,
    pub(crate) store: Store,
    pub(crate) auth: Arc<auth::AuthService>,
    pub(crate) server_instance_id: Arc<str>,
    pub(crate) sync_epoch: i64,
    pub(crate) active_connections: Arc<AtomicUsize>,
    pub(crate) budgets: Arc<budgets::SyncBudgets>,
}

#[derive(Debug, Error)]
pub enum StartupError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("failed to initialize bootstrap user: {0}")]
    Bootstrap(String),
}

impl AppState {
    /// Opens only `config.database_path`, initializes its private schema, and
    /// optionally ensures the configured bootstrap owner exists.
    pub fn open(config: Config) -> Result<Self, StartupError> {
        config.validate()?;
        let store = Store::open(&config.database_path)?;
        let server_instance_id = store.server_instance_id().map_err(StartupError::Store)?;
        let sync_epoch = store.sync_epoch().map_err(StartupError::Store)?;
        let auth = Arc::new(auth::AuthService::new(
            store.clone(),
            config.jwt_secret.clone(),
        ));
        if let Some(owner) = &config.bootstrap_user {
            auth.ensure_user(&owner.uid, &owner.password)
                .map_err(|error| StartupError::Bootstrap(error.to_string()))?;
        }
        Ok(Self {
            config: Arc::new(config),
            store,
            auth,
            server_instance_id: Arc::from(server_instance_id),
            sync_epoch,
            active_connections: Arc::new(AtomicUsize::new(0)),
            budgets: Arc::new(budgets::SyncBudgets::default()),
        })
    }

    pub fn server_instance_id(&self) -> &str {
        &self.server_instance_id
    }
}

/// Create an opaque stable server identity when a new database is initialized.
pub(crate) fn new_server_identity() -> String {
    Uuid::new_v4().simple().to_string()
}
