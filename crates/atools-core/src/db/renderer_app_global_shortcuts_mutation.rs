//! Pure typed mutations; only selected known public fields change.
use serde_json::value::RawValue;
use uuid::Uuid;
use super::{raw, invalid, AppGlobalShortcutMutation as Mutation, AppGlobalShortcutSnapshot as Snapshot,
    AppKind, Authority, RendererAppIdentity, MAX_REVISION};
use crate::{db::RendererDirectSubtype, error::Result};

fn target(target: RendererAppIdentity, shortcut: String, enabled: bool) -> Result<Authority> {
    if target.sub_type != RendererDirectSubtype::App { return Err(invalid("Only Native-resolved App targets are supported")); }
    raw::validate_text(&target.path, 16 * 1024, true)?;
    raw::validate_text(&target.name, 4096, false)?;
    raw::validate_text(&shortcut, 256, false)?;
    Ok(Authority { kind: AppKind::App, path: target.path, name: target.name,
        shortcut, enabled, generation: Uuid::new_v4().simple().to_string() })
}
fn patch_row(row: &str, id: &str, record: &Authority) -> Result<Box<RawValue>> {
    let mut row = raw::object(row)?;
    if row.field("autoCopy")?.is_some_and(|v| serde_json::from_str::<bool>(v.get()).ok() != Some(false)) {
        return Err(invalid("autoCopy is unsupported for App bindings"));
    }
    for (key, value) in [("id", serde_json::to_string(id)), ("target", serde_json::to_string(&record.name)),
        ("shortcut", serde_json::to_string(&record.shortcut)), ("enabled", serde_json::to_string(&record.enabled))] {
        row.patch(key, value.map_err(|_| invalid("Could not encode public field"))?)?;
    }
    RawValue::from_string(row.encode()?).map_err(|_| invalid("Invalid patched row"))
}
pub(super) fn apply(before: &Snapshot, mutation: Mutation) -> Result<Snapshot> {
    let mut rows = raw::rows(before.public_raw.as_deref())?;
    let mut records = raw::authority(before.authority_raw.as_deref())?;
    match mutation {
        Mutation::Create { target: selected, shortcut, enabled } => {
            if rows.len() >= 4096 || records.len() >= 64 { return Err(invalid("App binding quota exceeded")); }
            let record = target(selected, shortcut, enabled)?;
            let id = Uuid::new_v4().simple().to_string();
            if records.contains_key(&id) || rows.iter().any(|r| raw::object(r.get()).ok().and_then(|o| o.string("id").ok().flatten()).as_deref() == Some(&id)) {
                return Err(invalid("Generated row ID collision"));
            }
            let row = patch_row("{\"autoCopy\":false,\"preScreenshotOptimization\":false}", &id, &record)?;
            rows.push(row); records.insert(id, record);
        }
        Mutation::Update { row_id, target: selected, shortcut, enabled } => {
            if !apply_replacement(before, &mut rows, &mut records, row_id, selected, shortcut, enabled, false)? { return Ok(before.clone()); }
        }
        Mutation::Adopt { row_id, target: selected, shortcut, enabled } => {
            apply_replacement(before, &mut rows, &mut records, row_id, selected, shortcut, enabled, true)?;
        }
        Mutation::Remove { row_id } => {
            if !before.bindings.iter().any(|b| b.row_id == row_id && b.public_matches) { return Err(invalid("Cannot remove an unowned or drifted row")); }
            let index = raw::unique_index(&rows, &row_id)?;
            rows.remove(index); records.remove(&row_id);
        }
        Mutation::SetEnabled { row_id, enabled } => {
            let current = before.bindings.iter().find(|b| b.row_id == row_id && b.public_matches)
                .ok_or_else(|| invalid("Binding is missing or public row drifted"))?;
            if current.enabled == enabled { return Ok(before.clone()); }
            let index = raw::unique_index(&rows, &row_id)?;
            let record = records.get_mut(&row_id).ok_or_else(|| invalid("Binding is missing"))?;
            record.enabled = enabled; record.generation = Uuid::new_v4().simple().to_string();
            rows[index] = patch_row(rows[index].get(), &row_id, record)?;
        }
    }
    let public = raw::encode_rows(&rows)?;
    let authority = raw::encode_authority(&records)?;
    if before.public_raw.as_deref() == Some(&public) && before.authority_raw.as_deref() == Some(&authority) { return Ok(before.clone()); }
    let revision = before.revision.checked_add(1).filter(|r| *r <= MAX_REVISION).ok_or_else(|| invalid("Revision exhausted"))?;
    raw::snapshot(Some(public), Some(authority), Some(revision.to_string()))
}
fn apply_replacement(
    before: &Snapshot, rows: &mut [Box<RawValue>], records: &mut std::collections::BTreeMap<String, Authority>,
    row_id: String, selected: RendererAppIdentity, shortcut: String, enabled: bool, adopt: bool,
) -> Result<bool> {
    let index = raw::unique_index(rows, &row_id)?;
    if !adopt && !before.bindings.iter().any(|b| b.row_id == row_id && b.public_matches) {
        return Err(invalid("Binding is missing or public row drifted; explicit adoption required"));
    }
    if !records.contains_key(&row_id) && records.len() >= 64 { return Err(invalid("Authority exceeds 64 bindings")); }
    let record = target(selected, shortcut, enabled)?;
    if let Some(current) = records.get(&row_id) {
        if current.path == record.path && current.name == record.name && current.shortcut == record.shortcut && current.enabled == record.enabled {
            if !adopt { return Ok(false); }
        }
    }
    rows[index] = patch_row(rows[index].get(), &row_id, &record)?;
    records.insert(row_id, record);
    Ok(true)
}
