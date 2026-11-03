//! Bounded image envelope/header checks. No pixel decode, thumbnail, clipboard write or persistence.
use base64::{engine::general_purpose::STANDARD, Engine};
pub(crate) const MAX_IMAGE_DATA_URL_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_IMAGE_ENCODED_BYTES: usize = 6 * 1024 * 1024;
const MAX_IMAGE_SIDE: u32 = 16_384;
const MAX_IMAGE_PIXELS: u64 = 40_000_000;

pub(crate) fn validate_data_url(value: &str) -> Result<(u32, u32), String> {
    if value.len() > MAX_IMAGE_DATA_URL_BYTES {
        return Err("IMAGE_INPUT_BUDGET: data URL exceeds 8 MiB".into());
    }
    let (header, data) = value
        .split_once(',')
        .ok_or("IMAGE_INPUT_INVALID: expected a base64 image data URL")?;
    let media = header
        .strip_prefix("data:")
        .and_then(|h| h.strip_suffix(";base64"))
        .filter(|m| matches!(*m, "image/png" | "image/jpeg" | "image/webp" | "image/tiff"))
        .ok_or("IMAGE_INPUT_UNSUPPORTED: supported base64 formats are PNG, JPEG, WebP and TIFF")?;
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| "IMAGE_INPUT_INVALID: invalid base64 bytes")?;
    validate_encoded(&bytes, media)
}

pub(crate) fn validate_encoded(bytes: &[u8], media: &str) -> Result<(u32, u32), String> {
    if bytes.len() > MAX_IMAGE_ENCODED_BYTES {
        return Err("IMAGE_INPUT_BUDGET: encoded image exceeds 6 MiB".into());
    }
    let size = match media {
        "image/png" => png(bytes),
        "image/jpeg" => jpeg(bytes),
        "image/webp" => webp(bytes),
        "image/tiff" => tiff(bytes),
        _ => None,
    }
    .ok_or("IMAGE_INPUT_INVALID: unsupported or malformed image header")?;
    if size.0 == 0
        || size.1 == 0
        || size.0 > MAX_IMAGE_SIDE
        || size.1 > MAX_IMAGE_SIDE
        || u64::from(size.0) * u64::from(size.1) > MAX_IMAGE_PIXELS
    {
        return Err(
            "IMAGE_INPUT_BUDGET: dimensions exceed 16384 per side or 40 million pixels".into(),
        );
    }
    Ok(size)
}

pub(crate) fn encode_data_url(bytes: &[u8], media: &str) -> Result<String, String> {
    validate_encoded(bytes, media)?;
    let length = media.len() + 13 + bytes.len().div_ceil(3) * 4;
    if length > MAX_IMAGE_DATA_URL_BYTES {
        return Err("IMAGE_INPUT_BUDGET: data URL exceeds 8 MiB".into());
    }
    Ok(format!("data:{media};base64,{}", STANDARD.encode(bytes)))
}
fn be32(bytes: &[u8]) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(..4)?.try_into().ok()?))
}
fn le32(bytes: &[u8]) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(..4)?.try_into().ok()?))
}
fn png(b: &[u8]) -> Option<(u32, u32)> {
    if b.get(..8)? != b"\x89PNG\r\n\x1a\n"
        || be32(b.get(8..)?)? != 13
        || b.get(12..16)? != b"IHDR"
        || b.len() < 33
    {
        return None;
    }
    Some((be32(b.get(16..)?)?, be32(b.get(20..)?)?))
}
fn jpeg(b: &[u8]) -> Option<(u32, u32)> {
    if b.get(..2)? != [0xff, 0xd8] {
        return None;
    }
    let mut i = 2;
    while i < b.len() {
        if *b.get(i)? != 0xff {
            return None;
        }
        while b.get(i) == Some(&0xff) {
            i += 1;
        }
        let marker = *b.get(i)?;
        i += 1;
        if marker == 0xda || marker == 0xd9 {
            return None;
        }
        if marker == 0x01 || (0xd0..=0xd8).contains(&marker) {
            continue;
        }
        let length = u16::from_be_bytes(b.get(i..i + 2)?.try_into().ok()?) as usize;
        if length < 2 || i.checked_add(length)? > b.len() {
            return None;
        }
        if matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        ) {
            if length < 8 {
                return None;
            }
            let h = u16::from_be_bytes(b.get(i + 3..i + 5)?.try_into().ok()?);
            let w = u16::from_be_bytes(b.get(i + 5..i + 7)?.try_into().ok()?);
            return Some((u32::from(w), u32::from(h)));
        }
        i += length;
    }
    None
}
fn webp(b: &[u8]) -> Option<(u32, u32)> {
    if b.get(..4)? != b"RIFF"
        || b.get(8..12)? != b"WEBP"
        || (le32(b.get(4..)?)? as usize).checked_add(8)? > b.len()
    {
        return None;
    }
    let mut i = 12;
    while i + 8 <= b.len() {
        let kind = b.get(i..i + 4)?;
        let n = le32(b.get(i + 4..)?)? as usize;
        let data = b.get(i + 8..i.checked_add(8)?.checked_add(n)?)?;
        if kind == b"VP8X" && data.len() >= 10 {
            let u24 = |s: &[u8]| u32::from(s[0]) | u32::from(s[1]) << 8 | u32::from(s[2]) << 16;
            return Some((u24(&data[4..7]) + 1, u24(&data[7..10]) + 1));
        }
        if kind == b"VP8L" && data.len() >= 5 && data[0] == 0x2f {
            let bits = le32(&data[1..])?;
            return Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1));
        }
        if kind == b"VP8 " && data.len() >= 10 && data[3..6] == [0x9d, 0x01, 0x2a] {
            return Some((
                u32::from(u16::from_le_bytes(data[6..8].try_into().ok()?) & 0x3fff),
                u32::from(u16::from_le_bytes(data[8..10].try_into().ok()?) & 0x3fff),
            ));
        }
        i = i.checked_add(8)?.checked_add(n)?.checked_add(n % 2)?;
    }
    None
}
fn tiff(b: &[u8]) -> Option<(u32, u32)> {
    let little = match b.get(..2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let read16 = |offset: usize| -> Option<u16> {
        let a = b.get(offset..offset.checked_add(2)?)?.try_into().ok()?;
        Some(if little {
            u16::from_le_bytes(a)
        } else {
            u16::from_be_bytes(a)
        })
    };
    let read32 = |offset: usize| -> Option<u32> {
        let a = b.get(offset..offset.checked_add(4)?)?.try_into().ok()?;
        Some(if little {
            u32::from_le_bytes(a)
        } else {
            u32::from_be_bytes(a)
        })
    };
    if read16(2)? != 42 {
        return None;
    }
    let ifd = read32(4)? as usize;
    let count = read16(ifd)? as usize;
    if count > 4096 || ifd.checked_add(2 + count * 12 + 4)? > b.len() {
        return None;
    }
    let (mut width, mut height) = (None, None);
    for n in 0..count {
        let offset = ifd + 2 + n * 12;
        let tag = read16(offset)?;
        if tag != 256 && tag != 257 {
            continue;
        }
        if read32(offset + 4)? != 1 {
            return None;
        }
        let size = match read16(offset + 2)? {
            3 => u32::from(read16(offset + 8)?),
            4 => read32(offset + 8)?,
            _ => return None,
        };
        if tag == 256 {
            width = Some(size)
        } else {
            height = Some(size)
        }
    }
    Some((width?, height?))
}

#[cfg(test)]
#[path = "launcher_media_image_tests.rs"]
mod tests;
