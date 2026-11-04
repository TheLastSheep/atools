use std::cell::RefCell;
use std::io::{BufRead, BufReader, Read, Write};
use std::rc::Rc;

use flate2::bufread::GzDecoder;
use sha2::{Digest, Sha256};

use super::metadata::STREAM_BYTES;
use super::NodeRuntimeCacheError as Error;

#[cfg(test)]
#[path = "../node_runtime_cache_gzip_tests.rs"]
mod tests;

pub(super) struct Unpacked {
    pub sha256: String,
    pub bytes: u64,
    pub compressed_sha256: String,
    pub compressed_bytes: u64,
}

struct DigestReader<R, C> {
    inner: R,
    digest: Sha256,
    bytes: u64,
    limit: u64,
    cancelled: Rc<RefCell<C>>,
}

impl<R: Read, C: FnMut() -> bool> Read for DigestReader<R, C> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        let count = loop {
            if (self.cancelled.borrow_mut())() {
                // flate2 retries Interrupted while parsing gzip headers/footers;
                // Other is propagated and lets the caller map cancellation.
                return Err(std::io::Error::new(std::io::ErrorKind::Other, "cancelled"));
            }
            match self.inner.read(output) {
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                result => break result?,
            }
        };
        // Cancellation can arrive while the underlying file read is in flight.
        // Do not feed that chunk to flate2 after the cancellation boundary.
        if (self.cancelled.borrow_mut())() {
            return Err(std::io::Error::new(std::io::ErrorKind::Other, "cancelled"));
        }
        self.bytes = self.bytes.checked_add(count as u64).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "input byte overflow")
        })?;
        if self.bytes > self.limit {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "input limit exceeded",
            ));
        }
        self.digest.update(&output[..count]);
        Ok(count)
    }
}

/// Decodes exactly one gzip member, checks cancellation between output chunks,
/// and rejects unread bytes (including a second gzip member) after its trailer.
pub(super) fn unpack<R, W, C>(
    input: R,
    mut output: W,
    output_limit: u64,
    expected_bytes: u64,
    expected_sha256: &str,
    input_limit: u64,
    expected_input_bytes: u64,
    expected_input_sha256: &str,
    cancelled: C,
) -> Result<Unpacked, Error>
where
    R: Read,
    W: Write,
    C: FnMut() -> bool,
{
    let cancelled = Rc::new(RefCell::new(cancelled));
    let digest_input = DigestReader {
        inner: input,
        digest: Sha256::new(),
        bytes: 0,
        limit: input_limit,
        cancelled: Rc::clone(&cancelled),
    };
    let mut decoder = GzDecoder::new(BufReader::with_capacity(STREAM_BYTES, digest_input));
    let mut digest = Sha256::new();
    let mut total = 0u64;
    let mut chunk = vec![0u8; STREAM_BYTES];
    loop {
        if (cancelled.borrow_mut())() {
            return Err(Error::Cancelled);
        }
        let count = decoder.read(&mut chunk).map_err(|error| {
            if error.kind() == std::io::ErrorKind::Interrupted || (cancelled.borrow_mut())() {
                Error::Cancelled
            } else {
                Error::InvalidPayload
            }
        })?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or(Error::LimitExceeded)?;
        if total > output_limit || total > expected_bytes {
            return Err(Error::LimitExceeded);
        }
        output.write_all(&chunk[..count])?;
        digest.update(&chunk[..count]);
    }
    let mut buffered = decoder.into_inner();
    if (cancelled.borrow_mut())() {
        return Err(Error::Cancelled);
    }
    let has_trailing = !buffered
        .fill_buf()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::Interrupted || (cancelled.borrow_mut())() {
                Error::Cancelled
            } else {
                Error::InvalidPayload
            }
        })?
        .is_empty();
    if (cancelled.borrow_mut())() {
        return Err(Error::Cancelled);
    }
    if has_trailing {
        return Err(Error::InvalidPayload);
    }
    let input_digest = buffered.into_inner();
    let compressed_sha256 = format!("{:x}", input_digest.digest.finalize());
    if input_digest.bytes != expected_input_bytes || compressed_sha256 != expected_input_sha256 {
        return Err(Error::InvalidPayload);
    }
    let sha256 = format!("{:x}", digest.finalize());
    if total != expected_bytes || sha256 != expected_sha256 {
        return Err(Error::InvalidPayload);
    }
    Ok(Unpacked {
        sha256,
        bytes: total,
        compressed_sha256,
        compressed_bytes: input_digest.bytes,
    })
}
