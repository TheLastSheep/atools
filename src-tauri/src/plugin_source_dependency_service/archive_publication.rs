use super::{
    validate_archive_metadata, validate_id, ArchiveIdentity, ArchiveStore, CorruptArchive,
    ARCHIVE_LIMIT,
};
use atools_plugin::source_build::LockedPackageV1;
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, io::Read};

pub(super) fn publish_archive(
    store: &ArchiveStore,
    temporary: &str,
    archive_id: &str,
) -> Result<(), String> {
    validate_id(archive_id)?;
    let temporary_name = OsStr::new(temporary);
    let source_meta = store.archives.child_metadata(temporary_name)?;
    validate_archive_metadata(&source_meta)?;
    let mut source = store
        .archives
        .open_file(temporary_name, Some(&source_meta))?;
    let before = source
        .metadata()
        .map_err(|_| "SOURCE_DEPENDENCY_CACHE_READ")?;
    let source_identity = ArchiveIdentity::from_metadata(&before);
    if !ArchiveIdentity::from_stat(&source_meta).matches_file_base(&before) {
        return Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into());
    }
    let (source_len, source_hash) = read_bounded_digest(&mut source, before.len())?;
    let after_read = source
        .metadata()
        .map_err(|_| "SOURCE_DEPENDENCY_CACHE_READ")?;
    if !same_identity(&before, &after_read)
        || !store.archives.is_same_child(temporary_name, &source_meta)?
    {
        return Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into());
    }
    drop(source);

    store
        .archives
        .rename_child_noreplace(temporary_name, OsStr::new(archive_id))?;
    let target_name = OsStr::new(archive_id);
    let target_meta = store.archives.child_metadata(target_name)?;
    validate_archive_metadata(&target_meta)?;
    let mut target = store.archives.open_file(target_name, Some(&target_meta))?;
    let published_before = target
        .metadata()
        .map_err(|_| "SOURCE_DEPENDENCY_CACHE_READ")?;
    // Only the rename itself may change ctime. The original fd snapshot and
    // content hash above remain the basis for all other identity checks.
    if !source_identity.matches_after_rename(&published_before) {
        return Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into());
    }
    let (published_len, published_hash) = read_bounded_digest(&mut target, published_before.len())?;
    let published_after = target
        .metadata()
        .map_err(|_| "SOURCE_DEPENDENCY_CACHE_READ")?;
    if !same_identity(&published_before, &published_after)
        || published_len != source_len
        || published_hash != source_hash
        || !store.archives.is_same_child(target_name, &target_meta)?
    {
        return Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into());
    }
    drop(target);
    store.archives.sync()
}

pub(super) fn publish_repaired_archive(
    store: &ArchiveStore,
    temporary: &str,
    package: &LockedPackageV1,
    corrupt: &CorruptArchive,
) -> Result<(), String> {
    validate_id(&package.archive_id_sha256)?;
    if corrupt.archive_id != package.archive_id_sha256 {
        return Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into());
    }
    let temporary_name = OsStr::new(temporary);
    let temporary_meta = store.archives.child_metadata(temporary_name)?;
    validate_archive_metadata(&temporary_meta)?;
    let mut fresh_file = store
        .archives
        .open_file(temporary_name, Some(&temporary_meta))?;
    let fresh_before = fresh_file
        .metadata()
        .map_err(|_| "SOURCE_DEPENDENCY_CACHE_READ")?;
    let fresh_bytes = read_for_integrity(&mut fresh_file, fresh_before.len())?;
    let fresh_after = fresh_file
        .metadata()
        .map_err(|_| "SOURCE_DEPENDENCY_CACHE_READ")?;
    if fresh_bytes.is_empty()
        || fresh_bytes.len() as u64 > ARCHIVE_LIMIT
        || !same_identity(&fresh_before, &fresh_after)
        || !store
            .archives
            .is_same_child(temporary_name, &temporary_meta)?
        || !atools_plugin::source_build::verify_archive_integrity(package, &fresh_bytes)
    {
        return Err("SOURCE_DEPENDENCY_INTEGRITY_FAILED".into());
    }
    drop(fresh_file);

    let target = OsStr::new(&package.archive_id_sha256);
    // Bind the quarantined corrupt file to its exact pre-rename metadata and
    // content. Only the subsequent rename may alter ctime.
    verify_corrupt_child(store, target, corrupt, None, false)?;
    let quarantine = format!(".tmp-{}", uuid::Uuid::new_v4());
    store
        .archives
        .rename_child_noreplace(target, OsStr::new(&quarantine))?;
    let quarantine_name = OsStr::new(&quarantine);
    let moved_metadata = match verify_corrupt_child(store, quarantine_name, corrupt, None, true) {
        Ok(metadata) => metadata,
        Err(_) => {
            return restore_or_preserve(
                store,
                &quarantine,
                target,
                "SOURCE_DEPENDENCY_CACHE_CHANGED",
            )
        }
    };
    if let Err(error) = publish_archive(store, temporary, &package.archive_id_sha256) {
        return restore_or_preserve(store, &quarantine, target, &error);
    }
    let current =
        match verify_corrupt_child(store, quarantine_name, corrupt, Some(&moved_metadata), true) {
            Ok(metadata) => metadata,
            Err(_) => return Err("SOURCE_DEPENDENCY_CACHE_CLEANUP_UNCONFIRMED".into()),
        };
    if !corrupt.identity.matches_after_rename(&current) {
        return Err("SOURCE_DEPENDENCY_CACHE_CLEANUP_UNCONFIRMED".into());
    }
    let current_path_metadata = store.archives.child_metadata(quarantine_name)?;
    if !corrupt.identity.matches_stat(&current_path_metadata) {
        return Err("SOURCE_DEPENDENCY_CACHE_CLEANUP_UNCONFIRMED".into());
    }
    store
        .archives
        .unlink(quarantine_name, false, Some(&current_path_metadata))
        .map_err(|_| "SOURCE_DEPENDENCY_CACHE_CLEANUP_UNCONFIRMED".into())
}

fn read_bounded_digest(
    file: &mut std::fs::File,
    expected_len: u64,
) -> Result<(u64, [u8; 32]), String> {
    if expected_len > ARCHIVE_LIMIT {
        return Err("SOURCE_DEPENDENCY_CACHE_INVALID".into());
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| "SOURCE_DEPENDENCY_CACHE_READ")?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or("SOURCE_DEPENDENCY_CACHE_INVALID")?;
        if total > ARCHIVE_LIMIT || total > expected_len {
            return Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into());
        }
        hasher.update(&buffer[..read]);
    }
    if total != expected_len {
        return Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into());
    }
    Ok((total, hasher.finalize().into()))
}

fn read_for_integrity(file: &mut std::fs::File, expected_len: u64) -> Result<Vec<u8>, String> {
    if expected_len > ARCHIVE_LIMIT {
        return Err("SOURCE_DEPENDENCY_CACHE_INVALID".into());
    }
    let mut bytes = Vec::with_capacity(expected_len as usize);
    (&mut *file)
        .take(ARCHIVE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "SOURCE_DEPENDENCY_CACHE_READ")?;
    if bytes.len() as u64 != expected_len {
        return Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into());
    }
    Ok(bytes)
}

fn same_identity(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    super::same_file(a, b)
}

fn verify_corrupt_child(
    store: &ArchiveStore,
    name: &OsStr,
    corrupt: &CorruptArchive,
    renamed_metadata: Option<&std::fs::Metadata>,
    allow_rename_ctime: bool,
) -> Result<std::fs::Metadata, String> {
    let path_meta = store
        .archives
        .child_metadata_optional(name)?
        .ok_or("SOURCE_DEPENDENCY_CACHE_CHANGED")?;
    if !corrupt.identity.matches_stat(&path_meta) {
        return Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into());
    }
    let mut file = store.archives.open_file(name, Some(&path_meta))?;
    let before = file
        .metadata()
        .map_err(|_| "SOURCE_DEPENDENCY_CACHE_READ")?;
    let matches = if let Some(renamed) = renamed_metadata {
        same_identity(renamed, &before)
            && allow_rename_ctime
            && corrupt.identity.matches_after_rename(&before)
    } else if allow_rename_ctime {
        corrupt.identity.matches_after_rename(&before)
    } else {
        corrupt.identity.matches_metadata(&before)
    };
    if !matches {
        return Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into());
    }
    let (_, digest) = read_bounded_digest(&mut file, before.len())?;
    let after = file
        .metadata()
        .map_err(|_| "SOURCE_DEPENDENCY_CACHE_READ")?;
    if !same_identity(&before, &after)
        || digest != corrupt.content_sha256
        || !store.archives.is_same_child(name, &path_meta)?
    {
        return Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into());
    }
    Ok(before)
}

fn restore_or_preserve(
    store: &ArchiveStore,
    quarantine: &str,
    target: &OsStr,
    error: &str,
) -> Result<(), String> {
    if store.archives.child_metadata_optional(target)?.is_none()
        && store
            .archives
            .rename_child_noreplace(OsStr::new(quarantine), target)
            .is_ok()
    {
        return Err(error.into());
    }
    Err("SOURCE_DEPENDENCY_CACHE_CHANGED".into())
}
