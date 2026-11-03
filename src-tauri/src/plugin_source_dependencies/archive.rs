use flate2::bufread::GzDecoder;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path};

use super::archive_digest::{verify_and_rewind, HashingReader};
use super::limits::{
    Deadline, AGGREGATE_ARCHIVE_BYTES, AGGREGATE_UNPACKED_BYTES, ARCHIVE_BYTES, ARCHIVE_ENTRIES,
    FILE_BYTES, IO_CHUNK, PATH_METADATA_BYTES, TARBALL_STREAM_BYTES,
};
use super::tar_format::{
    header_path, package_components, parse_header, path_string, read_block, read_exact_counted,
    safe_relative_path, skip_exact, EntryKind, BLOCK,
};

const ARCHIVE_ID_LEN: usize = 64;

#[derive(Clone, Debug)]
pub(super) struct ArchiveSpec<'a> {
    pub package_path: &'a str,
    pub archive_id_sha256: &'a str,
    pub algorithm: &'a str,
    pub digest_hex: &'a str,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) struct Totals {
    pub archive_bytes: u64,
    pub unpacked_bytes: u64,
    pub file_count: u64,
    pub entry_count: usize,
    pub path_bytes: u64,
}

#[derive(Default)]
pub(super) struct DestinationLedger {
    seen: HashMap<String, EntryKind>,
}

pub(super) fn materialize_package(
    cache_root: &Path,
    stage_root: &Path,
    spec: &ArchiveSpec<'_>,
    totals: &mut Totals,
    ledger: &mut DestinationLedger,
    deadline: &Deadline,
) -> Result<(), &'static str> {
    deadline.check()?;
    validate_spec(spec)?;
    let archive_path = cache_root.join(spec.archive_id_sha256);
    let mut source = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(&archive_path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "dependency_cache_miss"
            } else {
                "dependency_archive_unavailable"
            }
        })?;
    let metadata = source
        .metadata()
        .map_err(|_| "dependency_archive_unavailable")?;
    if !metadata.is_file() {
        return Err("dependency_archive_unavailable");
    }
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o022 != 0 {
        return Err("dependency_cache_permissions_invalid");
    }
    if metadata.len() > ARCHIVE_BYTES {
        return Err("dependency_archive_limit");
    }
    let next_total = totals
        .archive_bytes
        .checked_add(metadata.len())
        .ok_or("dependency_archive_limit")?;
    if next_total > AGGREGATE_ARCHIVE_BYTES {
        return Err("dependency_archive_limit");
    }

    let first_pass = verify_and_rewind(
        &mut source,
        metadata.len(),
        spec.algorithm,
        spec.digest_hex,
        deadline,
    );
    let extraction = match first_pass {
        Err(code) => Err(code),
        Ok(()) => {
            let mut tracked = HashingReader::new(&mut source, spec.algorithm)?;
            let result = extract_archive(
                &mut tracked,
                stage_root,
                spec.package_path,
                totals,
                ledger,
                deadline,
            );
            let hash_check = if result.is_ok() {
                tracked.verify(metadata.len(), spec.digest_hex)
            } else {
                Ok(())
            };
            result.and(hash_check)
        }
    };
    let after = source
        .metadata()
        .map_err(|_| "dependency_archive_unavailable")?;
    if !same_identity(&metadata, &after) {
        return Err("dependency_archive_changed");
    }
    extraction?;
    totals.archive_bytes = next_total;
    Ok(())
}

fn same_identity(before: &std::fs::Metadata, after: &std::fs::Metadata) -> bool {
    before.dev() == after.dev()
        && before.ino() == after.ino()
        && before.uid() == after.uid()
        && before.mode() == after.mode()
        && before.len() == after.len()
        && before.mtime() == after.mtime()
        && before.mtime_nsec() == after.mtime_nsec()
        && before.ctime() == after.ctime()
        && before.ctime_nsec() == after.ctime_nsec()
}

fn validate_spec(spec: &ArchiveSpec<'_>) -> Result<(), &'static str> {
    if !valid_hex_sha256(spec.archive_id_sha256) {
        return Err("dependency_plan_invalid");
    }
    let expected_len = match spec.algorithm {
        "sha256" => 64,
        "sha512" => 128,
        _ => return Err("dependency_plan_invalid"),
    };
    if spec.digest_hex.len() != expected_len
        || !spec
            .digest_hex
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("dependency_plan_invalid");
    }
    let id = sha256_hex(format!("{}:{}", spec.algorithm, spec.digest_hex).as_bytes());
    if id != spec.archive_id_sha256 {
        return Err("dependency_plan_invalid");
    }
    package_components(spec.package_path)?;
    Ok(())
}

fn extract_archive<R: Read>(
    source: &mut R,
    stage_root: &Path,
    package_path: &str,
    totals: &mut Totals,
    ledger: &mut DestinationLedger,
    deadline: &Deadline,
) -> Result<(), &'static str> {
    let reader = BufReader::with_capacity(IO_CHUNK, source);
    let mut decoder = GzDecoder::new(reader);
    let mut stream_bytes = 0u64;
    let mut zero_blocks = 0usize;
    let mut package_root_seen = false;
    let package_parts = package_components(package_path)?;
    let expected_root = package_parts.last().ok_or("dependency_plan_invalid")?;
    let mut archive_root: Option<String> = None;

    loop {
        deadline.check()?;
        let Some(header) = read_block(&mut decoder, &mut stream_bytes)? else {
            return Err("dependency_archive_invalid");
        };
        if header.iter().all(|byte| *byte == 0) {
            zero_blocks += 1;
            if zero_blocks == 2 {
                break;
            }
            continue;
        }
        if zero_blocks != 0 {
            return Err("dependency_archive_invalid");
        }
        totals.entry_count = totals
            .entry_count
            .checked_add(1)
            .ok_or("dependency_archive_limit")?;
        if totals.entry_count > ARCHIVE_ENTRIES {
            return Err("dependency_archive_limit");
        }
        let header = parse_header(&header)?;
        let (root, member) = header_path(&header.path, header.kind, expected_root)?;
        if archive_root
            .as_deref()
            .is_some_and(|chosen| chosen != root.as_str())
        {
            return Err("dependency_archive_path_invalid");
        }
        if archive_root.is_none() {
            archive_root = Some(root.clone());
        }
        if member.is_empty() {
            if header.kind != EntryKind::Directory || header.size != 0 {
                return Err("dependency_archive_invalid");
            }
            if package_root_seen {
                return Err("dependency_archive_duplicate");
            }
            package_root_seen = true;
            continue;
        }
        let destination = format!("{package_path}/{member}");
        let relative = safe_relative_path(&destination)?;
        if ledger.seen.contains_key(&destination) {
            return Err("dependency_archive_duplicate");
        }
        for ancestor in relative.ancestors().skip(1) {
            if let Some(EntryKind::File) = ledger.seen.get(&path_string(ancestor)) {
                return Err("dependency_archive_duplicate");
            }
        }
        totals.path_bytes = totals
            .path_bytes
            .checked_add(destination.len() as u64)
            .ok_or("dependency_archive_limit")?;
        if totals.path_bytes > PATH_METADATA_BYTES {
            return Err("dependency_archive_limit");
        }
        match header.kind {
            EntryKind::Directory => {
                if header.size != 0 {
                    return Err("dependency_archive_invalid");
                }
                ensure_directory(stage_root, &relative)?;
                ledger.seen.insert(destination, EntryKind::Directory);
            }
            EntryKind::File => {
                if header.size > FILE_BYTES {
                    return Err("dependency_archive_limit");
                }
                totals.unpacked_bytes = totals
                    .unpacked_bytes
                    .checked_add(header.size)
                    .ok_or("dependency_archive_limit")?;
                if totals.unpacked_bytes > AGGREGATE_UNPACKED_BYTES {
                    return Err("dependency_archive_limit");
                }
                extract_file(
                    &mut decoder,
                    stage_root,
                    &relative,
                    header.size,
                    header.mode,
                    &mut stream_bytes,
                    deadline,
                )?;
                totals.file_count = totals
                    .file_count
                    .checked_add(1)
                    .ok_or("dependency_archive_limit")?;
                ledger.seen.insert(destination, EntryKind::File);
            }
        }
        let padding = (BLOCK as u64 - header.size % BLOCK as u64) % BLOCK as u64;
        skip_exact(&mut decoder, padding, &mut stream_bytes, deadline)?;
        if stream_bytes > TARBALL_STREAM_BYTES {
            return Err("dependency_archive_limit");
        }
    }
    let mut trailing = [0u8; IO_CHUNK];
    loop {
        deadline.check()?;
        let read = decoder
            .read(&mut trailing)
            .map_err(|_| "dependency_archive_invalid")?;
        if read == 0 {
            break;
        }
        stream_bytes = stream_bytes
            .checked_add(read as u64)
            .ok_or("dependency_archive_limit")?;
        if stream_bytes > TARBALL_STREAM_BYTES || trailing[..read].iter().any(|byte| *byte != 0) {
            return Err("dependency_archive_invalid");
        }
    }
    let mut buffered = decoder.into_inner();
    if !buffered
        .fill_buf()
        .map_err(|_| "dependency_archive_invalid")?
        .is_empty()
    {
        return Err("dependency_archive_invalid");
    }
    Ok(())
}

fn ensure_directory(root: &Path, relative: &Path) -> Result<(), &'static str> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err("dependency_archive_path_invalid");
        };
        current.push(name);
        match fs::create_dir(&current) {
            Ok(()) => fs::set_permissions(&current, fs::Permissions::from_mode(0o755))
                .map_err(|_| "dependency_stage_write_failed")?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let metadata =
                    fs::symlink_metadata(&current).map_err(|_| "dependency_stage_write_failed")?;
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    return Err("dependency_archive_duplicate");
                }
            }
            Err(_) => return Err("dependency_stage_write_failed"),
        }
    }
    Ok(())
}

fn extract_file<R: Read>(
    reader: &mut R,
    root: &Path,
    relative: &Path,
    size: u64,
    mode: u32,
    stream_bytes: &mut u64,
    deadline: &Deadline,
) -> Result<(), &'static str> {
    if let Some(parent) = relative.parent() {
        if !parent.as_os_str().is_empty() {
            ensure_directory(root, parent)?;
        }
    }
    let destination = root.join(relative);
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let mut output = options
        .open(&destination)
        .map_err(|_| "dependency_archive_duplicate")?;
    let mut remaining = size;
    let mut buffer = [0u8; IO_CHUNK];
    while remaining > 0 {
        deadline.check()?;
        let length = usize::try_from(remaining.min(buffer.len() as u64)).unwrap_or(buffer.len());
        read_exact_counted(reader, &mut buffer[..length], stream_bytes)?;
        output
            .write_all(&buffer[..length])
            .map_err(|_| "dependency_stage_write_failed")?;
        remaining -= length as u64;
    }
    output
        .flush()
        .map_err(|_| "dependency_stage_write_failed")?;
    let safe_mode = if mode & 0o111 == 0 { 0o644 } else { 0o755 };
    output
        .set_permissions(fs::Permissions::from_mode(safe_mode))
        .map_err(|_| "dependency_stage_write_failed")?;
    Ok(())
}

fn valid_hex_sha256(value: &str) -> bool {
    value.len() == ARCHIVE_ID_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
#[path = "archive_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "archive_header_tests.rs"]
mod header_tests;
