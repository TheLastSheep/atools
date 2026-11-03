//! Durable code identity, independent of manifest version and wall-clock precision.
use atools_core::db::Database;
use sha2::{Digest, Sha256};

pub(crate) struct CodeRevision {
    key: String,
    token: String,
}

fn key(id: &str) -> String {
    format!("plugin_code_revision.{:x}", Sha256::digest(id.as_bytes()))
}

impl CodeRevision {
    /// Caller owns the plugin write gate. An interrupted write stays visibly
    /// incomplete until a new managed installation/update finishes successfully.
    pub(crate) fn begin(db: &Database, id: &str) -> Result<Self, String> {
        let revision = Self {
            key: key(id),
            token: uuid::Uuid::new_v4().to_string(),
        };
        db.set_setting(&revision.key, &format!("changing:{}", revision.token))
            .map_err(|error| error.to_string())?;
        Ok(revision)
    }

    pub(crate) fn finish(self, db: &Database) -> Result<(), String> {
        if db
            .get_setting(&self.key)
            .map_err(|error| error.to_string())?
            .as_deref()
            != Some(format!("changing:{}", self.token).as_str())
        {
            return Err("Plugin code revision changed during installation".into());
        }
        db.set_setting(&self.key, &format!("ready:{}", self.token))
            .map_err(|error| error.to_string())
    }
}

pub(crate) fn current(db: &Database, id: &str) -> Result<Option<String>, String> {
    let Some(value) = db
        .get_setting(&key(id))
        .map_err(|error| error.to_string())?
    else {
        return Ok(None); // Existing installations acquire a revision on their first mutation.
    };
    let token = value.strip_prefix("ready:").ok_or(
        "Plugin code change has not completed; reinstall or update the plugin before starting a new task"
    )?;
    uuid::Uuid::parse_str(token).map_err(|_| "Invalid plugin code revision".to_string())?;
    Ok(Some(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revisions_rotate_without_clock_or_manifest_changes_and_are_plugin_scoped() {
        let db = Database::in_memory().unwrap();
        assert_eq!(current(&db, "a").unwrap(), None);
        CodeRevision::begin(&db, "a").unwrap().finish(&db).unwrap();
        let first = current(&db, "a").unwrap();
        let next = CodeRevision::begin(&db, "a").unwrap();
        assert!(current(&db, "a").is_err());
        assert_eq!(current(&db, "b").unwrap(), None);
        next.finish(&db).unwrap();
        assert_ne!(current(&db, "a").unwrap(), first);
    }

    #[test]
    fn interrupted_revision_survives_database_reopen_and_requires_a_new_mutation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("revision.sqlite");
        let db = Database::open(&path).unwrap();
        drop(CodeRevision::begin(&db, "a").unwrap());
        drop(db);
        let db = Database::open(&path).unwrap();
        assert!(current(&db, "a").is_err());
        CodeRevision::begin(&db, "a").unwrap().finish(&db).unwrap();
        assert!(current(&db, "a").unwrap().is_some());
    }
}
