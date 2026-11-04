//! Pure, lossless App-global binding storage. Native catalog authorization is a caller duty.
#[path = "renderer_app_global_shortcuts_mutation.rs"]
mod mutation;
#[path = "renderer_app_global_shortcuts_raw.rs"]
mod raw;
#[cfg(test)]
#[path = "renderer_app_global_shortcuts_tests.rs"]
mod tests;
use super::{Database, RendererAppIdentity};
use crate::error::{AToolsError, Result};
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};

pub const APP_GLOBAL_SHORTCUTS_KEY: &str = "ztools-renderer:global-shortcuts";
pub const APP_GLOBAL_SHORTCUT_TARGETS_KEY: &str = "ztools-renderer:app-global-shortcut-targets";
pub const APP_GLOBAL_SHORTCUT_REVISION_KEY: &str = "ztools-renderer:app-global-shortcuts-revision";
pub const APP_GLOBAL_SHORTCUT_CONFLICT: &str = "App global shortcut snapshot conflict";
pub const APP_GLOBAL_SHORTCUT_GUARD_REJECTED: &str = "App global shortcut commit guard rejected";
const MAX_BYTES: usize = 128 * 1024;
const MAX_REVISION: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppGlobalShortcutBinding {
    pub row_id: String,
    pub path: String,
    pub name: String,
    pub shortcut: String,
    pub enabled: bool,
    pub generation: String,
    /// False means public-row drift: never restore/dispatch or implicitly adopt this binding.
    pub public_matches: bool,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppGlobalShortcutSnapshot {
    pub revision: u64,
    pub public_raw: Option<String>,
    pub authority_raw: Option<String>,
    pub revision_raw: Option<String>,
    pub bindings: Vec<AppGlobalShortcutBinding>,
}
#[derive(Clone, Debug)]
pub enum AppGlobalShortcutMutation {
    Create {
        target: RendererAppIdentity,
        shortcut: String,
        enabled: bool,
    },
    Update {
        row_id: String,
        target: RendererAppIdentity,
        shortcut: String,
        enabled: bool,
    },
    Adopt {
        row_id: String,
        target: RendererAppIdentity,
        shortcut: String,
        enabled: bool,
    },
    Remove {
        row_id: String,
    },
    SetEnabled {
        row_id: String,
        enabled: bool,
    },
}
/// Only prepare can construct a plan. Neither the front image nor CAS baseline is mutable.
#[derive(Debug)]
pub struct AppGlobalShortcutWritePlan {
    before: AppGlobalShortcutSnapshot,
    after: AppGlobalShortcutSnapshot,
}
impl AppGlobalShortcutWritePlan {
    pub fn before(&self) -> &AppGlobalShortcutSnapshot {
        &self.before
    }
    pub fn after(&self) -> &AppGlobalShortcutSnapshot {
        &self.after
    }
    pub fn changed(&self) -> bool {
        self.before != self.after
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppGlobalShortcutWrite {
    pub changed: bool,
    pub snapshot: AppGlobalShortcutSnapshot,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Authority {
    kind: AppKind,
    path: String,
    name: String,
    shortcut: String,
    enabled: bool,
    generation: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum AppKind {
    App,
}

impl Database {
    pub fn read_renderer_app_global_shortcuts(&self) -> Result<AppGlobalShortcutSnapshot> {
        let mut connection = self.conn.lock();
        let tx = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
        let snapshot = read_snapshot(&tx)?;
        tx.commit()?;
        Ok(snapshot)
    }
    /// The target must already have been resolved against the current Native App catalog.
    /// Core checks only its shape/subtype, never claims OS authorization.
    pub fn prepare_renderer_app_global_shortcut_write(
        &self,
        expected: &AppGlobalShortcutSnapshot,
        change: AppGlobalShortcutMutation,
    ) -> Result<AppGlobalShortcutWritePlan> {
        let before = self.read_renderer_app_global_shortcuts()?;
        if before != *expected {
            return Err(invalid(APP_GLOBAL_SHORTCUT_CONFLICT));
        }
        let after = mutation::apply(&before, change)?;
        Ok(AppGlobalShortcutWritePlan { before, after })
    }
    /// Native applies OS effects outside SQLite locks, then commits this exact private plan.
    /// Guard is synchronous and must not reenter this DB or wait for OS/UI work.
    pub fn commit_renderer_app_global_shortcut_write_guarded<F: FnOnce() -> bool>(
        &self,
        plan: AppGlobalShortcutWritePlan,
        guard: F,
    ) -> Result<AppGlobalShortcutWrite> {
        let mut connection = self.conn.lock();
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if read_snapshot(&tx)? != plan.before {
            return Err(invalid(APP_GLOBAL_SHORTCUT_CONFLICT));
        }
        let changed = plan.changed();
        if changed {
            for (key, value) in [
                (APP_GLOBAL_SHORTCUTS_KEY, plan.after.public_raw.as_deref()),
                (
                    APP_GLOBAL_SHORTCUT_TARGETS_KEY,
                    plan.after.authority_raw.as_deref(),
                ),
                (
                    APP_GLOBAL_SHORTCUT_REVISION_KEY,
                    plan.after.revision_raw.as_deref(),
                ),
            ] {
                let value = value.ok_or_else(|| invalid("Missing prepared document"))?;
                tx.execute(
                    "INSERT OR REPLACE INTO settings (key,value) VALUES (?1,?2)",
                    params![key, value],
                )?;
            }
        }
        // Last caller fence, inside the same transaction, after all fallible writes.
        if !guard() {
            return Err(invalid(APP_GLOBAL_SHORTCUT_GUARD_REJECTED));
        }
        tx.commit()?;
        Ok(AppGlobalShortcutWrite {
            changed,
            snapshot: plan.after,
        })
    }
}
fn read_snapshot(tx: &Transaction<'_>) -> Result<AppGlobalShortcutSnapshot> {
    let get = |key: &str| -> Result<Option<String>> {
        let size: Option<i64> = tx
            .query_row(
                "SELECT length(CAST(value AS BLOB)) FROM settings WHERE key=?1",
                [key],
                |r| r.get(0),
            )
            .optional()?;
        if size.is_some_and(|n| n < 0 || n as usize > MAX_BYTES) {
            return Err(invalid("Stored document exceeds 128 KiB"));
        }
        Ok(tx
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()?)
    };
    raw::snapshot(
        get(APP_GLOBAL_SHORTCUTS_KEY)?,
        get(APP_GLOBAL_SHORTCUT_TARGETS_KEY)?,
        get(APP_GLOBAL_SHORTCUT_REVISION_KEY)?,
    )
}
fn invalid(message: &str) -> AToolsError {
    AToolsError::Config(message.to_owned())
}
