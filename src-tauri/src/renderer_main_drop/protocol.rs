use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
pub(super) const MAX_SAFE: u64 = 9_007_199_254_740_991;
pub(super) const MAX_EVENT_BYTES: usize = 256 * 1024;
pub(super) const REJECTED: &str = "MAIN_DROP_TARGET_REJECTED";
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Rect {
    pub fn valid(self) -> bool {
        [
            self.x,
            self.y,
            self.width,
            self.height,
            self.x + self.width,
            self.y + self.height,
        ]
        .iter()
        .all(|v| v.is_finite())
            && self.width > 0.0
            && self.height > 0.0
    }
    pub fn hit(self, x: f64, y: f64, scale: f64) -> bool {
        scale.is_finite()
            && scale > 0.0
            && x.is_finite()
            && y.is_finite()
            && x / scale >= self.x
            && y / scale >= self.y
            && x / scale < self.x + self.width
            && y / scale < self.y + self.height
    }
}
pub(super) fn id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub(super) enum Request {
    Context,
    Set {
        context: String,
        lease: Option<String>,
        target: Option<Rect>,
    },
}
pub(super) fn parse(body: &Value) -> Result<Request, &'static str> {
    let outer = body
        .as_object()
        .filter(|o| o.len() == 1 && o.contains_key("request"))
        .ok_or(REJECTED)?;
    let r = outer["request"].as_object().ok_or(REJECTED)?;
    match r.get("op").and_then(Value::as_str) {
        Some("context") if r.len() == 1 => Ok(Request::Context),
        Some("set")
            if r.len() == 4
                && ["contextId", "leaseId", "target"]
                    .iter()
                    .all(|k| r.contains_key(*k)) =>
        {
            let context = r["contextId"]
                .as_str()
                .filter(|s| id(s))
                .ok_or(REJECTED)?
                .to_owned();
            let lease = if r["leaseId"].is_null() {
                None
            } else {
                Some(
                    r["leaseId"]
                        .as_str()
                        .filter(|s| id(s))
                        .ok_or(REJECTED)?
                        .to_owned(),
                )
            };
            let target = if r["target"].is_null() {
                None
            } else {
                let rect: Rect =
                    serde_json::from_value(r["target"].clone()).map_err(|_| REJECTED)?;
                if !rect.valid() {
                    return Err(REJECTED);
                }
                Some(rect)
            };
            Ok(Request::Set {
                context,
                lease,
                target,
            })
        }
        _ => Err(REJECTED),
    }
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileEntry {
    pub path: String,
    pub name: String,
    pub is_directory: bool,
}
#[derive(Clone, Copy)]
pub(super) enum ErrorCode {
    InvalidBatch,
    MetadataFailed,
}
impl ErrorCode {
    pub fn text(self) -> &'static str {
        match self {
            Self::InvalidBatch => "INVALID_BATCH",
            Self::MetadataFailed => "METADATA_FAILED",
        }
    }
}
pub(super) enum Payload {
    Hover(bool),
    Drop(Vec<FileEntry>),
    Error(ErrorCode),
}
pub(super) fn notice(lease: &str, sequence: u64, payload: Payload) -> Value {
    let mut result = json!({"version":1,"leaseId":lease,"sequence":sequence});
    match payload {
        Payload::Hover(value) => {
            result["phase"] = json!("hover");
            result["hovered"] = json!(value)
        }
        Payload::Drop(files) => {
            result["phase"] = json!("drop");
            result["files"] = json!(files)
        }
        Payload::Error(code) => {
            result["phase"] = json!("error");
            result["code"] = json!(code.text())
        }
    }
    if serde_json::to_vec(&result).is_ok_and(|v| v.len() <= MAX_EVENT_BYTES) {
        result
    } else {
        json!({"version":1,"leaseId":lease,"sequence":sequence,"phase":"error","code":"INVALID_BATCH"})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn region_and_command_are_closed() {
        assert!(parse(&json!({"request":{"op":"context"}})).is_ok());
        for v in [
            json!({"request":{"op":"context","paths":[]}}),
            json!({"request":{"op":"context"},"paths":[]}),
            json!({"request":{"op":"set"}}),
        ] {
            assert!(parse(&v).is_err())
        }
        let r = Rect {
            x: 5.5,
            y: 10.0,
            width: 100.0,
            height: 20.0,
        };
        assert!(r.hit(12.0, 21.0, 2.0));
        assert!(!r.hit(211.0, 21.0, 2.0));
        assert!(!r.hit(12.0, 21.0, 0.0));
    }
    #[test]
    fn encoded_budget_does_not_truncate_or_publish_oversized_files() {
        let value = notice(
            &"a".repeat(32),
            1,
            Payload::Drop(vec![FileEntry {
                path: "\u{1}".repeat(64000),
                name: "\u{1}".repeat(64000),
                is_directory: false,
            }]),
        );
        assert_eq!(value["phase"], "error");
        assert!(value.get("files").is_none())
    }
}
