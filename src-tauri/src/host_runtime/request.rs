//! Exact ephemeral payload variants. Clipboard values never enter TaskRun input.
use super::{clipboard, registry::Access};
use atools_core::db::Database;
use serde_json::Value;

pub enum ClipboardRequest {
    ReadText,
    ReadFiles,
    HasFormat(String),
    ReadFormat(String),
    ReadFormatBuffer(String),
    ReadImage,
    WriteText(String),
    WriteImage(super::clipboard_image_write::ImageWriteRequest),
    ContentWrite(ContentPayload),
    Paste(ContentPayload),
    HistoryPage {
        page: usize,
        page_size: usize,
        query: Option<String>,
    },
    HistoryText {
        id: String,
    },
    HistoryDelete {
        id: String,
    },
    HistoryClear {
        kind: Option<String>,
    },
}
pub enum ContentPayload {
    Text(String),
    Html(super::clipboard_html::HtmlWriteRequest),
    Image(super::clipboard_image_write::ImageWriteRequest),
    Files(Vec<String>),
}
impl ClipboardRequest {
    pub fn is_image_read(&self) -> bool {
        matches!(self, Self::ReadImage)
    }
    pub fn is_image_write(&self) -> bool {
        matches!(self, Self::WriteImage(_))
    }
    pub fn is_content_write(&self) -> bool {
        matches!(self, Self::ContentWrite(_) | Self::Paste(_))
    }
    #[cfg(test)]
    pub fn is_paste(&self) -> bool {
        matches!(self, Self::Paste(_))
    }
    pub fn parse(access: Access, payload: &Value) -> Result<Self, String> {
        let fields = payload.as_object().ok_or("Invalid clipboard request")?;
        match access {
            Access::Read if fields.is_empty() => Ok(Self::ReadText),
            Access::Read if fields.contains_key("operation") => parse_format_request(fields),
            Access::Read
                if fields.len() == 1
                    && fields.get("format").and_then(Value::as_str) == Some("files") =>
            {
                Ok(Self::ReadFiles)
            }
            Access::Image
                if fields.len() == 1
                    && fields.get("format").and_then(Value::as_str) == Some("image") =>
            {
                Ok(Self::ReadImage)
            }
            Access::Write if fields.len() == 1 => {
                let text = fields
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or("Invalid clipboard text")?;
                if text.len() > clipboard::MAX_TEXT_BYTES {
                    return Err("Clipboard text exceeds 256 KiB".into());
                }
                Ok(Self::WriteText(text.to_string()))
            }
            Access::ImageWrite if fields.len() == 1 => {
                let image = fields.get("image").ok_or("Invalid clipboard image")?;
                Ok(Self::WriteImage(
                    super::clipboard_image_write::ImageWriteRequest::parse(image)?,
                ))
            }
            Access::ContentWrite | Access::Paste => {
                let content = parse_content(fields)?;
                if access == Access::Paste {
                    Ok(Self::Paste(content))
                } else {
                    Ok(Self::ContentWrite(content))
                }
            }
            Access::HistoryRead => match fields.get("operation").and_then(Value::as_str) {
                Some("list")
                    if fields.keys().all(|key| {
                        ["operation", "page", "pageSize", "query"].contains(&key.as_str())
                    }) =>
                {
                    let page = bounded_integer(
                        fields.get("page"),
                        1,
                        1_000_001,
                        "Invalid clipboard history page",
                    )?;
                    let page_size = bounded_integer(
                        fields.get("pageSize"),
                        1,
                        1000,
                        "Invalid clipboard history page size",
                    )?;
                    let offset = page
                        .checked_sub(1)
                        .and_then(|p| p.checked_mul(page_size))
                        .ok_or("Clipboard history offset is out of range")?;
                    if offset > 10_000_000 {
                        return Err("Clipboard history offset is out of range".into());
                    }
                    let query = match fields.get("query") {
                        None | Some(Value::Null) => None,
                        Some(Value::String(value)) if value.len() <= 256 => Some(value.clone()),
                        _ => return Err("Invalid clipboard history query".into()),
                    };
                    Ok(Self::HistoryPage {
                        page,
                        page_size,
                        query,
                    })
                }
                Some("getContent")
                    if fields.len() == 2
                        && fields
                            .keys()
                            .all(|key| ["operation", "id"].contains(&key.as_str())) =>
                {
                    let id = exact_history_id(fields.get("id"))?;
                    Ok(Self::HistoryText { id })
                }
                _ => Err("Clipboard history read request is invalid".into()),
            },
            Access::HistoryDelete => match fields.get("operation").and_then(Value::as_str) {
                Some("delete")
                    if fields.len() == 2
                        && fields
                            .keys()
                            .all(|key| ["operation", "id"].contains(&key.as_str())) =>
                {
                    Ok(Self::HistoryDelete {
                        id: exact_history_id(fields.get("id"))?,
                    })
                }
                Some("clear") => {
                    if !fields
                        .keys()
                        .all(|key| ["operation", "type"].contains(&key.as_str()))
                    {
                        return Err("Invalid clipboard history clear request".into());
                    }
                    match fields.get("type") {
                        None => Ok(Self::HistoryClear { kind: None }),
                        Some(Value::String(value)) if value == "all" => {
                            Ok(Self::HistoryClear { kind: None })
                        }
                        Some(Value::String(value))
                            if value == "text" || value == "image" || value == "file" =>
                        {
                            Ok(Self::HistoryClear {
                                kind: Some(value.clone()),
                            })
                        }
                        _ => Err("Invalid clipboard history type".into()),
                    }
                }
                _ => Err("Clipboard history delete request is invalid".into()),
            },
            _ => Err("Clipboard request does not match this authorization".into()),
        }
    }
    pub fn execute_host(
        &self,
        access: Access,
        backend: &dyn clipboard::ClipboardAccess,
        db: &Database,
    ) -> Result<Value, String> {
        let value = match self {
            Self::HistoryPage {
                page,
                page_size,
                query,
            } if access == Access::HistoryRead => {
                let result = db
                    .plugin_clipboard_history_page(
                        query.as_deref().unwrap_or(""),
                        *page,
                        *page_size,
                    )
                    .map_err(|error| error.to_string())?;
                let mut items = Vec::with_capacity(result.items.len());
                for item in result.items {
                    items.push(history_item_to_wire(item)?);
                }
                serde_json::json!({
                    "items": items,
                    "total": result.total,
                    "page": result.page,
                    "pageSize": result.page_size
                })
            }
            Self::HistoryText { id } if access == Access::HistoryRead => db
                .plugin_clipboard_history_content(id)
                .map_err(|error| error.to_string())?
                .map(history_item_to_wire)
                .transpose()?
                .unwrap_or(Value::Null),
            Self::HistoryDelete { id } if access == Access::HistoryDelete => {
                serde_json::json!({"deleted":db.delete_plugin_clipboard_history_item(id).map_err(|error| error.to_string())?})
            }
            Self::HistoryClear { kind } if access == Access::HistoryDelete => {
                serde_json::json!({"deletedCount":db.clear_plugin_clipboard_history(kind.as_deref()).map_err(|error| error.to_string())?})
            }
            _ => return self.execute(access, backend),
        };
        let bytes =
            serde_json::to_vec(&value).map_err(|_| "Clipboard response could not be serialized")?;
        if bytes.len() > MAX_HISTORY_RESPONSE_BYTES {
            return Err("Clipboard history response exceeds 512 KiB".into());
        }
        Ok(value)
    }
    pub fn execute(
        &self,
        access: Access,
        backend: &dyn clipboard::ClipboardAccess,
    ) -> Result<Value, String> {
        match (access, self) {
            (Access::Read, Self::ReadText) => clipboard::exact_read(backend).map(Value::String),
            (Access::Read, Self::ReadFiles) => super::copied_files::exact_files(backend),
            (Access::Read, Self::HasFormat(format)) => {
                super::clipboard_formats::exact_has_format(backend, format)
            }
            (Access::Read, Self::ReadFormat(format)) => {
                super::clipboard_formats::exact_read_format(backend, format)
            }
            (Access::Read, Self::ReadFormatBuffer(format)) => {
                super::clipboard_formats::exact_read_format_buffer(backend, format)
            }
            (Access::Image, Self::ReadImage) => {
                Err("Clipboard image requests require the bounded blocking worker".into())
            }
            (Access::Write, Self::WriteText(text)) => {
                clipboard::exact_write(backend, text).map(|_| Value::Null)
            }
            (Access::ImageWrite, Self::WriteImage(_)) => {
                Err("Clipboard image writes require the bounded blocking worker".into())
            }
            _ => Err("Clipboard request does not match this authorization".into()),
        }
    }
}

fn parse_format_request(
    fields: &serde_json::Map<String, Value>,
) -> Result<ClipboardRequest, String> {
    if fields.len() != 2
        || fields
            .keys()
            .any(|key| !matches!(key.as_str(), "operation" | "format"))
    {
        return Err("Clipboard format request is invalid".into());
    }
    let operation = fields
        .get("operation")
        .and_then(Value::as_str)
        .ok_or("Clipboard format request is invalid")?;
    let format = fields
        .get("format")
        .and_then(Value::as_str)
        .ok_or("Clipboard format request is invalid")?;
    super::clipboard_formats::validate_format(format)?;
    match operation {
        "hasFormat" => Ok(ClipboardRequest::HasFormat(format.to_owned())),
        "readFormat" => Ok(ClipboardRequest::ReadFormat(format.to_owned())),
        "readFormatBuffer" => Ok(ClipboardRequest::ReadFormatBuffer(format.to_owned())),
        _ => Err("Clipboard format request is invalid".into()),
    }
}

fn parse_content(fields: &serde_json::Map<String, Value>) -> Result<ContentPayload, String> {
    match fields.get("kind").and_then(Value::as_str) {
        Some("text")
            if fields.len() == 2 && fields.get("text").and_then(Value::as_str).is_some() =>
        {
            let text = fields["text"].as_str().ok_or("Invalid clipboard text")?;
            if text.len() > clipboard::MAX_TEXT_BYTES {
                return Err("Clipboard text exceeds 256 KiB".into());
            }
            Ok(ContentPayload::Text(text.to_owned()))
        }
        Some("image") if fields.len() == 2 => {
            let image = fields.get("image").ok_or("Invalid clipboard image")?;
            Ok(ContentPayload::Image(
                super::clipboard_image_write::ImageWriteRequest::parse(image)?,
            ))
        }
        Some("html") => Ok(ContentPayload::Html(
            super::clipboard_html::HtmlWriteRequest::parse(fields)?,
        )),
        Some("files") if fields.len() == 2 => {
            let paths = fields
                .get("paths")
                .and_then(Value::as_array)
                .ok_or("Invalid clipboard files")?;
            if paths.is_empty() || paths.len() > super::copied_files::MAX_FILES {
                return Err("Clipboard files exceed the limit".into());
            }
            let mut total = 0usize;
            let paths = paths
                .iter()
                .map(|value| {
                    let path = value.as_str().ok_or("Invalid clipboard file path")?;
                    total = total
                        .checked_add(path.len())
                        .ok_or("Clipboard files exceed the limit")?;
                    if path.len() > super::copied_files::MAX_PATH_BYTES
                        || total > super::copied_files::MAX_TOTAL_PATH_BYTES
                        || path.contains('\0')
                        || !std::path::Path::new(path).is_absolute()
                    {
                        return Err("Clipboard files exceed the limit".into());
                    }
                    Ok(path.to_owned())
                })
                .collect::<Result<Vec<_>, String>>()?;
            super::copied_files::describe_paths(paths.clone())?;
            Ok(ContentPayload::Files(paths))
        }
        _ => Err("Clipboard content must be text, HTML, image, or files".into()),
    }
}

const MAX_HISTORY_RESPONSE_BYTES: usize = 512 * 1024;

fn bounded_integer(
    value: Option<&Value>,
    min: usize,
    max: usize,
    error: &'static str,
) -> Result<usize, String> {
    let value = value.and_then(Value::as_u64).ok_or(error)?;
    if value > 9_007_199_254_740_991 || value < min as u64 || value > max as u64 {
        return Err(error.into());
    }
    Ok(value as usize)
}

fn exact_history_id(value: Option<&Value>) -> Result<String, String> {
    let id = value
        .and_then(Value::as_str)
        .ok_or("Invalid clipboard history ID")?;
    let suffix = id
        .strip_prefix("clip-image-")
        .or_else(|| id.strip_prefix("clip-file-"))
        .or_else(|| id.strip_prefix("clip-"))
        .ok_or("Invalid clipboard history ID")?;
    if suffix.len() != 16
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("Invalid clipboard history ID".into());
    }
    Ok(id.into())
}

fn history_item_to_wire(
    item: atools_core::db::PluginClipboardHistoryPageItem,
) -> Result<Value, String> {
    let timestamp = timestamp_millis(&item.timestamp)?;
    match item.kind.as_str() {
        "text" => {
            let content = item.payload["content"]
                .as_str()
                .ok_or("Clipboard history text payload is invalid")?;
            Ok(serde_json::json!({
                "id": item.id,
                "type": "text",
                "timestamp": timestamp,
                "preview": item.preview,
                "content": content
            }))
        }
        "image" => {
            let image_path = item.payload["imagePath"]
                .as_str()
                .ok_or("Clipboard history image payload is invalid")?;
            let mut value = serde_json::json!({
                "id": item.id,
                "type": "image",
                "timestamp": timestamp,
                "preview": item.preview,
                "imagePath": image_path,
                "content": image_path
            });
            if let Some(byte_size) = item.payload.get("byteSize") {
                value["byteSize"] = byte_size.clone();
            }
            Ok(value)
        }
        "file" => {
            let files = item.payload["files"]
                .as_array()
                .ok_or("Clipboard history file payload is invalid")?;
            let paths = files
                .iter()
                .map(|file| {
                    file.get("path")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .ok_or("Clipboard history file path is invalid")
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(serde_json::json!({
                "id": item.id,
                "type": "file",
                "timestamp": timestamp,
                "preview": item.preview,
                "files": files,
                "content": paths
            }))
        }
        _ => Err("Invalid clipboard history item kind".into()),
    }
}

fn timestamp_millis(value: &str) -> Result<i64, String> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.timestamp_millis())
        .map_err(|_| "Clipboard history timestamp is invalid".into())
}
