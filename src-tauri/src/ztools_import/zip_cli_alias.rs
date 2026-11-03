//! Compatibility names for the frozen local ZIP fixtures; implementation lives in plugin_zip_archive.
pub(super) const MAX_ALIAS_TARGET_BYTES: usize = 4096;

#[allow(dead_code)]
pub(super) fn is_cli_alias_path(path: &str) -> bool {
    crate::plugin_zip_archive::is_cli_alias_path(path)
}

#[allow(dead_code)]
pub(super) fn resolve_target(
    alias_path: &str,
    target: &str,
    _prefix: &str,
) -> Result<String, String> {
    crate::plugin_zip_archive::resolve_cli_alias_target(alias_path, target)
}
