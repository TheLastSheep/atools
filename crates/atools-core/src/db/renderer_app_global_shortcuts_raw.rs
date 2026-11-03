//! Bounded JSON with raw per-member tokens. Unknown public rows are never normalized.
use std::{collections::{BTreeMap}, fmt};
use serde::{de::{MapAccess, Visitor}, Deserialize, Deserializer};
use serde_json::value::RawValue;
use super::{invalid, AppGlobalShortcutBinding, AppGlobalShortcutSnapshot, Authority, MAX_BYTES, MAX_REVISION};
use crate::error::Result;

#[derive(Debug)]
pub(super) struct Object(pub Vec<(String, Box<RawValue>)>);
impl<'de> Deserialize<'de> for Object {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct ObjectVisitor;
        impl<'de> Visitor<'de> for ObjectVisitor {
            type Value = Object;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result { f.write_str("JSON object") }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<Object, A::Error> {
                let mut fields = Vec::new();
                while let Some(entry) = map.next_entry::<String, Box<RawValue>>()? { fields.push(entry); }
                Ok(Object(fields))
            }
        }
        d.deserialize_map(ObjectVisitor)
    }
}
impl Object {
    pub(super) fn field(&self, key: &str) -> Result<Option<&RawValue>> {
        let mut values = self.0.iter().filter(|(name, _)| name == key);
        let value = values.next().map(|(_, value)| value.as_ref());
        if values.next().is_some() { return Err(invalid("Duplicate public field")); }
        Ok(value)
    }
    pub(super) fn string(&self, key: &str) -> Result<Option<String>> {
        Ok(self.field(key)?.and_then(|v| serde_json::from_str(v.get()).ok()))
    }
    pub(super) fn patch(&mut self, key: &str, encoded: String) -> Result<()> {
        self.field(key)?;
        let value = RawValue::from_string(encoded).map_err(|_| invalid("Invalid patched JSON"))?;
        if let Some((_, slot)) = self.0.iter_mut().find(|(name, _)| name == key) { *slot = value; }
        else { self.0.push((key.to_owned(), value)); }
        Ok(())
    }
    pub(super) fn encode(&self) -> Result<String> {
        let fields = self.0.iter().map(|(key, value)| {
            Ok(format!("{}:{}", serde_json::to_string(key).map_err(|_| invalid("Invalid key"))?, value.get()))
        }).collect::<Result<Vec<_>>>()?;
        Ok(format!("{{{}}}", fields.join(",")))
    }
}
pub(super) fn bounded(text: &str) -> Result<()> {
    if text.len() > MAX_BYTES { return Err(invalid("Document exceeds 128 KiB")); }
    let (mut depth, mut quoted, mut escape) = (0usize, false, false);
    for byte in text.bytes() {
        if quoted {
            if escape { escape = false; }
            else if byte == b'\\' { escape = true; }
            else if byte == b'"' { quoted = false; }
        } else {
            match byte {
                b'"' => quoted = true,
                b'{' | b'[' => { depth += 1; if depth > 8 { return Err(invalid("JSON exceeds depth 8")); } }
                b'}' | b']' => { depth = depth.saturating_sub(1); }
                _ => {}
            }
        }
    }
    Ok(())
}
pub(super) fn object(text: &str) -> Result<Object> {
    serde_json::from_str(text).map_err(|_| invalid("Expected valid JSON object"))
}
pub(super) fn rows(text: Option<&str>) -> Result<Vec<Box<RawValue>>> {
    let text = text.unwrap_or("[]"); bounded(text)?;
    let rows: Vec<Box<RawValue>> = serde_json::from_str(text).map_err(|_| invalid("Expected public JSON array"))?;
    if rows.len() > 4096 { return Err(invalid("Public array exceeds 4096 rows")); }
    for row in &rows { object(row.get())?; }
    Ok(rows)
}
pub(super) fn authority(text: Option<&str>) -> Result<BTreeMap<String, Authority>> {
    let Some(text) = text else { return Ok(BTreeMap::new()); };
    bounded(text)?;
    let document = object(text)?;
    if document.0.len() != 2 || document.0.iter().any(|(k, _)| k != "version" && k != "records") {
        return Err(invalid("Unknown authority fields"));
    }
    if document.field("version")?.map(RawValue::get) != Some("1") { return Err(invalid("Unsupported authority version")); }
    let records = document.field("records")?.ok_or_else(|| invalid("Missing authority records"))?;
    let records = object(records.get())?;
    if records.0.len() > 64 { return Err(invalid("Authority exceeds 64 bindings")); }
    let mut result = BTreeMap::new();
    for (id, raw) in records.0 {
        validate_id(&id)?;
        let record: Authority = serde_json::from_str(raw.get()).map_err(|_| invalid("Invalid known authority record"))?;
        validate_text(&record.path, 16 * 1024, true)?;
        validate_text(&record.name, 4096, false)?;
        validate_text(&record.shortcut, 256, false)?;
        if record.generation.len() != 32 || !record.generation.bytes().all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v)) {
            return Err(invalid("Invalid configuration generation"));
        }
        if result.insert(id, record).is_some() { return Err(invalid("Duplicate authority row ID")); }
    }
    Ok(result)
}
pub(super) fn validate_id(id: &str) -> Result<()> { validate_text(id, 128, false) }
pub(super) fn validate_text(text: &str, max: usize, path: bool) -> Result<()> {
    if text.trim().is_empty() || text.len() > max || text.chars().any(char::is_control) || (path && !std::path::Path::new(text).is_absolute()) {
        return Err(invalid("Invalid bounded binding field"));
    }
    Ok(())
}
pub(super) fn matches(row: &Object, id: &str, binding: &Authority) -> Result<bool> {
    let enabled = row.field("enabled")?.and_then(|v| serde_json::from_str::<bool>(v.get()).ok());
    let auto_copy = row.field("autoCopy")?.map(|v| serde_json::from_str::<bool>(v.get())).transpose().ok().flatten().unwrap_or(false);
    // An invalid autoCopy value is also not executable, rather than defaulting it to false.
    let valid_auto = row.field("autoCopy")?.is_none_or(|v| v.get() == "false");
    Ok(row.string("id")?.as_deref() == Some(id) && row.string("target")?.as_deref() == Some(&binding.name)
        && row.string("shortcut")?.as_deref() == Some(&binding.shortcut) && enabled == Some(binding.enabled) && !auto_copy && valid_auto)
}
pub(super) fn snapshot(public_raw: Option<String>, authority_raw: Option<String>, revision_raw: Option<String>) -> Result<AppGlobalShortcutSnapshot> {
    if let Some(text) = &revision_raw { bounded(text)?; if text.len() > 32 { return Err(invalid("Invalid revision")); } }
    let revision = revision_raw.as_deref().map(serde_json::from_str::<u64>).transpose().map_err(|_| invalid("Invalid revision"))?.unwrap_or(0);
    if revision > MAX_REVISION { return Err(invalid("Revision exceeds safe integer")); }
    let rows = rows(public_raw.as_deref())?;
    let records = authority(authority_raw.as_deref())?;
    let mut ids = BTreeMap::<String, Vec<Object>>::new();
    for row in &rows {
        let row = object(row.get())?;
        if let Some(id) = row.string("id")? { ids.entry(id).or_default().push(row); }
    }
    let mut bindings = Vec::new();
    for (id, record) in records {
        let current = ids.get(&id);
        if current.is_some_and(|r| r.len() != 1) { return Err(invalid("Ambiguous owned row ID")); }
        let public_matches = current.and_then(|r| r.first()).map(|r| matches(r, &id, &record)).transpose()?.unwrap_or(false);
        bindings.push(AppGlobalShortcutBinding { row_id: id, path: record.path, name: record.name,
            shortcut: record.shortcut, enabled: record.enabled, generation: record.generation, public_matches });
    }
    Ok(AppGlobalShortcutSnapshot { revision, public_raw, authority_raw, revision_raw, bindings })
}
pub(super) fn unique_index(rows: &[Box<RawValue>], id: &str) -> Result<usize> {
    validate_id(id)?;
    let indexes = rows.iter().enumerate().map(|(i, row)| Ok((i, object(row.get())?.string("id")?))).collect::<Result<Vec<_>>>()?;
    let found = indexes.into_iter().filter(|(_, row_id)| row_id.as_deref() == Some(id)).map(|(i, _)| i).collect::<Vec<_>>();
    if found.len() != 1 { return Err(invalid("Missing or ambiguous public row ID")); }
    Ok(found[0])
}
pub(super) fn encode_rows(rows: &[Box<RawValue>]) -> Result<String> {
    let encoded = serde_json::to_string(rows).map_err(|_| invalid("Invalid public JSON"))?;
    bounded(&encoded)?;
    Ok(encoded)
}
pub(super) fn encode_authority(records: &BTreeMap<String, Authority>) -> Result<String> {
    let encoded = format!("{{\"version\":1,\"records\":{}}}", serde_json::to_string(records).map_err(|_| invalid("Invalid authority JSON"))?);
    // Re-validate known fields, quotas and future-version policy on every new image.
    authority(Some(&encoded))?;
    Ok(encoded)
}
