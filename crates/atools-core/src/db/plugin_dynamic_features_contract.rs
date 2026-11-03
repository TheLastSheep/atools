//! Bounded, lossless dynamic declarations; Feature is only the searchable projection.
use crate::{AToolsError, Feature, Result};
use serde_json::Value;
use std::{collections::HashSet, io::Write};

pub(super) const MAX_FEATURES: usize = 1000;
pub(super) const MAX_BATCH: usize = 128;
pub(super) const MAX_FEATURE_BYTES: usize = 16 * 1024;
pub(super) const MAX_TOTAL_BYTES: usize = 256 * 1024;

pub(super) struct Declaration {
    pub feature: Feature,
    pub json: String,
}

pub(super) fn invalid() -> AToolsError {
    AToolsError::Plugin("Invalid dynamic feature declaration".into())
}
pub(super) fn quota() -> AToolsError {
    AToolsError::Plugin("Dynamic feature budget exceeded".into())
}
pub(super) fn conflict() -> AToolsError {
    AToolsError::Plugin("Dynamic feature code is reserved by another declaration".into())
}
pub(super) fn validate_plugin(plugin_id: &str) -> Result<()> {
    if plugin_id.trim().is_empty() || plugin_id.chars().any(char::is_control) {
        return Err(invalid());
    }
    Ok(())
}
pub(super) fn validate_code(code: &str) -> Result<()> {
    if code.trim().is_empty() || code.len() > 256 || code.chars().any(char::is_control) {
        return Err(invalid());
    }
    Ok(())
}
pub(super) fn validate_codes(codes: &[String]) -> Result<()> {
    if codes.len() > MAX_BATCH {
        return Err(quota());
    }
    for code in codes {
        validate_code(code)?;
    }
    Ok(())
}

pub(super) fn declarations(values: &[Value]) -> Result<Vec<Declaration>> {
    if values.len() > MAX_BATCH {
        return Err(quota());
    }
    let mut seen = HashSet::new();
    values
        .iter()
        .map(|value| {
            validate_shape(value)?;
            let mut buffer = BoundedJson(Vec::new());
            serde_json::to_writer(&mut buffer, value).map_err(|_| quota())?;
            let feature: Feature = serde_json::from_value(value.clone()).map_err(|_| invalid())?;
            validate_code(&feature.code)?;
            if !seen.insert(feature.code.clone()) {
                return Err(invalid());
            }
            Ok(Declaration {
                feature,
                json: String::from_utf8(buffer.0).map_err(|_| invalid())?,
            })
        })
        .collect()
}

fn validate_shape(value: &Value) -> Result<()> {
    if !value.is_object() {
        return Err(invalid());
    }
    let mut pending = vec![(value, 0)];
    let mut count = 0;
    while let Some((value, depth)) = pending.pop() {
        count += 1;
        if depth > 64 || count > 8192 {
            return Err(quota());
        }
        match value {
            Value::Array(values) => {
                if values.len() > 8192 - pending.len() {
                    return Err(quota());
                }
                pending.extend(values.iter().map(|v| (v, depth + 1)));
            }
            Value::Object(values) => {
                if values.len() > 8192 - pending.len() {
                    return Err(quota());
                }
                pending.extend(values.values().map(|v| (v, depth + 1)));
            }
            _ => {}
        }
        if pending.len() > 8192 {
            return Err(quota());
        }
    }
    Ok(())
}

struct BoundedJson(Vec<u8>);
impl Write for BoundedJson {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > MAX_FEATURE_BYTES {
            return Err(std::io::Error::other(
                "Dynamic feature JSON exceeds its byte budget",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
