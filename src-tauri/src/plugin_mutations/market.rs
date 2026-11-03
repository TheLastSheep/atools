//! Download/inspect first, then coordinate only the actual plugin's write phase.
use super::*;
use crate::commands::{
    PluginMarketProgressContext, PluginMarketProgressEvent, PluginPersistencePolicy,
};
use crate::plugin_zip_archive;
use tauri::Emitter;

struct PreparedMarketPackage {
    root: PathBuf,
    source: PathBuf,
    id: String,
}
impl Drop for PreparedMarketPackage {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Validate the catalog version before any network or filesystem work begins.
/// Preserve the supplied bytes exactly: market versions are opaque identifiers.
pub(crate) fn validate_expected_version(expected_version: Option<&str>) -> Result<(), String> {
    if expected_version.is_some_and(|version| {
        version.is_empty() || version.len() > 128 || version.chars().any(char::is_control)
    }) {
        return Err(
            "Plugin market expected version must be 1-128 UTF-8 bytes without control characters"
                .into(),
        );
    }
    Ok(())
}

fn prepare(
    config: &AppConfig,
    bytes: &[u8],
    url: &str,
    expected: Option<&str>,
    expected_version: Option<&str>,
) -> Result<PreparedMarketPackage, String> {
    validate_expected_version(expected_version)?;
    let root = commands::plugin_market_staging_dir(config);
    std::fs::create_dir_all(root.parent().ok_or("Invalid staging parent")?)
        .map_err(|error| error.to_string())?;
    // This operation owns only a newly-created staging directory, never an old path.
    std::fs::create_dir(&root).map_err(|error| error.to_string())?;
    let mut staged = PreparedMarketPackage {
        root,
        source: PathBuf::new(),
        id: String::new(),
    };
    let index = plugin_zip_archive::stage_market_archive(bytes, &staged.root, url)?;
    let source = if atools_plugin::package_resolution::has_manifest_candidate(&staged.root) {
        staged.root.clone()
    } else {
        commands::plugin_market_staged_plugin_dir(&staged.root)?
    };
    let resolved = atools_plugin::package_resolution::resolve_plugin_package(&source)
        .map_err(|error| error.to_string())?;
    index.validate_market_scope(&staged.root, &resolved.package_root)?;
    let package = plugin_packages::local_package(&source)?;
    staged.id = atools_core::utils::sanitize_id(&package.manifest.name);
    if expected.is_some_and(|expected| expected != staged.id) {
        return Err("Plugin market archive id does not match the selected plugin".into());
    }
    if expected_version.is_some_and(|expected| expected != package.manifest.version) {
        return Err("Plugin market archive version does not match the confirmed version".into());
    }
    staged.source = package.package_root;
    Ok(staged)
}

fn apply_prepared(
    db: &Database,
    config: &AppConfig,
    prepared: &PreparedMarketPackage,
    updating: bool,
) -> Result<Plugin, String> {
    if updating {
        commands::plugin_update_from_path_with_policy_inner(
            db,
            config,
            &prepared.id,
            &prepared.source,
            PluginPersistencePolicy::Market,
        )
    } else {
        commands::install_plugin_from_directory_checked_with_policy_inner(
            db,
            config,
            &prepared.source,
            Some(&prepared.id),
            PluginPersistencePolicy::Market,
        )
    }
}

#[cfg(test)]
pub(crate) fn apply_archive_for_test(
    db: &Database,
    config: &AppConfig,
    bytes: &[u8],
    url: &str,
    expected: Option<&str>,
    updating: bool,
) -> Result<Plugin, String> {
    apply_archive_for_test_with_version(db, config, bytes, url, expected, None, updating)
}

#[cfg(test)]
pub(crate) fn apply_archive_for_test_with_version(
    db: &Database,
    config: &AppConfig,
    bytes: &[u8],
    url: &str,
    expected: Option<&str>,
    expected_version: Option<&str>,
    updating: bool,
) -> Result<Plugin, String> {
    let prepared = prepare(config, bytes, url, expected, expected_version)?;
    apply_prepared(db, config, &prepared, updating)
}

fn progress(
    app: &AppHandle,
    context: &PluginMarketProgressContext,
    stage: &str,
    length: usize,
    message: &str,
) {
    let event = commands::plugin_market_progress_event(
        context,
        stage,
        length as u64,
        Some(length as u64),
        1,
        message,
    );
    let _ = app.emit("plugin-market-progress", event);
}

#[allow(clippy::too_many_arguments)]
async fn apply(
    app: &AppHandle,
    db: Arc<Database>,
    config: AppConfig,
    expected: Option<String>,
    expected_version: Option<String>,
    download_url: &str,
    checksum: Option<&str>,
    signature: Option<&str>,
    public_key: Option<&str>,
    context: PluginMarketProgressContext,
    updating: bool,
) -> Result<Plugin, String> {
    validate_expected_version(expected_version.as_deref())?;
    let progress_app = app.clone();
    let mut emit = move |event: PluginMarketProgressEvent| {
        let _ = progress_app.emit("plugin-market-progress", event);
    };
    let (bytes, url) = commands::download_plugin_market_archive_with_progress_ref(
        download_url,
        checksum,
        signature,
        public_key,
        context.clone(),
        &mut emit,
    )
    .await?;
    let length = bytes.len();
    let inspect_config = config.clone();
    let inspect_id = expected.clone();
    let inspect_version = expected_version.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        prepare(
            &inspect_config,
            &bytes,
            &url,
            inspect_id.as_deref(),
            inspect_version.as_deref(),
        )
    })
    .await
    .map_err(|error| error.to_string())??;
    let id = prepared.id.clone();
    let mut actual_context = context;
    actual_context.plugin_id = Some(id.clone());
    progress(
        app,
        &actual_context,
        "installing",
        length,
        "正在写入插件目录",
    );
    let operation_db = db.clone();
    let reason = if updating {
        ChangeReason::Updated
    } else {
        ChangeReason::Installed
    };
    let result = lifecycle::mutate(app, db, &id, reason, move || {
        apply_prepared(&operation_db, &config, &prepared, updating)
    })
    .await;
    if result.is_ok() {
        progress(app, &actual_context, "finished", length, "插件安装完成");
    }
    result
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn install_from_market(
    app: &AppHandle,
    db: Arc<Database>,
    config: AppConfig,
    expected: Option<String>,
    expected_version: Option<String>,
    download_url: &str,
    checksum: Option<&str>,
    signature: Option<&str>,
    public_key: Option<&str>,
    context: PluginMarketProgressContext,
) -> Result<Plugin, String> {
    apply(
        app,
        db,
        config,
        expected,
        expected_version,
        download_url,
        checksum,
        signature,
        public_key,
        context,
        false,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn update_from_market(
    app: &AppHandle,
    db: Arc<Database>,
    config: AppConfig,
    id: String,
    expected_version: Option<String>,
    download_url: &str,
    checksum: Option<&str>,
    signature: Option<&str>,
    public_key: Option<&str>,
    context: PluginMarketProgressContext,
) -> Result<Plugin, String> {
    apply(
        app,
        db,
        config,
        Some(id),
        expected_version,
        download_url,
        checksum,
        signature,
        public_key,
        context,
        true,
    )
    .await
}

#[cfg(test)]
#[path = "market_tests.rs"]
mod tests;
