//! Only same-run fixed seed files and verified staged renderer sources are read.
use super::super::{
    fixture_owner,
    profile::{HeightCase, Profile},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

pub(super) const A_RAW: &str = r#"{"autoBackToSearch":"never","autoClear":"never","autoPaste":"off","opacity":1.0,"r76Unknown":{"keep":"unchanged"},"showTrayIcon":false,"theme":"dark"}"#;
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn read_owned(path: &Path, limit: u64, private: bool) -> Result<Vec<u8>, String> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| e.to_string())?;
    let info = file.metadata().map_err(|e| e.to_string())?;
    if !info.is_file()
        || info.uid() != unsafe { libc::geteuid() }
        || info.nlink() != 1
        || info.len() > limit
        || private && info.mode() & 0o777 != 0o600
    {
        return Err("height fixture input ownership/size rejected".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("height fixture input exceeded limit".into());
    }
    Ok(bytes)
}

pub(super) fn import_seed(profile: &Profile, db_path: &Path) -> Result<Value, String> {
    fixture_owner::verify(profile).map_err(str::to_owned)?;
    let path = PathBuf::from(format!("{}.seed.sqlite", profile.root.display()));
    if profile.settings_height_case == Some(HeightCase::A) {
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => return Err("case a forbids seed input".into()),
            Err(error) => return Err(error.to_string()),
        }
        return Ok(Value::Null);
    }
    let bytes = read_owned(&path, 64 * 1024 * 1024, true)?;
    if !bytes.starts_with(b"SQLite format 3\0") {
        return Err("height seed must be SQLite".into());
    }
    // Destination is the new owned profile, never a user-selected database.
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW);
    let mut file = options.open(db_path).map_err(|e| e.to_string())?;
    use std::io::Write;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(json!({"path":path,"sha256":hash(&bytes),"bytes":bytes.len()}))
}

pub(super) struct Sources {
    main: PathBuf,
    settings: PathBuf,
    main_sha: String,
    settings_sha: String,
}
impl Sources {
    pub(super) fn new(
        profile: &Profile,
        settings: PathBuf,
        revision: String,
    ) -> Result<Self, String> {
        let main = profile.dist.canonicalize().map_err(|e| e.to_string())?;
        if main != profile.dist {
            return Err("height Main source must be canonical".into());
        }
        let settings = settings.canonicalize().map_err(|e| e.to_string())?;
        let main_sha = hash(&read_owned(
            &main.join("build-provenance.json"),
            256 * 1024,
            false,
        )?);
        let value = Self {
            main,
            settings,
            main_sha,
            settings_sha: revision,
        };
        value.validate(profile)?;
        Ok(value)
    }
    pub(super) fn validate(&self, profile: &Profile) -> Result<(), String> {
        profile.validate_settings_height_fixture()?;
        if self.main != profile.dist
            || hash(&read_owned(
                &self.main.join("build-provenance.json"),
                256 * 1024,
                false,
            )?) != self.main_sha
            || hash(&read_owned(
                &self.settings.join("build-provenance.json"),
                256 * 1024,
                false,
            )?) != self.settings_sha
        {
            return Err("height staged source identity changed".into());
        }
        Ok(())
    }
    pub(super) fn report(&self) -> Value {
        json!({"mainProvenanceSha256":self.main_sha,"settingsProvenanceSha256":self.settings_sha})
    }
    pub(super) fn revision(&self) -> &str {
        &self.settings_sha
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    #[test]
    fn fixed_seed_reader_rejects_public_permissions_symlinks_hardlinks_and_oversize() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("seed.sqlite");
        fs::write(&file, b"SQLite format 3\0fixture").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(read_owned(&file, 64, true).is_ok());
        assert!(read_owned(&file, 3, true).is_err());
        let link = dir.path().join("link");
        symlink(&file, &link).unwrap();
        assert!(read_owned(&link, 64, true).is_err());
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_owned(&file, 64, true).is_err());
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        fs::hard_link(&file, dir.path().join("hardlink")).unwrap();
        assert!(read_owned(&file, 64, true).is_err());
    }
}
