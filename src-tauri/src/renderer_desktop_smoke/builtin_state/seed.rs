use super::{report, storage};
use crate::renderer_desktop_smoke::{profile::Profile, settings_input_journey};
use atools_core::{config::AppConfig, db::Database};
use std::sync::Arc;

const PACKAGE_INVALID: &str = "builtin-state-seed-package-invalid";
const METADATA_FAILED: &str = "builtin-state-seed-metadata-register-failed";
const DISABLE_FAILED: &str = "builtin-state-seed-disabled-write-failed";
const STATE_INVALID: &str = "builtin-state-seed-state-invalid";
const DOCUMENT_FAILED: &str = "builtin-state-seed-document-write-failed";
const ATTACHMENT_FAILED: &str = "builtin-state-seed-attachment-write-failed";
const DATABASE_INVALID: &str = "builtin-state-seed-database-identity-invalid";
const REPORT_FAILED: &str = "builtin-state-seed-report-write-failed";

pub(super) async fn run(profile: &Profile) -> Result<(), String> {
    let mut report_value = report::SeedReport::new(profile);
    if let Err(error) = seed_database(profile, &mut report_value).await {
        report::add_error(&mut report_value.errors, error);
    }
    report::write_seed(profile, &report_value).map_err(|_| REPORT_FAILED.to_owned())?;
    if let Some(error) = report_value.errors.first() {
        return Err((*error).to_owned());
    }
    Ok(())
}

async fn seed_database(
    profile: &Profile,
    output: &mut report::SeedReport,
) -> Result<(), &'static str> {
    let builtin_dir =
        settings_input_journey::staged_builtin_plugins_dir().map_err(|_| PACKAGE_INVALID)?;
    output.observations.staged_package_valid = Some(true);
    let config = AppConfig::with_base_dir(profile.root.join("app-data"));
    config.ensure_dirs().map_err(|_| METADATA_FAILED)?;
    let db = Arc::new(Database::open(&config.db_path()).map_err(|_| METADATA_FAILED)?);
    let general = settings_input_journey::builtin_state_general_seed().to_string();
    db.set_setting("settings-general", &general)
        .map_err(|_| STATE_INVALID)?;
    let stored_general = db
        .get_setting("settings-general")
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
    let tray_configured_visible = stored_general
        .as_ref()
        .and_then(|value| value.get("showTrayIcon"))
        .and_then(serde_json::Value::as_bool);
    output.observations.tray_setting_stored = tray_configured_visible.map(|value| !value);
    output.observations.tray_configured_visible = tray_configured_visible;
    if output.observations.tray_setting_stored != Some(true)
        || output.observations.tray_configured_visible != Some(false)
    {
        return Err(STATE_INVALID);
    }
    crate::builtin_plugins::load_builtin_plugins(Arc::clone(&db), Some(builtin_dir.clone()))
        .await
        .map_err(|_| METADATA_FAILED)?;
    output.observations.metadata_registered = Some(true);

    let package_dir = builtin_dir.join("timestamp");
    let plugin = storage::timestamp_plugin(&db, &package_dir).ok_or(STATE_INVALID)?;
    output.observations.plugin_id_resolved = Some(true);
    if !plugin.enabled {
        return Err(STATE_INVALID);
    }
    let mut disabled = plugin;
    disabled.enabled = false;
    disabled.updated_at = atools_core::utils::now_iso();
    db.save_plugin_with_features(&disabled, &disabled.manifest.features)
        .map_err(|_| DISABLE_FAILED)?;
    let stored = db.get_plugin(&disabled.id).map_err(|_| DISABLE_FAILED)?;
    output.observations.disable_committed = Some(!stored.enabled);
    output.observations.enabled_after_disable = Some(stored.enabled);
    if stored.enabled {
        return Err(DISABLE_FAILED);
    }

    let (document, attachment) = storage::state_matches(&db, &stored.id, &profile.run_id);
    if document || attachment {
        return Err(STATE_INVALID);
    }
    let document_written = storage::write_document(&db, &stored.id, &profile.run_id);
    output.observations.document_written = Some(document_written);
    if !document_written {
        return Err(DOCUMENT_FAILED);
    }
    let attachment_written = storage::write_attachment(&db, &stored.id);
    output.observations.attachment_written = Some(attachment_written);
    if !attachment_written {
        return Err(ATTACHMENT_FAILED);
    }
    let (document_after, attachment_after) =
        storage::state_matches(&db, &stored.id, &profile.run_id);
    if !document_after {
        return Err(DOCUMENT_FAILED);
    }
    if !attachment_after {
        return Err(ATTACHMENT_FAILED);
    }
    output.observations.created_at_fingerprint = storage::fingerprint_created_at(&db, &stored.id);
    drop(db);
    let identity = storage::database_identity(&storage::database_path(&profile.root));
    report::apply_database_identity(
        &mut output.observations.database_device,
        &mut output.observations.database_inode,
        identity,
    );
    if output.observations.database_device.is_none()
        || output.observations.database_inode.is_none()
        || output.observations.created_at_fingerprint.is_none()
    {
        return Err(DATABASE_INVALID);
    }
    Ok(())
}
