use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use sha2::{Digest, Sha256, Sha512};

use super::limits::{Deadline, IO_CHUNK};

enum DigestState {
    Sha256(Sha256),
    Sha512(Sha512),
}

impl DigestState {
    fn new(algorithm: &str) -> Result<Self, &'static str> {
        match algorithm {
            "sha256" => Ok(Self::Sha256(Sha256::new())),
            "sha512" => Ok(Self::Sha512(Sha512::new())),
            _ => Err("dependency_plan_invalid"),
        }
    }

    fn update(&mut self, bytes: &[u8]) {
        match self {
            Self::Sha256(hash) => hash.update(bytes),
            Self::Sha512(hash) => hash.update(bytes),
        }
    }

    fn finish(self) -> String {
        match self {
            Self::Sha256(hash) => hex(&hash.finalize()),
            Self::Sha512(hash) => hex(&hash.finalize()),
        }
    }
}

pub(super) fn verify_and_rewind(
    source: &mut File,
    expected_bytes: u64,
    algorithm: &str,
    expected_digest: &str,
    deadline: &Deadline,
) -> Result<(), &'static str> {
    let mut hash = DigestState::new(algorithm)?;
    let mut buffer = [0u8; IO_CHUNK];
    let mut observed = 0u64;
    loop {
        deadline.check()?;
        let count = source
            .read(&mut buffer)
            .map_err(|_| "dependency_archive_read_failed")?;
        if count == 0 {
            break;
        }
        observed = observed
            .checked_add(count as u64)
            .ok_or("dependency_archive_changed")?;
        if observed > expected_bytes {
            return Err("dependency_archive_changed");
        }
        hash.update(&buffer[..count]);
    }
    if observed != expected_bytes {
        return Err("dependency_archive_changed");
    }
    if hash.finish() != expected_digest {
        return Err("dependency_archive_integrity_failed");
    }
    source
        .seek(SeekFrom::Start(0))
        .map_err(|_| "dependency_archive_read_failed")?;
    Ok(())
}

pub(super) struct HashingReader<R> {
    inner: R,
    hash: DigestState,
    bytes: u64,
}

impl<R> HashingReader<R> {
    pub fn new(inner: R, algorithm: &str) -> Result<Self, &'static str> {
        Ok(Self {
            inner,
            hash: DigestState::new(algorithm)?,
            bytes: 0,
        })
    }

    pub fn verify(self, expected_bytes: u64, expected_digest: &str) -> Result<(), &'static str> {
        if self.bytes != expected_bytes || self.hash.finish() != expected_digest {
            return Err("dependency_archive_changed");
        }
        Ok(())
    }
}

impl<R: Read> Read for HashingReader<R> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        let count = self.inner.read(output)?;
        self.bytes = self.bytes.saturating_add(count as u64);
        self.hash.update(&output[..count]);
        Ok(count)
    }
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
