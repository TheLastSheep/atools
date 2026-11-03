//! Shared ZIP validation/materialization for local and market plugin packages.
mod index;
mod limits;
mod materialize;
mod path;
#[cfg(test)]
mod tests;

pub(crate) use index::{FileEntry, ZipArchiveIndex};
pub(crate) use limits::ZipLimits;

mod market;
pub(crate) use market::stage_market_archive;

pub(crate) fn is_cli_alias_path(path: &str) -> bool {
    self::path::is_cli_alias(path)
}
pub(crate) fn resolve_cli_alias_target(alias: &str, target: &str) -> Result<String, String> {
    self::path::resolve_alias_target(alias, target)
}
