use crate::sidecar::SidecarError;
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub(super) const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub(super) const MAX_WRITE_BYTES: usize = 64 * 1024;
pub(super) const MAX_OUTPUT_BYTES: usize = 16 * 1024;
pub(super) const MAX_CREDIT_GRANT: usize = 32;
pub(super) const MAX_STREAM_CREDIT: usize = 32;

pub(super) async fn read_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<Option<Value>, SidecarError> {
    let mut header = [0u8; 4];
    let first = reader.read(&mut header[..1]).await.map_err(|error| {
        SidecarError::Crashed(format!("managed child control read failed: {error}"))
    })?;
    if first == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut header[1..]).await.map_err(|error| {
        SidecarError::Protocol(format!(
            "managed child control frame header was truncated: {error}"
        ))
    })?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(SidecarError::Protocol(format!(
            "managed child control frame length {length} is outside 1..={MAX_FRAME_BYTES}"
        )));
    }
    let mut bytes = vec![0u8; length];
    reader.read_exact(&mut bytes).await.map_err(|error| {
        SidecarError::Protocol(format!(
            "managed child control frame body was truncated: {error}"
        ))
    })?;
    serde_json::from_slice(&bytes).map(Some).map_err(|error| {
        SidecarError::Protocol(format!(
            "managed child control frame was not valid JSON: {error}"
        ))
    })
}

pub(super) async fn write_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    value: &Value,
) -> Result<(), SidecarError> {
    let bytes = serde_json::to_vec(value).map_err(|error| {
        SidecarError::Protocol(format!("cannot encode managed child frame: {error}"))
    })?;
    if bytes.is_empty() || bytes.len() > MAX_FRAME_BYTES {
        return Err(SidecarError::Protocol(format!(
            "managed child frame length {} is outside 1..={MAX_FRAME_BYTES}",
            bytes.len()
        )));
    }
    let length = u32::try_from(bytes.len())
        .map_err(|_| SidecarError::Protocol("managed child frame length overflow".into()))?
        .to_be_bytes();
    writer.write_all(&length).await.map_err(|error| {
        SidecarError::Crashed(format!("managed child frame write failed: {error}"))
    })?;
    writer.write_all(&bytes).await.map_err(|error| {
        SidecarError::Crashed(format!("managed child frame write failed: {error}"))
    })?;
    writer.flush().await.map_err(|error| {
        SidecarError::Crashed(format!("managed child frame flush failed: {error}"))
    })
}

pub(super) fn error_errno(error: &std::io::Error) -> Option<i32> {
    error.raw_os_error().filter(|errno| *errno > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::duplex;

    #[tokio::test]
    async fn frames_round_trip_with_big_endian_length_prefix() {
        let (mut left, mut right) = duplex(MAX_FRAME_BYTES + 8);
        let expected = json!({ "id": 7, "op": "spawn", "args": ["node", "-e"] });
        let writer = tokio::spawn(async move { write_frame(&mut left, &expected).await });
        let decoded = read_frame(&mut right).await.unwrap().unwrap();
        writer.await.unwrap().unwrap();
        assert_eq!(decoded["op"], "spawn");
        assert_eq!(decoded["id"], 7);
    }

    #[tokio::test]
    async fn clean_eof_is_distinct_from_truncated_frame() {
        let (left, mut right) = duplex(8);
        drop(left);
        assert!(read_frame(&mut right).await.unwrap().is_none());

        let (mut left, mut right) = duplex(8);
        left.write_all(&[0, 0]).await.unwrap();
        drop(left);
        assert!(matches!(
            read_frame(&mut right).await,
            Err(SidecarError::Protocol(_))
        ));
    }

    #[tokio::test]
    async fn oversized_frame_is_rejected_before_body_allocation() {
        let (mut left, mut right) = duplex(8);
        left.write_all(&((MAX_FRAME_BYTES as u32) + 1).to_be_bytes())
            .await
            .unwrap();
        assert!(matches!(
            read_frame(&mut right).await,
            Err(SidecarError::Protocol(_))
        ));
    }
}
