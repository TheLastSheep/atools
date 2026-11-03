//! Persistence contract for the original renderer's command alias map.

#[path = "renderer_command_aliases_mutation.rs"]
mod mutation;
#[path = "renderer_command_aliases_normalize.rs"]
mod normalize;

#[cfg(test)]
#[path = "renderer_command_aliases_tests.rs"]
mod tests;

use serde_json::Value;

use super::Database;
use crate::error::Result;

pub use mutation::{RendererCommandAliasesSnapshot, RendererCommandAliasesWrite};
pub use normalize::normalize_renderer_command_aliases;

impl Database {
    /// Reads the exact storage value and its normalized renderer projection.
    pub fn read_renderer_command_aliases(&self) -> Result<RendererCommandAliasesSnapshot> {
        mutation::read(self)
    }

    /// Applies one exact raw-value compare-and-swap to the renderer alias map.
    pub fn mutate_renderer_command_aliases(
        &self,
        expected: Option<&str>,
        desired: &Value,
    ) -> Result<RendererCommandAliasesWrite> {
        mutation::mutate(self, expected, desired)
    }

    /// Applies the alias compare-and-swap only if `guard` still permits it after SQLite has
    /// acquired the Immediate transaction. A false guard leaves the setting untouched.
    pub fn mutate_renderer_command_aliases_guarded<F>(
        &self,
        expected: Option<&str>,
        desired: &Value,
        guard: F,
    ) -> Result<RendererCommandAliasesWrite>
    where
        F: FnOnce() -> bool,
    {
        mutation::mutate_guarded(self, expected, desired, guard)
    }
}
