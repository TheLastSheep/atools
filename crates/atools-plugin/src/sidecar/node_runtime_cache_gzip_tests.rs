use std::io::{Cursor, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use flate2::write::GzEncoder;
use flate2::Compression;
use sha2::{Digest, Sha256};

use super::{unpack, Error};

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::new(6));
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

struct CancelOnSecondRead<R> {
    inner: R,
    reads: Arc<AtomicUsize>,
    checks: Arc<AtomicUsize>,
    checks_at_cancel: Arc<AtomicUsize>,
    cancelled: Arc<AtomicBool>,
}

impl<R: Read> Read for CancelOnSecondRead<R> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        let read_number = self.reads.fetch_add(1, Ordering::AcqRel) + 1;
        if read_number == 2 {
            self.checks_at_cancel
                .store(self.checks.load(Ordering::Acquire), Ordering::Release);
            self.cancelled.store(true, Ordering::Release);
        }
        self.inner.read(output)
    }
}

struct CancelAfterFirstWrite<'a> {
    output: &'a mut Vec<u8>,
    cancelled: &'a AtomicBool,
    wrote: bool,
}

impl Write for CancelAfterFirstWrite<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.output.extend_from_slice(bytes);
        if !bytes.is_empty() && !self.wrote {
            self.wrote = true;
            self.cancelled.store(true, Ordering::Release);
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn run(input: &[u8], expected: &[u8], limit: u64) -> Result<Vec<u8>, Error> {
    let mut output = Vec::new();
    unpack(
        Cursor::new(input),
        &mut output,
        limit,
        expected.len() as u64,
        &sha(expected),
        input.len() as u64,
        input.len() as u64,
        &sha(input),
        || false,
    )?;
    Ok(output)
}

struct InterruptedOnce<R> {
    inner: R,
    interrupted: bool,
}

impl<R: Read> Read for InterruptedOnce<R> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if !self.interrupted {
            self.interrupted = true;
            return Err(std::io::ErrorKind::Interrupted.into());
        }
        self.inner.read(output)
    }
}

#[test]
fn retries_one_ordinary_interrupted_read_and_completes_gzip() {
    let expected = b"ordinary interrupted read is not cancellation".repeat(2048);
    let compressed = gzip(&expected);
    let mut output = Vec::new();
    let input = InterruptedOnce {
        inner: Cursor::new(&compressed),
        interrupted: false,
    };
    unpack(
        input,
        &mut output,
        expected.len() as u64,
        expected.len() as u64,
        &sha(&expected),
        compressed.len() as u64,
        compressed.len() as u64,
        &sha(&compressed),
        || false,
    )
    .unwrap();
    assert_eq!(output, expected);
}

#[test]
fn validates_complete_single_member_and_signed_bytes() {
    let bytes = vec![0x5a; 140_000];
    let compressed = gzip(&bytes);
    assert_eq!(run(&compressed, &bytes, bytes.len() as u64).unwrap(), bytes);
}

#[test]
fn rejects_truncation_crc_corruption_trailing_bytes_and_multimember() {
    let bytes = vec![0x33; 80_000];
    let one = gzip(&bytes);
    assert!(run(&one[..one.len() - 4], &bytes, 100_000).is_err());
    let mut bad_crc = one.clone();
    *bad_crc.last_mut().unwrap() ^= 1;
    assert!(run(&bad_crc, &bytes, 100_000).is_err());
    let mut trailing = one.clone();
    trailing.extend_from_slice(b"extra");
    assert!(run(&trailing, &bytes, 100_000).is_err());
    let mut second_member = one.clone();
    second_member.extend_from_slice(&gzip(b"second"));
    assert!(run(&second_member, &bytes, 100_000).is_err());
}

#[test]
fn enforces_output_limit_and_checks_cancellation_between_chunks() {
    let bytes = vec![0x41; 180_000];
    let compressed = gzip(&bytes);
    assert!(matches!(
        run(&compressed, &bytes, 120_000),
        Err(Error::LimitExceeded)
    ));
    let cancelled = AtomicBool::new(false);
    let mut output = Vec::new();
    let mut writer = CancelAfterFirstWrite {
        output: &mut output,
        cancelled: &cancelled,
        wrote: false,
    };
    let result = unpack(
        Cursor::new(&compressed),
        &mut writer,
        200_000,
        bytes.len() as u64,
        &sha(&bytes),
        compressed.len() as u64,
        compressed.len() as u64,
        &sha(&compressed),
        || cancelled.load(Ordering::Acquire),
    );
    assert!(matches!(result, Err(Error::Cancelled)));
    assert!(
        cancelled.load(Ordering::Acquire),
        "cancellation follows an actual output write"
    );
    assert!(!output.is_empty() && output.len() < bytes.len());
}

#[test]
fn cancellation_during_compressed_input_refill_is_terminal() {
    let mut state = 0x9e37_79b9u32;
    let bytes: Vec<u8> = (0..384 * 1024)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state >> 24) as u8
        })
        .collect();
    let compressed = gzip(&bytes);
    assert!(compressed.len() > super::super::metadata::STREAM_BYTES * 2);
    let cancelled = Arc::new(AtomicBool::new(false));
    let reads = Arc::new(AtomicUsize::new(0));
    let mut output = Vec::new();
    let checks = Arc::new(AtomicUsize::new(0));
    let checks_at_cancel = Arc::new(AtomicUsize::new(0));
    let input = CancelOnSecondRead {
        inner: Cursor::new(&compressed),
        reads: Arc::clone(&reads),
        checks: Arc::clone(&checks),
        checks_at_cancel: Arc::clone(&checks_at_cancel),
        cancelled: Arc::clone(&cancelled),
    };
    let result = unpack(
        input,
        &mut output,
        bytes.len() as u64,
        bytes.len() as u64,
        &sha(&bytes),
        compressed.len() as u64,
        compressed.len() as u64,
        &sha(&compressed),
        {
            let cancelled = Arc::clone(&cancelled);
            let checks = Arc::clone(&checks);
            move || {
                checks.fetch_add(1, Ordering::Relaxed);
                cancelled.load(Ordering::Acquire)
            }
        },
    );
    assert!(matches!(result, Err(Error::Cancelled)));
    assert!(cancelled.load(Ordering::Acquire));
    assert_eq!(
        reads.load(Ordering::Acquire),
        2,
        "cancellation is raised by a real compressed-input refill"
    );
    assert!(
        checks_at_cancel.load(Ordering::Acquire) >= 4,
        "the first outer check happened before the second input read"
    );
    assert!(!output.is_empty() && output.len() < bytes.len());
}
