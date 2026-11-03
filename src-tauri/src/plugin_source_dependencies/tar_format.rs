use std::io::Read;
use std::path::{Component, Path, PathBuf};

use super::limits::{Deadline, FILE_BYTES, IO_CHUNK, PATH_BYTES, PATH_DEPTH, TARBALL_STREAM_BYTES};

pub(super) const BLOCK: usize = 512;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum EntryKind {
    File,
    Directory,
}

pub(super) struct Header {
    pub path: String,
    pub kind: EntryKind,
    pub mode: u32,
    pub size: u64,
}

pub(super) fn parse_header(block: &[u8; BLOCK]) -> Result<Header, &'static str> {
    if &block[257..263] != b"ustar\0" || &block[263..265] != b"00" {
        return Err("dependency_archive_invalid");
    }
    let stored = parse_octal(&block[148..156])?;
    let checksum = block
        .iter()
        .enumerate()
        .map(|(index, byte)| {
            if (148..156).contains(&index) {
                b' ' as u64
            } else {
                *byte as u64
            }
        })
        .sum::<u64>();
    if stored != checksum {
        return Err("dependency_archive_invalid");
    }
    let name = header_string(&block[0..100])?;
    let prefix = if block[475] == 0 {
        validate_octal_timestamp(&block[476..488])?;
        validate_octal_timestamp(&block[488..500])?;
        header_string(&block[345..475])?
    } else {
        header_string(&block[345..500])?
    };
    let path = if prefix.is_empty() {
        name
    } else {
        format!("{prefix}/{name}")
    };
    let kind = match block[156] {
        0 | b'0' => EntryKind::File,
        b'5' => EntryKind::Directory,
        _ => return Err("dependency_archive_entry_unsupported"),
    };
    if !header_string(&block[157..257])?.is_empty() {
        return Err("dependency_archive_entry_unsupported");
    }
    let mode =
        u32::try_from(parse_octal(&block[100..108])?).map_err(|_| "dependency_archive_invalid")?;
    let size = parse_octal(&block[124..136])?;
    if size > FILE_BYTES {
        return Err("dependency_archive_limit");
    }
    Ok(Header {
        path,
        kind,
        mode,
        size,
    })
}

pub(super) fn header_path(
    path: &str,
    kind: EntryKind,
    expected_root: &str,
) -> Result<(String, String), &'static str> {
    // Remove exactly one conventional directory suffix, then validate every raw
    // component before interpreting the first component as an archive root.
    let normalized = if kind == EntryKind::Directory && path.ends_with('/') {
        &path[..path.len() - 1]
    } else {
        path
    };
    let parts = validate_components(normalized)?;
    let root = parts.first().ok_or("dependency_archive_path_invalid")?;
    if root != "package" && root != expected_root {
        return Err("dependency_archive_path_invalid");
    }
    Ok((root.clone(), parts[1..].join("/")))
}

pub(super) fn package_components(value: &str) -> Result<Vec<String>, &'static str> {
    if value.len() > PATH_BYTES || !value.starts_with("node_modules/") {
        return Err("dependency_plan_invalid");
    }
    let parts = validate_components(value)?;
    let mut index = 1usize;
    if parts.first().map(String::as_str) != Some("node_modules") {
        return Err("dependency_plan_invalid");
    }
    let mut package_seen = false;
    while index < parts.len() {
        if package_seen {
            if parts[index] != "node_modules" {
                return Err("dependency_plan_invalid");
            }
            index += 1;
            package_seen = false;
            continue;
        }
        if parts[index].starts_with('@') {
            if parts[index].len() < 2
                || index + 1 >= parts.len()
                || parts[index + 1] == "node_modules"
            {
                return Err("dependency_plan_invalid");
            }
            index += 2;
        } else {
            index += 1;
        }
        package_seen = true;
    }
    if !package_seen {
        return Err("dependency_plan_invalid");
    }
    Ok(parts)
}

pub(super) fn safe_relative_path(value: &str) -> Result<PathBuf, &'static str> {
    let parts = validate_components(value)?;
    let mut path = PathBuf::new();
    for part in parts {
        path.push(part);
    }
    Ok(path)
}

pub(super) fn path_string(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn validate_components(value: &str) -> Result<Vec<String>, &'static str> {
    if value.is_empty()
        || value.len() > PATH_BYTES
        || value.contains('\\')
        || value.chars().any(char::is_control)
    {
        return Err("dependency_archive_path_invalid");
    }
    let mut parts = Vec::new();
    for component in Path::new(value).components() {
        match component {
            Component::Normal(part) => {
                let text = part.to_str().ok_or("dependency_archive_path_invalid")?;
                if text.is_empty() || text == "." || text == ".." || text.contains(':') {
                    return Err("dependency_archive_path_invalid");
                }
                parts.push(text.to_owned());
            }
            _ => return Err("dependency_archive_path_invalid"),
        }
    }
    if parts.is_empty() || parts.len() > PATH_DEPTH || parts.join("/") != value {
        return Err("dependency_archive_path_invalid");
    }
    Ok(parts)
}

pub(super) fn read_block<R: Read>(
    reader: &mut R,
    total: &mut u64,
) -> Result<Option<[u8; BLOCK]>, &'static str> {
    let mut block = [0u8; BLOCK];
    let mut offset = 0;
    while offset < BLOCK {
        let count = reader
            .read(&mut block[offset..])
            .map_err(|_| "dependency_archive_invalid")?;
        if count == 0 {
            if offset == 0 {
                return Ok(None);
            }
            return Err("dependency_archive_invalid");
        }
        offset += count;
        *total = total
            .checked_add(count as u64)
            .ok_or("dependency_archive_limit")?;
        if *total > TARBALL_STREAM_BYTES {
            return Err("dependency_archive_limit");
        }
    }
    Ok(Some(block))
}

pub(super) fn read_exact_counted<R: Read>(
    reader: &mut R,
    output: &mut [u8],
    total: &mut u64,
) -> Result<(), &'static str> {
    reader
        .read_exact(output)
        .map_err(|_| "dependency_archive_invalid")?;
    *total = total
        .checked_add(output.len() as u64)
        .ok_or("dependency_archive_limit")?;
    if *total > TARBALL_STREAM_BYTES {
        return Err("dependency_archive_limit");
    }
    Ok(())
}

pub(super) fn skip_exact<R: Read>(
    reader: &mut R,
    mut bytes: u64,
    total: &mut u64,
    deadline: &Deadline,
) -> Result<(), &'static str> {
    let mut buffer = [0u8; IO_CHUNK];
    while bytes > 0 {
        deadline.check()?;
        let length = usize::try_from(bytes.min(buffer.len() as u64)).unwrap_or(buffer.len());
        read_exact_counted(reader, &mut buffer[..length], total)?;
        bytes -= length as u64;
    }
    Ok(())
}

fn parse_octal(bytes: &[u8]) -> Result<u64, &'static str> {
    let start = bytes
        .iter()
        .position(|byte| *byte != 0 && *byte != b' ')
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|byte| *byte != 0 && *byte != b' ')
        .map(|index| index + 1)
        .unwrap_or(start);
    let value = &bytes[start..end];
    if value.is_empty() {
        return Ok(0);
    }
    value.iter().try_fold(0u64, |total, byte| {
        if !(b'0'..=b'7').contains(byte) {
            return Err("dependency_archive_invalid");
        }
        total
            .checked_mul(8)
            .and_then(|number| number.checked_add((byte - b'0') as u64))
            .ok_or("dependency_archive_invalid")
    })
}

fn validate_octal_timestamp(bytes: &[u8]) -> Result<(), &'static str> {
    if bytes.iter().all(|byte| *byte == 0) {
        return Ok(());
    }
    if !bytes.iter().any(|byte| (b'0'..=b'7').contains(byte)) {
        return Err("dependency_archive_invalid");
    }
    parse_octal(bytes).map(|_| ())
}

fn header_string(bytes: &[u8]) -> Result<String, &'static str> {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    if bytes[end..].iter().any(|byte| *byte != 0) {
        return Err("dependency_archive_invalid");
    }
    std::str::from_utf8(&bytes[..end])
        .map(str::to_owned)
        .map_err(|_| "dependency_archive_path_invalid")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_paths_are_canonical_and_bounded() {
        for path in [
            "node_modules/../x",
            "node_modules/a/./b",
            "node_modules/a//b",
            "node_modules/a\\b",
        ] {
            assert!(package_components(path).is_err());
        }
        assert!(package_components("node_modules/@scope/name").is_ok());
        assert!(package_components("node_modules/a/node_modules/b").is_ok());
    }
}
