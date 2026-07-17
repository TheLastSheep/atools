use atools_core::{
    pasteboard_order_key_between, Database, HybridLogicalClock, PasteboardEntityType,
    PasteboardItem, PasteboardTombstone, Pinboard,
};

const DEVICE_ID_SETTING_KEY: &str = "pasteboard-device-id";

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeletePinboardResult {
    pub id: String,
    pub unassigned_items: usize,
}

pub fn device_id(db: &Database) -> Result<String, String> {
    if let Some(device_id) = db
        .get_setting(DEVICE_ID_SETTING_KEY)
        .map_err(|error| error.to_string())?
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(device_id);
    }
    let device_id = format!("atools-{}", atools_core::utils::generate_rev());
    db.set_setting(DEVICE_ID_SETTING_KEY, &device_id)
        .map_err(|error| error.to_string())?;
    Ok(device_id)
}

pub fn create_pinboard(db: &Database, name: &str, color: &str) -> Result<Pinboard, String> {
    let boards = db.list_pinboards().map_err(|error| error.to_string())?;
    let order_key = pasteboard_order_key_between(
        boards.last().map(|pinboard| pinboard.order_key.as_str()),
        None,
    )?;
    let wall_ms = wall_ms()?;
    let device_id = device_id(db)?;
    let timestamp = atools_core::utils::now_iso();
    let pinboard = Pinboard {
        id: atools_core::utils::generate_rev(),
        name: name.trim().to_string(),
        color: color.trim().to_uppercase(),
        order_key,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        field_clocks: std::collections::BTreeMap::from([
            (
                "name".to_string(),
                HybridLogicalClock {
                    wall_ms,
                    counter: 0,
                    device_id: device_id.clone(),
                },
            ),
            (
                "color".to_string(),
                HybridLogicalClock {
                    wall_ms,
                    counter: 1,
                    device_id: device_id.clone(),
                },
            ),
            (
                "orderKey".to_string(),
                HybridLogicalClock {
                    wall_ms,
                    counter: 2,
                    device_id,
                },
            ),
        ]),
    };
    db.upsert_pinboard(&pinboard)
        .map_err(|error| error.to_string())?;
    Ok(pinboard)
}

pub fn update_pinboard(
    db: &Database,
    id: &str,
    name: Option<&str>,
    color: Option<&str>,
) -> Result<Pinboard, String> {
    if name.is_none() && color.is_none() {
        return Err("PasteboardPro Pinboard update requires name or color".to_string());
    }
    let mut pinboard = db
        .get_pinboard(id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("PasteboardPro Pinboard does not exist: {id}"))?;
    let wall_ms = wall_ms()?;
    let device_id = device_id(db)?;
    let updating_name = name.is_some();
    if let Some(name) = name {
        pinboard.name = name.trim().to_string();
        pinboard.field_clocks.insert(
            "name".to_string(),
            HybridLogicalClock {
                wall_ms,
                counter: 0,
                device_id: device_id.clone(),
            },
        );
    }
    if let Some(color) = color {
        pinboard.color = color.trim().to_uppercase();
        pinboard.field_clocks.insert(
            "color".to_string(),
            HybridLogicalClock {
                wall_ms,
                counter: if updating_name { 1 } else { 0 },
                device_id,
            },
        );
    }
    pinboard.updated_at = atools_core::utils::now_iso();
    db.upsert_pinboard(&pinboard)
        .map_err(|error| error.to_string())?;
    Ok(pinboard)
}

pub fn move_pinboard(
    db: &Database,
    id: &str,
    before_id: Option<&str>,
    after_id: Option<&str>,
) -> Result<Pinboard, String> {
    let boards = db.list_pinboards().map_err(|error| error.to_string())?;
    let mut moving = boards
        .iter()
        .find(|pinboard| pinboard.id == id)
        .cloned()
        .ok_or_else(|| format!("PasteboardPro Pinboard does not exist: {id}"))?;
    let remaining = boards
        .iter()
        .filter(|pinboard| pinboard.id != id)
        .collect::<Vec<_>>();
    let before = before_id
        .map(|anchor| {
            remaining
                .iter()
                .copied()
                .find(|pinboard| pinboard.id == anchor)
                .ok_or_else(|| "PasteboardPro reorder anchor does not exist".to_string())
        })
        .transpose()?;
    let after = after_id
        .map(|anchor| {
            remaining
                .iter()
                .copied()
                .find(|pinboard| pinboard.id == anchor)
                .ok_or_else(|| "PasteboardPro reorder anchor does not exist".to_string())
        })
        .transpose()?;
    let lower_key = if before_id.is_none() && after_id.is_none() {
        remaining.last().map(|pinboard| pinboard.order_key.as_str())
    } else {
        before.map(|pinboard| pinboard.order_key.as_str())
    };
    let upper_key = after.map(|pinboard| pinboard.order_key.as_str());
    moving.order_key = pasteboard_order_key_between(lower_key, upper_key)?;
    moving.updated_at = atools_core::utils::now_iso();
    moving.field_clocks.insert(
        "orderKey".to_string(),
        HybridLogicalClock {
            wall_ms: wall_ms()?,
            counter: 0,
            device_id: device_id(db)?,
        },
    );
    db.upsert_pinboard(&moving)
        .map_err(|error| error.to_string())?;
    Ok(moving)
}

pub fn delete_pinboard(db: &Database, id: &str) -> Result<DeletePinboardResult, String> {
    if db
        .get_pinboard(id)
        .map_err(|error| error.to_string())?
        .is_none()
    {
        return Err(format!("PasteboardPro Pinboard does not exist: {id}"));
    }
    let device_id = device_id(db)?;
    let item_ids = db
        .list_pasteboard_items_for_sync()
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter(|item| item.pinboard_id.as_deref() == Some(id))
        .map(|item| item.id)
        .collect::<Vec<_>>();
    for item_id in &item_ids {
        db.assign_pasteboard_item_from_device(item_id, None, None, &device_id)
            .map_err(|error| error.to_string())?;
    }
    db.upsert_pasteboard_tombstone(&PasteboardTombstone {
        id: id.to_string(),
        entity_type: PasteboardEntityType::Pinboard,
        deleted: true,
        deleted_at: atools_core::utils::now_iso(),
        source_device_id: device_id.clone(),
        clock: HybridLogicalClock {
            wall_ms: wall_ms()?,
            counter: item_ids.len() as u64,
            device_id,
        },
    })
    .map_err(|error| error.to_string())?;
    Ok(DeletePinboardResult {
        id: id.to_string(),
        unassigned_items: item_ids.len(),
    })
}

pub fn assign_items(
    db: &Database,
    item_ids: Vec<String>,
    pinboard_id: Option<&str>,
) -> Result<Vec<PasteboardItem>, String> {
    let mut seen_ids = std::collections::BTreeSet::new();
    let requested_ids = item_ids
        .into_iter()
        .filter(|id| !id.trim().is_empty() && seen_ids.insert(id.clone()))
        .collect::<Vec<_>>();
    if requested_ids.is_empty() {
        return Ok(Vec::new());
    }
    if let Some(pinboard_id) = pinboard_id {
        if db
            .get_pinboard(pinboard_id)
            .map_err(|error| error.to_string())?
            .is_none()
        {
            return Err(format!(
                "PasteboardPro Pinboard does not exist: {pinboard_id}"
            ));
        }
    }
    let requested_id_set = requested_ids
        .iter()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    let mut previous_order_key = if let Some(pinboard_id) = pinboard_id {
        db.list_pasteboard_items_for_sync()
            .map_err(|error| error.to_string())?
            .into_iter()
            .filter(|item| {
                item.pinboard_id.as_deref() == Some(pinboard_id)
                    && !requested_id_set.contains(&item.id)
            })
            .filter_map(|item| item.pinboard_order_key)
            .max()
    } else {
        None
    };
    let device_id = device_id(db)?;
    let mut updated = Vec::with_capacity(requested_ids.len());
    for id in requested_ids {
        let order_key = if pinboard_id.is_some() {
            Some(pasteboard_order_key_between(
                previous_order_key.as_deref(),
                None,
            )?)
        } else {
            None
        };
        let item = db
            .assign_pasteboard_item_from_device(&id, pinboard_id, order_key.as_deref(), &device_id)
            .map_err(|error| error.to_string())?;
        previous_order_key = order_key;
        updated.push(item);
    }
    Ok(updated)
}

fn wall_ms() -> Result<i64, String> {
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("System clock is invalid: {error}"))?;
    i64::try_from(duration.as_millis())
        .map_err(|_| "System clock exceeds PasteboardPro HLC range".to_string())
}
