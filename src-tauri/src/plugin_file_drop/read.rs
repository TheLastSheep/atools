use super::{
    binary::FileHeader,
    types::{MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES},
};
#[cfg(target_os = "macos")]
use std::path::Component;
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub(super) fn validate_count(paths: &[PathBuf]) -> Result<(), String> {
    if paths.is_empty() || paths.len() > MAX_FILES {
        return Err("FILE_DROP_COUNT".into());
    }
    Ok(())
}

pub(super) fn read_paths(
    paths: Vec<PathBuf>,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<(Vec<FileHeader>, Vec<u8>), String> {
    validate_count(&paths)?;
    let mut opened = Vec::with_capacity(paths.len());
    let mut total = 0usize;
    for path in paths {
        check()?;
        if !path.is_absolute() {
            return Err("FILE_DROP_PATH".into());
        }
        let before = fs::symlink_metadata(&path).map_err(|_| "FILE_DROP_READ")?;
        if before.file_type().is_symlink() || !before.is_file() {
            return Err("FILE_DROP_KIND".into());
        }
        if before.len() > MAX_FILE_BYTES as u64 {
            return Err("FILE_DROP_FILE_LIMIT".into());
        }
        total = total
            .checked_add(before.len() as usize)
            .ok_or("FILE_DROP_LIMIT")?;
        if total > MAX_TOTAL_BYTES {
            return Err("FILE_DROP_LIMIT".into());
        }
        let file = open_no_follow(&path)?;
        let metadata = file.metadata().map_err(|_| "FILE_DROP_READ")?;
        if !metadata.is_file() || !same_file(&before, &metadata) || metadata.len() != before.len() {
            return Err("FILE_DROP_CHANGED".into());
        }
        let name = path
            .file_name()
            .and_then(|v| v.to_str())
            .filter(|s| valid_file_name(s))
            .ok_or("FILE_DROP_NAME")?
            .to_owned();
        let path_text = path
            .to_str()
            .filter(|s| s.len() <= 8192)
            .ok_or("FILE_DROP_PATH")?
            .to_owned();
        let file_type = media_type(&path).to_owned();
        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis().min(u64::MAX as u128) as u64)
            .unwrap_or(0);
        opened.push((path_text, name, file_type, modified, metadata, file));
    }
    let mut files = Vec::with_capacity(opened.len());
    let mut raw = Vec::with_capacity(total);
    for (path, name, file_type, last_modified, original_metadata, mut file) in opened {
        let expected = original_metadata.len();
        check()?;
        let offset = raw.len() as u64;
        let mut bytes = Vec::with_capacity(expected as usize);
        let mut chunk = [0u8; 64 * 1024];
        loop {
            check()?;
            let read = file.read(&mut chunk).map_err(|_| "FILE_DROP_READ")?;
            if read == 0 {
                break;
            }
            if bytes
                .len()
                .checked_add(read)
                .is_none_or(|n| n > MAX_FILE_BYTES)
            {
                return Err("FILE_DROP_FILE_LIMIT".into());
            }
            bytes.extend_from_slice(&chunk[..read]);
        }
        let after = file.metadata().map_err(|_| "FILE_DROP_READ")?;
        if bytes.len() as u64 != expected
            || after.len() != expected
            || !after.is_file()
            || !same_file(&original_metadata, &after)
            || original_metadata.modified().ok() != after.modified().ok()
        {
            return Err("FILE_DROP_CHANGED".into());
        }
        if raw
            .len()
            .checked_add(bytes.len())
            .is_none_or(|n| n > MAX_TOTAL_BYTES)
        {
            return Err("FILE_DROP_LIMIT".into());
        }
        raw.extend_from_slice(&bytes);
        files.push(FileHeader {
            name,
            path,
            file_type,
            last_modified,
            size: expected,
            offset,
        });
    }
    check()?;
    Ok((files, raw))
}

fn valid_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.encode_utf16().count() <= 255
        && !name
            .chars()
            .any(|ch| matches!(ch, '\\' | '/' | '\0' | '\r' | '\n'))
}

fn open_no_follow(path: &Path) -> Result<File, String> {
    #[cfg(target_os = "macos")]
    {
        use std::{
            ffi::CString,
            os::{
                fd::{AsRawFd, FromRawFd},
                unix::ffi::OsStrExt,
            },
        };
        let parts = path
            .components()
            .filter_map(|part| match part {
                Component::RootDir => None,
                Component::Normal(name) => Some(Ok(name)),
                _ => Some(Err("FILE_DROP_PATH".to_string())),
            })
            .collect::<Result<Vec<_>, _>>()?;
        if parts.is_empty() {
            return Err("FILE_DROP_PATH".into());
        }
        let mut parent = File::open("/").map_err(|_| "FILE_DROP_READ")?;
        for (index, component) in parts.iter().enumerate() {
            let name = CString::new(component.as_bytes()).map_err(|_| "FILE_DROP_PATH")?;
            let mut flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK;
            if index + 1 < parts.len() {
                flags |= libc::O_DIRECTORY;
            }
            let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
            if fd < 0 {
                return Err("FILE_DROP_READ".into());
            }
            let opened = unsafe { File::from_raw_fd(fd) };
            if index + 1 == parts.len() {
                return Ok(opened);
            }
            if !opened.metadata().map_err(|_| "FILE_DROP_READ")?.is_dir() {
                return Err("FILE_DROP_PATH".into());
            }
            parent = opened;
        }
        Err("FILE_DROP_PATH".into())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("FILE_DROP_UNSUPPORTED_PLATFORM".into())
    }
}

fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::MetadataExt;
        a.dev() == b.dev() && a.ino() == b.ino()
    }
    #[cfg(not(target_os = "macos"))]
    {
        a.len() == b.len() && a.file_type() == b.file_type()
    }
}

fn media_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "txt" | "md" | "csv" | "log" => "text/plain",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "zip" => "application/zip",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        _ => "",
    }
}

pub(super) fn expires_at_ms(created: std::time::Instant) -> u64 {
    let remaining = super::types::LEASE.saturating_sub(created.elapsed());
    SystemTime::now()
        .checked_add(remaining)
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_name_matches_the_frontend_utf16_and_separator_contract() {
        assert!(valid_file_name(&"a".repeat(255)));
        assert!(!valid_file_name(&"a".repeat(256)));
        assert!(valid_file_name(&"🌊".repeat(127)));
        assert!(!valid_file_name(&"🌊".repeat(128)));
        for invalid in [
            "folder/name",
            "folder\\name",
            "line\nfeed",
            "line\rfeed",
            "nul\0name",
        ] {
            assert!(
                !valid_file_name(invalid),
                "unexpectedly accepted {invalid:?}"
            );
        }
    }
    #[test]
    fn counts_are_bounded_before_filesystem_access() {
        assert_eq!(validate_count(&[]).unwrap_err(), "FILE_DROP_COUNT");
        assert!(validate_count(&vec![PathBuf::from("/missing"); MAX_FILES]).is_ok());
        assert_eq!(
            validate_count(&vec![PathBuf::from("/missing"); MAX_FILES + 1]).unwrap_err(),
            "FILE_DROP_COUNT"
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn directories_and_symlinked_paths_are_rejected() {
        use std::os::unix::fs::symlink;
        let root = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("atools-file-drop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("real.txt");
        std::fs::write(&target, "safe").unwrap();
        let file_link = root.join("file-link.txt");
        let dir_link = root.with_extension("link");
        symlink(&target, &file_link).unwrap();
        symlink(&root, &dir_link).unwrap();
        assert_eq!(
            read_paths(vec![root.clone()], || Ok(())).err().unwrap(),
            "FILE_DROP_KIND"
        );
        assert_eq!(
            read_paths(vec![file_link.clone()], || Ok(()))
                .err()
                .unwrap(),
            "FILE_DROP_KIND"
        );
        assert!(read_paths(vec![dir_link.join("real.txt")], || Ok(())).is_err());
        std::fs::remove_file(file_link).unwrap();
        std::fs::remove_file(dir_link).unwrap();
        std::fs::remove_file(target).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn cancellation_is_checked_between_bounded_read_chunks() {
        let root = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let path = root.join(format!("atools-file-drop-{}.bin", uuid::Uuid::new_v4()));
        std::fs::write(&path, vec![7u8; 256 * 1024]).unwrap();
        let mut checks = 0;
        let result = read_paths(vec![path.clone()], || {
            checks += 1;
            if checks >= 3 {
                Err("fixture-cancel".into())
            } else {
                Ok(())
            }
        });
        assert_eq!(result.err().unwrap(), "fixture-cancel");
        std::fs::remove_file(path).unwrap();
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn temporary_regular_file_is_read_whole_and_exactly() {
        let dir = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let path = dir.join(format!("atools-file-drop-{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&path, "line one\n你好 🌊").unwrap();
        let result = read_paths(vec![path.clone()], || Ok(())).unwrap();
        assert_eq!(
            result.0[0].name,
            path.file_name().unwrap().to_string_lossy()
        );
        assert_eq!(result.0[0].size as usize, "line one\n你好 🌊".len());
        assert_eq!(result.1, "line one\n你好 🌊".as_bytes());
        std::fs::remove_file(path).unwrap();
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn zero_byte_regular_file_is_a_real_valid_drop_item() {
        let dir = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let path = dir.join(format!("atools-file-drop-{}.empty", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"").unwrap();
        let result = read_paths(vec![path.clone()], || Ok(())).unwrap();
        assert_eq!(result.0.len(), 1);
        assert_eq!(result.0[0].size, 0);
        assert_eq!(result.0[0].offset, 0);
        assert!(result.1.is_empty());
        std::fs::remove_file(path).unwrap();
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn per_file_and_aggregate_limits_reject_the_entire_batch() {
        let dir = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("atools-file-drop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = dir.join("first.bin");
        let second = dir.join("second.bin");
        let third = dir.join("third.bin");
        std::fs::write(&first, vec![1u8; MAX_FILE_BYTES + 1]).unwrap();
        assert_eq!(
            read_paths(vec![first.clone()], || Ok(())).err().unwrap(),
            "FILE_DROP_FILE_LIMIT"
        );
        std::fs::write(&first, vec![1u8; MAX_FILE_BYTES]).unwrap();
        std::fs::write(&second, vec![2u8; MAX_FILE_BYTES]).unwrap();
        std::fs::write(&third, [3u8]).unwrap();
        assert_eq!(
            read_paths(vec![first, second, third.clone()], || Ok(()))
                .err()
                .unwrap(),
            "FILE_DROP_LIMIT"
        );
        std::fs::remove_file(dir.join("first.bin")).unwrap();
        std::fs::remove_file(dir.join("second.bin")).unwrap();
        std::fs::remove_file(third).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn metadata_change_after_handle_open_rejects_the_whole_read() {
        let dir = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let path = dir.join(format!("atools-file-drop-{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&path, "original").unwrap();
        let mut checks = 0;
        let result = read_paths(vec![path.clone()], || {
            checks += 1;
            if checks == 3 {
                std::fs::write(&path, "changed after opening").unwrap();
            }
            Ok(())
        });
        assert_eq!(result.err().unwrap(), "FILE_DROP_CHANGED");
        std::fs::remove_file(path).unwrap();
    }
}
