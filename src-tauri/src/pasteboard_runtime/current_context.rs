//! Bounded, request-local projection of the current system clipboard snapshot.
use super::model::{NativePasteboardRepresentation, NativePasteboardSnapshot};
use crate::launcher_media::image::{encode_data_url, validate_encoded};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::DateTime;
use image::{ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Limits};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    io::{self, Cursor, Write},
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub(crate) const CURRENT_CONTEXT_MAX_FILES: usize = 1024;
pub(crate) const CURRENT_CONTEXT_MAX_PATH_BYTES: usize = 16 * 1024;
pub(crate) const CURRENT_CONTEXT_MAX_TEXT_BYTES: usize = 10 * 1024 * 1024;
pub(crate) const CURRENT_CONTEXT_MAX_IMAGE_INPUT_BYTES: usize = 6 * 1024 * 1024;
pub(crate) const CURRENT_CONTEXT_MAX_PNG_BYTES: usize = 6 * 1024 * 1024;
pub(crate) const CURRENT_CONTEXT_MAX_DATA_URL_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const CURRENT_CONTEXT_MAX_RESPONSE_BYTES: usize = 12 * 1024 * 1024;

const INVALID_TIME_LIMIT: &str = "CLIPBOARD_CONTEXT_TIME_LIMIT_INVALID: invalid time limit";
pub(super) const INVALID_TIMESTAMP: &str =
    "CLIPBOARD_CONTEXT_UNAVAILABLE: clipboard timestamp is invalid";
const INVALID_CONTENT: &str = "CLIPBOARD_CONTEXT_UNAVAILABLE: clipboard content is invalid";
const CONTENT_BUDGET: &str = "CLIPBOARD_CONTEXT_BUDGET: clipboard content exceeds its limit";
pub(super) const SNAPSHOT_WAIT: Duration = Duration::from_millis(180);
pub(super) const SNAPSHOT_RECHECK: Duration = Duration::from_millis(30);
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const MAX_DECODER_ALLOCATION: u64 = 160 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum LastCopiedContent {
    Text {
        data: String,
        timestamp: u64,
    },
    Image {
        data: String,
        timestamp: u64,
    },
    File {
        data: Vec<LastCopiedFile>,
        timestamp: u64,
    },
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LastCopiedFile {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) is_file: bool,
    pub(crate) is_directory: bool,
}

impl LastCopiedContent {
    pub(crate) fn audit_summary(&self) -> Value {
        match self {
            Self::Text { data, timestamp } => json!({
                "type": "text",
                "timestamp": timestamp,
                "payloadBytes": data.len(),
                "fileCount": 0,
            }),
            Self::Image { data, timestamp } => json!({
                "type": "image",
                "timestamp": timestamp,
                "payloadBytes": data.len(),
                "fileCount": 0,
            }),
            Self::File { data, timestamp } => {
                let payload_bytes = data
                    .iter()
                    .map(|file| file.path.len().saturating_add(file.name.len()))
                    .sum::<usize>();
                json!({
                    "type": "file",
                    "timestamp": timestamp,
                    "payloadBytes": payload_bytes,
                    "fileCount": data.len(),
                })
            }
        }
    }
}

/// Validates the upstream millisecond age limit. `None` means no age bound.
pub(crate) fn validate_time_limit(
    time_limit_ms: Option<f64>,
) -> Result<Option<Duration>, &'static str> {
    let Some(time_limit_ms) = time_limit_ms else {
        return Ok(None);
    };
    if !time_limit_ms.is_finite() || time_limit_ms.abs() > MAX_SAFE_INTEGER {
        return Err(INVALID_TIME_LIMIT);
    }
    if time_limit_ms <= 0.0 {
        return Ok(None);
    }
    Ok(Some(Duration::from_secs_f64(time_limit_ms / 1000.0)))
}

pub(super) fn project_snapshot(
    snapshot: NativePasteboardSnapshot,
    timestamp: u64,
) -> Result<Option<LastCopiedContent>, String> {
    let representations = snapshot.representations;
    let content = if let Some(paths) = representations.iter().find_map(|representation| {
        if let NativePasteboardRepresentation::Files(paths) = representation {
            Some(paths)
        } else {
            None
        }
    }) {
        Some(LastCopiedContent::File {
            data: describe_files(paths)?,
            timestamp,
        })
    } else if let Some((bytes, media_type)) = representations.iter().find_map(|representation| {
        if let NativePasteboardRepresentation::Image { bytes, media_type } = representation {
            Some((bytes, media_type.as_str()))
        } else {
            None
        }
    }) {
        Some(LastCopiedContent::Image {
            data: image_data_url(bytes, media_type)?,
            timestamp,
        })
    } else if let Some(text) = representations.iter().find_map(|representation| {
        if let NativePasteboardRepresentation::Text(text) = representation {
            Some(text)
        } else {
            None
        }
    }) {
        if text.is_empty() {
            None
        } else {
            if text.len() > CURRENT_CONTEXT_MAX_TEXT_BYTES {
                return Err(CONTENT_BUDGET.into());
            }
            Some(LastCopiedContent::Text {
                data: text.clone(),
                timestamp,
            })
        }
    } else {
        None
    };

    if let Some(content) = &content {
        validate_response_budget(content)?;
    }
    Ok(content)
}

pub(super) fn validate_response_budget(content: &LastCopiedContent) -> Result<(), String> {
    count_response_bytes(content).map(|_| ())
}

fn count_response_bytes(content: &LastCopiedContent) -> Result<usize, String> {
    let mut writer = BoundedJsonCounter::default();
    match serde_json::to_writer(&mut writer, content) {
        Ok(()) => Ok(writer.written_bytes),
        Err(_) if writer.exceeded => Err(CONTENT_BUDGET.into()),
        Err(_) => Err(INVALID_CONTENT.into()),
    }
}

#[derive(Default)]
pub(super) struct BoundedJsonCounter {
    pub(super) written_bytes: usize,
    pub(super) exceeded: bool,
}

impl Write for BoundedJsonCounter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let Some(next_bytes) = self
            .written_bytes
            .checked_add(bytes.len())
            .filter(|next| *next <= CURRENT_CONTEXT_MAX_RESPONSE_BYTES)
        else {
            self.exceeded = true;
            return Err(io::Error::new(
                io::ErrorKind::Other,
                "clipboard response byte limit",
            ));
        };
        self.written_bytes = next_bytes;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn describe_files(paths: &[String]) -> Result<Vec<LastCopiedFile>, String> {
    if paths.is_empty() || paths.len() > CURRENT_CONTEXT_MAX_FILES {
        return Err(CONTENT_BUDGET.into());
    }
    let mut files = Vec::with_capacity(paths.len());
    for path in paths {
        if path.len() > CURRENT_CONTEXT_MAX_PATH_BYTES || !Path::new(path).is_absolute() {
            return Err(CONTENT_BUDGET.into());
        }
        let name = Path::new(path)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .ok_or(INVALID_CONTENT)?;
        let metadata = std::fs::metadata(path).map_err(|_| INVALID_CONTENT)?;
        if !metadata.is_file() && !metadata.is_dir() {
            return Err(INVALID_CONTENT.into());
        }
        files.push(LastCopiedFile {
            path: path.clone(),
            name: name.to_string(),
            is_file: metadata.is_file(),
            is_directory: metadata.is_dir(),
        });
    }
    Ok(files)
}

pub(super) fn image_data_url(bytes: &[u8], media_type: &str) -> Result<String, String> {
    if bytes.is_empty() || bytes.len() > CURRENT_CONTEXT_MAX_IMAGE_INPUT_BYTES {
        return Err(CONTENT_BUDGET.into());
    }
    let validated_dimensions = validate_encoded(bytes, media_type).map_err(|error| {
        if error.starts_with("IMAGE_INPUT_BUDGET:") {
            CONTENT_BUDGET.to_string()
        } else {
            INVALID_CONTENT.to_string()
        }
    })?;
    if media_type == "image/png" {
        return encode_data_url(bytes, media_type).map_err(|error| {
            if error.starts_with("IMAGE_INPUT_BUDGET:") {
                CONTENT_BUDGET.to_string()
            } else {
                INVALID_CONTENT.to_string()
            }
        });
    }
    let format = match media_type {
        "image/jpeg" => ImageFormat::Jpeg,
        "image/tiff" => ImageFormat::Tiff,
        _ => return Err(INVALID_CONTENT.into()),
    };
    let mut limits = Limits::default();
    limits.max_image_width = Some(validated_dimensions.0);
    limits.max_image_height = Some(validated_dimensions.1);
    limits.max_alloc = Some(MAX_DECODER_ALLOCATION);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    let decoder = reader
        .into_decoder()
        .map_err(|_| INVALID_CONTENT.to_string())?;
    let (width, height) = decoder.dimensions();
    if (width, height) != validated_dimensions {
        return Err(INVALID_CONTENT.into());
    }
    let image =
        image::DynamicImage::from_decoder(decoder).map_err(|_| INVALID_CONTENT.to_string())?;
    let mut output = BoundedPng::default();
    if image::codecs::png::PngEncoder::new(&mut output)
        .write_image(image.as_bytes(), width, height, image.color().into())
        .is_err()
    {
        return Err(if output.overflowed {
            CONTENT_BUDGET.into()
        } else {
            INVALID_CONTENT.into()
        });
    }
    let data_url_len = "data:image/png;base64,".len() + output.bytes.len().div_ceil(3) * 4;
    if data_url_len > CURRENT_CONTEXT_MAX_DATA_URL_BYTES {
        return Err(CONTENT_BUDGET.into());
    }
    Ok(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(output.bytes)
    ))
}

#[derive(Default)]
struct BoundedPng {
    bytes: Vec<u8>,
    overflowed: bool,
}

impl Write for BoundedPng {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let Some(next_len) = self
            .bytes
            .len()
            .checked_add(bytes.len())
            .filter(|next_len| *next_len <= CURRENT_CONTEXT_MAX_PNG_BYTES)
        else {
            self.overflowed = true;
            return Err(io::Error::new(io::ErrorKind::Other, "clipboard PNG limit"));
        };
        self.bytes.extend_from_slice(bytes);
        debug_assert_eq!(self.bytes.len(), next_len);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(super) fn parse_timestamp_ms(value: &str) -> Result<u64, &'static str> {
    let timestamp = DateTime::parse_from_rfc3339(value)
        .map_err(|_| INVALID_TIMESTAMP)?
        .timestamp_millis();
    if timestamp < 0 || timestamp as f64 > MAX_SAFE_INTEGER {
        return Err(INVALID_TIMESTAMP);
    }
    Ok(timestamp as u64)
}

pub(super) fn now_epoch_ms() -> Result<u64, String> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| INVALID_TIMESTAMP.to_string())?;
    let millis = elapsed.as_millis();
    if millis > MAX_SAFE_INTEGER as u128 {
        return Err(INVALID_TIMESTAMP.into());
    }
    Ok(millis as u64)
}

pub(super) fn within_time_limit(
    timestamp_ms: u64,
    time_limit: Option<Duration>,
    now_ms: u64,
) -> bool {
    let Some(time_limit) = time_limit else {
        return true;
    };
    let age_ms = now_ms.saturating_sub(timestamp_ms) as f64;
    age_ms <= time_limit.as_secs_f64() * 1000.0
}

pub(super) async fn sleep_until_recheck(deadline: tokio::time::Instant) {
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if !remaining.is_zero() {
        tokio::time::sleep(remaining.min(SNAPSHOT_RECHECK)).await;
    }
}
