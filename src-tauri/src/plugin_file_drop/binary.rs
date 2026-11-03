use super::types::{MAX_HEADER_BYTES, MAX_TOTAL_BYTES};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileHeader {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub file_type: String,
    pub last_modified: u64,
    pub size: u64,
    pub offset: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Header<'a> {
    request_id: &'a str,
    lease_id: &'a str,
    expires_at: u64,
    files: &'a [FileHeader],
}

pub(super) fn pack(
    request: &str,
    lease: &str,
    expires_at: u64,
    files: &[FileHeader],
    raw: &[u8],
) -> Result<Vec<u8>, String> {
    if raw.len() > MAX_TOTAL_BYTES {
        return Err("FILE_DROP_LIMIT".into());
    }
    let header = serde_json::to_vec(&Header {
        request_id: request,
        lease_id: lease,
        expires_at,
        files,
    })
    .map_err(|_| "FILE_DROP_HEADER")?;
    if header.len() > MAX_HEADER_BYTES {
        return Err("FILE_DROP_HEADER_LIMIT".into());
    }
    let mut result = Vec::with_capacity(9 + header.len() + raw.len());
    result.extend_from_slice(b"ATFD");
    result.push(1);
    result.extend_from_slice(&(header.len() as u32).to_le_bytes());
    result.extend_from_slice(&header);
    result.extend_from_slice(raw);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn atfd_frame_is_bounded_and_raw_bytes_are_contiguous() {
        let files = [FileHeader {
            name: "a.txt".into(),
            path: "/tmp/a.txt".into(),
            file_type: "text/plain".into(),
            last_modified: 1,
            size: 3,
            offset: 0,
        }];
        let packet = pack("r", "l", 2, &files, b"abc").unwrap();
        assert_eq!(&packet[..5], b"ATFD\x01");
        let header_len = u32::from_le_bytes(packet[5..9].try_into().unwrap()) as usize;
        assert!(header_len <= MAX_HEADER_BYTES);
        assert_eq!(&packet[9 + header_len..], b"abc");
        assert!(packet.len() <= 9 + MAX_HEADER_BYTES + MAX_TOTAL_BYTES);
    }
    #[test]
    fn zero_byte_file_has_a_valid_empty_payload_frame() {
        let files = [FileHeader {
            name: "empty.txt".into(),
            path: "/tmp/empty.txt".into(),
            file_type: "text/plain".into(),
            last_modified: 1,
            size: 0,
            offset: 0,
        }];
        let packet = pack("r", "l", 2, &files, &[]).unwrap();
        let header_len = u32::from_le_bytes(packet[5..9].try_into().unwrap()) as usize;
        assert_eq!(packet.len(), 9 + header_len);
    }
    #[test]
    fn aggregate_overflow_is_rejected_before_packet_creation() {
        assert_eq!(
            pack("r", "l", 2, &[], &vec![0; MAX_TOTAL_BYTES + 1]).unwrap_err(),
            "FILE_DROP_LIMIT"
        );
    }
}
