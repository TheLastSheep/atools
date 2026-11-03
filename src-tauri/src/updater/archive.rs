//! Private retained package. Only the production download-Ok path constructs this value.
use super::{UpdateCommandError, UpdateMetadata};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    sync::{Arc, Mutex},
};
pub(crate) const MAX_ARCHIVE: u64 = 256 * 1024 * 1024;
pub struct VerifiedArchive {
    file: Mutex<File>,
    len: u64,
    digest: [u8; 32],
    pub(super) candidate_id: String,
    pub(super) update: Option<Arc<tauri_plugin_updater::Update>>,
}
fn error() -> UpdateCommandError {
    UpdateCommandError::new("archive_integrity", "更新包校验失败，请重新下载")
}
impl VerifiedArchive {
    pub(super) fn from_verified_download(
        metadata: &UpdateMetadata,
        bytes: Vec<u8>,
    ) -> Result<Self, UpdateCommandError> {
        if bytes.is_empty() || bytes.len() as u64 > MAX_ARCHIVE {
            return Err(UpdateCommandError::new(
                "archive_too_large",
                "更新包超出保留大小限制",
            ));
        }
        let mut file = anonymous_file().map_err(|_| error())?;
        let len = bytes.len() as u64;
        let digest = Sha256::digest(&bytes).into();
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| error())?;
        Ok(Self {
            file: Mutex::new(file),
            len,
            digest,
            candidate_id: metadata.candidate_id.clone(),
            update: metadata.prepared.clone(),
        })
    }
    pub(super) fn read_verified(&self) -> Result<Vec<u8>, UpdateCommandError> {
        let mut file = self.file.lock().map_err(|_| error())?;
        if self.len > MAX_ARCHIVE || file.metadata().map_err(|_| error())?.len() != self.len {
            return Err(error());
        }
        file.seek(SeekFrom::Start(0)).map_err(|_| error())?;
        let mut bytes = Vec::with_capacity(self.len as usize);
        std::io::Read::by_ref(&mut *file)
            .take(self.len + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| error())?;
        if bytes.len() as u64 != self.len || <[u8; 32]>::from(Sha256::digest(&bytes)) != self.digest
        {
            return Err(error());
        }
        Ok(bytes)
    }
    #[cfg(test)]
    pub(super) fn test_corrupt(&self) {
        self.file.lock().unwrap().set_len(0).unwrap();
    }
    #[cfg(test)]
    pub(super) fn test_verified(metadata: &UpdateMetadata) -> Self {
        Self::from_verified_download(
            metadata,
            b"test fixture, not real signature evidence".to_vec(),
        )
        .unwrap()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_archive_readback_rejects_same_length_tamper_and_truncation() {
        let m = UpdateMetadata {
            candidate_id: "1".repeat(32),
            prepared: None,
            current_version: "1.0.0".into(),
            version: "1.0.1".into(),
            date: None,
            body: None,
        };
        let archive = VerifiedArchive::test_verified(&m);
        assert!(archive.read_verified().is_ok());
        {
            let mut f = archive.file.lock().unwrap();
            f.seek(SeekFrom::Start(0)).unwrap();
            f.write_all(b"X").unwrap();
        }
        assert_eq!(
            archive.read_verified().unwrap_err().code,
            "archive_integrity"
        );
        archive.file.lock().unwrap().set_len(0).unwrap();
        assert!(archive.read_verified().is_err());
    }
}

fn anonymous_file() -> std::io::Result<File> {
    let path =
        std::env::temp_dir().join(format!("atools-update-{}", uuid::Uuid::new_v4().simple()));
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x04000100).share_mode(0);
    }
    let file = options.open(&path)?;
    #[cfg(unix)]
    std::fs::remove_file(path)?;
    Ok(file)
}
