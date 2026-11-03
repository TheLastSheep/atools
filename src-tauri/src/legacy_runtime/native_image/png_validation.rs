//! Bounded PNG chunk framing and CRC preflight.
//!
//! This verifies signature, chunk framing/CRCs, the required outer IHDR/IDAT/IEND
//! structure, and terminal IEND. It is not a full PNG specification validator;
//! pixel decoding remains delegated to the image decoder.
//! See https://www.w3.org/TR/png-3/#5Chunk-layout and #5CRC-algorithm.

const SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const MAX_CHUNKS: usize = 4096;

const fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut index = 0;
    while index < 256 {
        let mut value = index as u32;
        let mut bit = 0;
        while bit < 8 {
            value = if value & 1 == 1 {
                (value >> 1) ^ 0xedb8_8320
            } else {
                value >> 1
            };
            bit += 1;
        }
        table[index] = value;
        index += 1;
    }
    table
}

const CRC_TABLE: [u32; 256] = crc_table();

pub(super) fn validate_png_structure(bytes: &[u8]) -> Result<(), ()> {
    if bytes.len() < SIGNATURE.len() || &bytes[..SIGNATURE.len()] != SIGNATURE {
        return Err(());
    }

    let mut cursor = SIGNATURE.len();
    let mut chunk_count = 0usize;
    let mut saw_ihdr = false;
    let mut saw_idat = false;

    while cursor < bytes.len() {
        chunk_count = chunk_count.checked_add(1).ok_or(())?;
        if chunk_count > MAX_CHUNKS {
            return Err(());
        }
        let header_end = cursor.checked_add(8).ok_or(())?;
        if header_end > bytes.len() {
            return Err(());
        }
        let data_len =
            u32::from_be_bytes(bytes[cursor..cursor + 4].try_into().map_err(|_| ())?) as usize;
        let kind_start = cursor + 4;
        let data_start = header_end;
        let data_end = data_start.checked_add(data_len).ok_or(())?;
        let crc_end = data_end.checked_add(4).ok_or(())?;
        if crc_end > bytes.len() {
            return Err(());
        }

        let kind = &bytes[kind_start..kind_start + 4];
        let expected_crc = u32::from_be_bytes(bytes[data_end..crc_end].try_into().map_err(|_| ())?);
        if crc32(&bytes[kind_start..data_end]) != expected_crc {
            return Err(());
        }

        if !saw_ihdr {
            if kind != b"IHDR" || data_len != 13 {
                return Err(());
            }
            saw_ihdr = true;
        } else if kind == b"IHDR" {
            return Err(());
        }

        if kind == b"IDAT" {
            saw_idat = true;
        }
        if kind == b"IEND" {
            if data_len != 0 || !saw_idat || crc_end != bytes.len() {
                return Err(());
            }
            return Ok(());
        }
        cursor = crc_end;
    }
    Err(())
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for byte in bytes {
        let index = ((crc ^ u32::from(*byte)) & 0xff) as usize;
        crc = (crc >> 8) ^ CRC_TABLE[index];
    }
    !crc
}
