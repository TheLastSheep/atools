use serde_json::Value;

use crate::sidecar::SidecarError;

pub(super) const MAX_SOURCE_BYTES: usize = 4 * 1024 * 1024;
const MAX_BASE64_BYTES: usize = MAX_SOURCE_BYTES.div_ceil(3) * 4;
const FRAME_KIND: &str = "atools.nativeImageSource.v1";

/// Bytes returned by the dedicated, bounded Node image-path transport.
/// Format, dimensions, and full image decoding belong to the host image engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeImageSource {
    pub bytes: Vec<u8>,
}

pub(super) fn parse_source_frame(value: Value) -> Result<NativeImageSource, SidecarError> {
    let invalid = || SidecarError::Protocol("invalid native image source frame".into());
    let object = value.as_object().ok_or_else(invalid)?;
    if object.len() != 4
        || object.get("kind").and_then(Value::as_str) != Some(FRAME_KIND)
        || object.get("encoding").and_then(Value::as_str) != Some("base64")
    {
        return Err(invalid());
    }
    let declared_length = object
        .get("byteLength")
        .and_then(Value::as_u64)
        .and_then(|length| usize::try_from(length).ok())
        .filter(|length| (1..=MAX_SOURCE_BYTES).contains(length))
        .ok_or_else(invalid)?;
    let encoded = object
        .get("base64")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    if encoded.len() > MAX_BASE64_BYTES {
        return Err(invalid());
    }
    let bytes = decode_canonical_base64(encoded).ok_or_else(invalid)?;
    if bytes.len() != declared_length {
        return Err(invalid());
    }
    Ok(NativeImageSource { bytes })
}

fn decode_canonical_base64(input: &str) -> Option<Vec<u8>> {
    if input.is_empty() || input.len() % 4 != 0 || input.len() > MAX_BASE64_BYTES {
        return None;
    }
    let mut decoded = Vec::with_capacity(input.len() / 4 * 3);
    let chunks = input.as_bytes().chunks_exact(4);
    let chunk_count = input.len() / 4;
    for (index, chunk) in chunks.enumerate() {
        let final_chunk = index + 1 == chunk_count;
        let a = sextet(chunk[0])?;
        let b = sextet(chunk[1])?;
        decoded.push((a << 2) | (b >> 4));
        match (chunk[2], chunk[3]) {
            (b'=', b'=') if final_chunk && b & 0x0f == 0 => {}
            (c, b'=') if final_chunk => {
                let c = sextet(c)?;
                if c & 0x03 != 0 {
                    return None;
                }
                decoded.push((b << 4) | (c >> 2));
            }
            (c, d) if c != b'=' && d != b'=' => {
                let c = sextet(c)?;
                let d = sextet(d)?;
                decoded.push((b << 4) | (c >> 2));
                decoded.push((c << 6) | d);
            }
            _ => return None,
        }
        if decoded.len() > MAX_SOURCE_BYTES {
            return None;
        }
    }
    Some(decoded)
}

fn sextet(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn frame(base64: &str, byte_length: usize) -> Value {
        json!({
            "kind": FRAME_KIND,
            "encoding": "base64",
            "byteLength": byte_length,
            "base64": base64,
        })
    }

    #[test]
    fn accepts_exact_canonical_typed_frame() {
        let source = parse_source_frame(frame("AQIDBA==", 4)).unwrap();
        assert_eq!(source.bytes.as_slice(), &[1, 2, 3, 4]);
    }

    #[test]
    fn accepts_canonical_single_byte_padding() {
        let source = parse_source_frame(frame("AQ==", 1)).unwrap();
        assert_eq!(source.bytes.as_slice(), &[1]);
    }

    #[test]
    fn rejects_frame_shape_and_metadata_mismatches() {
        let mut value = frame("AQID", 3);
        value
            .as_object_mut()
            .unwrap()
            .insert("path".into(), json!("secret"));
        assert!(parse_source_frame(value).is_err());
        assert!(parse_source_frame(frame("AQID", 4)).is_err());
        assert!(parse_source_frame(frame("AQID", 0)).is_err());
        assert!(parse_source_frame(frame("AQID", MAX_SOURCE_BYTES + 1)).is_err());
        assert!(parse_source_frame(json!(null)).is_err());
    }

    #[test]
    fn rejects_noncanonical_or_invalid_base64() {
        for encoded in ["AQI", "AQI=AAAA", "AR==", "AQJ=", "AQ*D"] {
            assert!(parse_source_frame(frame(encoded, 3)).is_err(), "{encoded}");
        }
    }

    #[test]
    fn accepts_exact_four_mib_boundary_without_overflow() {
        let raw = vec![0x5a; MAX_SOURCE_BYTES];
        let encoded = encode_base64_for_test(&raw);
        assert_eq!(encoded.len(), MAX_BASE64_BYTES);
        let source = parse_source_frame(frame(&encoded, raw.len())).unwrap();
        assert_eq!(source.bytes, raw);
        assert!(parse_source_frame(frame(&encoded, raw.len() + 1)).is_err());
    }

    fn encode_base64_for_test(bytes: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
        for chunk in bytes.chunks(3) {
            let a = chunk[0];
            let b = chunk.get(1).copied().unwrap_or(0);
            let c = chunk.get(2).copied().unwrap_or(0);
            output.push(ALPHABET[(a >> 2) as usize] as char);
            output.push(ALPHABET[(((a & 3) << 4) | (b >> 4)) as usize] as char);
            output.push(if chunk.len() > 1 {
                ALPHABET[(((b & 15) << 2) | (c >> 6)) as usize] as char
            } else {
                '='
            });
            output.push(if chunk.len() > 2 {
                ALPHABET[(c & 63) as usize] as char
            } else {
                '='
            });
        }
        output
    }
}
