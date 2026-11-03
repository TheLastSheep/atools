use atools_core::{
    db::Database,
    models::{Document, Plugin},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

pub(super) const DOCUMENT_ID: &str = "atools-cold-start-state";
pub(super) const ATTACHMENT_NAME: &str = "cold-start-state.txt";
const ATTACHMENT_BYTES: &[u8] = b"ATools builtin cold-start state fixture\n";
const DOCUMENT_MARKER: &str = "builtin-cold-start-state-v1";

#[derive(Clone)]
pub(super) struct DatabaseIdentity {
    pub(super) device: String,
    pub(super) inode: String,
}

pub(super) fn database_path(root: &Path) -> PathBuf {
    root.join("app-data/data.db")
}

pub(super) fn database_identity(path: &Path) -> Option<DatabaseIdentity> {
    let before = fs::symlink_metadata(path).ok()?;
    if !before.file_type().is_file() || before.nlink() != 1 {
        return None;
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .ok()?;
    let opened = file.metadata().ok()?;
    if !opened.is_file()
        || opened.dev() != before.dev()
        || opened.ino() != before.ino()
        || opened.nlink() != 1
    {
        return None;
    }
    Some(DatabaseIdentity {
        device: opened.dev().to_string(),
        inode: opened.ino().to_string(),
    })
}

pub(super) fn timestamp_plugin(db: &Database, expected_path: &Path) -> Option<Plugin> {
    let expected_path = expected_path.canonicalize().ok()?;
    let plugins = db.list_plugins().ok()?;
    let matching = plugins
        .into_iter()
        .filter(|plugin| {
            plugin.name == "timestamp"
                && plugin.manifest.name == "timestamp"
                && plugin.manifest.features.len() == 1
                && plugin.manifest.features[0].code == "timestamp"
                && Path::new(&plugin.path)
                    .canonicalize()
                    .is_ok_and(|path| path == expected_path)
        })
        .collect::<Vec<_>>();
    (matching.len() == 1)
        .then(|| matching.into_iter().next())
        .flatten()
}

pub(super) fn fingerprint_created_at(db: &Database, plugin_id: &str) -> Option<String> {
    let plugin = db.get_plugin(plugin_id).ok()?;
    Some(format!(
        "{:x}",
        Sha256::digest(plugin.created_at.as_bytes())
    ))
}

pub(super) fn write_document(db: &Database, plugin_id: &str, run_id: &str) -> bool {
    let document = Document {
        id: DOCUMENT_ID.to_owned(),
        rev: None,
        data: json!({"marker": DOCUMENT_MARKER, "runId": run_id}),
    };
    db.plugin_data_put(plugin_id, &document).is_ok()
}

pub(super) fn write_attachment(db: &Database, plugin_id: &str) -> bool {
    db.put_attachment(
        plugin_id,
        DOCUMENT_ID,
        ATTACHMENT_NAME,
        ATTACHMENT_BYTES,
        "text/plain",
    )
    .is_ok()
}

pub(super) fn state_matches(db: &Database, plugin_id: &str, run_id: &str) -> (bool, bool) {
    let document = db
        .plugin_data_get_bounded(plugin_id, DOCUMENT_ID)
        .ok()
        .flatten();
    let document_ok = document.is_some_and(|document| {
        document.data["marker"].as_str() == Some(DOCUMENT_MARKER)
            && document.data["runId"].as_str() == Some(run_id)
    });
    let attachment_ok = db
        .get_attachment(plugin_id, DOCUMENT_ID, ATTACHMENT_NAME)
        .ok()
        .flatten()
        .is_some_and(|(bytes, content_type)| {
            bytes == ATTACHMENT_BYTES && content_type == "text/plain"
        });
    (document_ok, attachment_ok)
}
