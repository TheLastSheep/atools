use super::super::fixture_owner;
use super::super::profile::Profile;
use super::general_policies_schema::{
    BASELINE_INVALID, CLIPBOARD_CAPTURE_FAILED, CLIPBOARD_EDIT_FAILED,
};
use crate::pasteboard_runtime::{
    NativePasteboardRepresentation, NativePasteboardSnapshot, PasteboardBackend, PasteboardRuntime,
};
use async_trait::async_trait;
use atools_core::{AppConfig, Database, PasteboardItem, PasteboardItemKind};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{collections::VecDeque, fs, path::Path, sync::Arc};

const MAX_PASTEBOARD_ROWS: usize = 500;
const SEED_EXPIRED_ID: &str = "r46-clipboard-expired-60d";
const SEED_RECENT_ID: &str = "r46-clipboard-recent-7d";
const SEED_PINNED_ID: &str = "r46-clipboard-pinned-90d";
const RESET_ITEM_ID: &str = "r46-clipboard-reset-100d";
const SEED_EXPIRED_TEXT: &str = "atools-r46-fixture-expired-sixty";
const SEED_RECENT_TEXT: &str = "atools-r46-fixture-recent-seven";
const SEED_PINNED_TEXT: &str = "atools-r46-fixture-pinned-ninety";
const RESET_ITEM_TEXT: &str = "atools-r46-fixture-reset-one-hundred";

#[derive(Clone)]
struct SeedItem {
    id: &'static str,
    text: &'static str,
    copied_at: String,
    pinned: bool,
}

struct FixtureState {
    next_sequence: i64,
    capture_in_flight: bool,
    failed: bool,
    reset_history_attempted: bool,
    reset_item: Option<SeedItem>,
}

#[derive(Default)]
struct FakeBackend {
    snapshots: Mutex<VecDeque<NativePasteboardSnapshot>>,
}

#[async_trait]
impl PasteboardBackend for FakeBackend {
    async fn snapshot_if_changed(
        &self,
        previous_change_count: i64,
    ) -> Result<Option<NativePasteboardSnapshot>, String> {
        let mut snapshots = self.snapshots.lock();
        if snapshots
            .front()
            .is_some_and(|snapshot| snapshot.change_count == previous_change_count)
        {
            return Ok(None);
        }
        Ok(snapshots.pop_front())
    }

    async fn write_item(
        &self,
        _item: &PasteboardItem,
        _blob_root: &Path,
        _plain_text: bool,
    ) -> Result<(), String> {
        Err("fixture write disabled".into())
    }

    async fn paste_frontmost(&self) -> Result<(), String> {
        Err("fixture paste disabled".into())
    }
}

pub(super) struct ClipboardRetentionFixture {
    db: Arc<Database>,
    runtime: PasteboardRuntime,
    backend: Arc<FakeBackend>,
    expired: SeedItem,
    recent: SeedItem,
    pinned: SeedItem,
    state: Mutex<FixtureState>,
}

impl ClipboardRetentionFixture {
    pub(super) fn new(
        profile: &super::super::profile::Profile,
        db: Arc<Database>,
    ) -> Result<Self, &'static str> {
        verify_private_profile(profile)?;
        if pasteboard_count(&db)? != 0 || legacy_count(&db)? != 0 {
            return Err(BASELINE_INVALID);
        }

        let config = AppConfig::with_base_dir(profile.root.join("app-data"));
        verify_private_directory_if_present(&profile.root, &config.plugins_dir())?;
        verify_private_directory_if_present(&profile.root, &config.pasteboard_dir())?;
        verify_private_directory_if_present(&profile.root, &config.pasteboard_blobs_dir())?;
        config.ensure_dirs().map_err(|_| CLIPBOARD_EDIT_FAILED)?;
        verify_private_directory(&profile.root, config.base_dir())?;
        verify_private_directory(&profile.root, &config.pasteboard_dir())?;
        verify_private_directory(&profile.root, &config.pasteboard_blobs_dir())?;

        let backend = Arc::new(FakeBackend::default());
        let runtime = PasteboardRuntime::new(backend.clone(), db.clone(), &config)
            .map_err(|_| CLIPBOARD_EDIT_FAILED)?;

        let expired = seed_item(SEED_EXPIRED_ID, SEED_EXPIRED_TEXT, 60, false);
        let recent = seed_item(SEED_RECENT_ID, SEED_RECENT_TEXT, 7, false);
        let pinned = seed_item(SEED_PINNED_ID, SEED_PINNED_TEXT, 90, true);
        for item in [&expired, &recent, &pinned] {
            db.upsert_pasteboard_item(&to_pasteboard_item(item))
                .map_err(|_| CLIPBOARD_EDIT_FAILED)?;
        }
        db.record_clipboard_text(SEED_EXPIRED_TEXT, &expired.copied_at)
            .map_err(|_| CLIPBOARD_EDIT_FAILED)?;
        db.record_clipboard_text(SEED_RECENT_TEXT, &recent.copied_at)
            .map_err(|_| CLIPBOARD_EDIT_FAILED)?;

        Ok(Self {
            db,
            runtime,
            backend,
            expired,
            recent,
            pinned,
            state: Mutex::new(FixtureState {
                next_sequence: 1,
                capture_in_flight: false,
                failed: false,
                reset_history_attempted: false,
                reset_item: None,
            }),
        })
    }

    pub(super) fn snapshot(&self) -> Result<Value, &'static str> {
        let reset_item = self.state.lock().reset_item.clone();
        Ok(json!({
            "pasteboardCount": pasteboard_count(&self.db)?,
            "legacyCount": legacy_count(&self.db)?,
            "expiredUnpinnedPresent": item_present(&self.db, &self.expired)?,
            "recentUnpinnedPresent": item_present(&self.db, &self.recent)?,
            "expiredPinnedPresent": item_present(&self.db, &self.pinned)?,
            "legacyExpiredPresent": legacy_present(&self.db, SEED_EXPIRED_TEXT, &self.expired.copied_at)?,
            "legacyRecentPresent": legacy_present(&self.db, SEED_RECENT_TEXT, &self.recent.copied_at)?,
            "reset100DayPresent": reset_item.as_ref().map_or(Ok(false), |item| item_present(&self.db, item))?,
            "legacyReset100DayPresent": reset_item.as_ref().map_or(Ok(false), |item| legacy_present(&self.db, item.text, &item.copied_at))?,
        }))
    }

    pub(super) async fn capture(&self, sequence: i64) -> Result<bool, &'static str> {
        let expected_days = match sequence {
            1 => 30,
            2 => 1,
            3 => 180,
            _ => return Err(CLIPBOARD_CAPTURE_FAILED),
        };
        {
            let mut state = self.state.lock();
            if state.next_sequence != sequence || state.capture_in_flight || state.failed {
                return Err(CLIPBOARD_CAPTURE_FAILED);
            }
            state.capture_in_flight = true;
        }
        let result = self.capture_sequence(sequence, expected_days).await;
        let mut state = self.state.lock();
        state.capture_in_flight = false;
        match result {
            Ok(captured) => {
                state.next_sequence += 1;
                Ok(captured)
            }
            Err(error) => {
                state.failed = true;
                Err(error)
            }
        }
    }

    async fn capture_sequence(
        &self,
        sequence: i64,
        expected_days: u64,
    ) -> Result<bool, &'static str> {
        if stored_retention_days(&self.db)? != expected_days {
            return Err(CLIPBOARD_CAPTURE_FAILED);
        }

        let text = format!("atools-r46-fixture-capture-{sequence}");
        let snapshot = NativePasteboardSnapshot {
            change_count: sequence,
            copied_at: atools_core::utils::now_iso(),
            source_app: None,
            is_confidential: false,
            is_transient: false,
            representations: vec![NativePasteboardRepresentation::Text(text.clone())],
        };
        {
            let mut queue = self.backend.snapshots.lock();
            if !queue.is_empty() {
                return Err(CLIPBOARD_CAPTURE_FAILED);
            }
            queue.push_back(snapshot);
        }
        let outcome = self
            .runtime
            .capture_once()
            .await
            .map_err(|_| CLIPBOARD_CAPTURE_FAILED)?;
        let item_id = outcome.changed_item_id().ok_or(CLIPBOARD_CAPTURE_FAILED)?;
        let item = self
            .db
            .get_pasteboard_item(item_id)
            .map_err(|_| CLIPBOARD_CAPTURE_FAILED)?
            .ok_or(CLIPBOARD_CAPTURE_FAILED)?;
        if item.kind != PasteboardItemKind::Text
            || item.pinned
            || item.payload.get("text").and_then(Value::as_str) != Some(text.as_str())
            || item.copied_at.is_empty()
        {
            return Err(CLIPBOARD_CAPTURE_FAILED);
        }
        Ok(true)
    }

    pub(super) fn insert_reset_history(&self) -> Result<(), &'static str> {
        {
            let mut state = self.state.lock();
            if state.next_sequence != 3
                || state.capture_in_flight
                || state.failed
                || state.reset_history_attempted
            {
                return Err(CLIPBOARD_EDIT_FAILED);
            }
            state.reset_history_attempted = true;
        }
        if stored_retention_days(&self.db).map_err(|_| CLIPBOARD_EDIT_FAILED)? != 180 {
            return Err(CLIPBOARD_EDIT_FAILED);
        }
        let before = self.snapshot().map_err(|_| CLIPBOARD_EDIT_FAILED)?;
        if before["pasteboardCount"].as_u64() != Some(3)
            || before["legacyCount"].as_u64() != Some(2)
            || before["reset100DayPresent"].as_bool() != Some(false)
            || before["legacyReset100DayPresent"].as_bool() != Some(false)
        {
            return Err(CLIPBOARD_EDIT_FAILED);
        }

        let item = seed_item(RESET_ITEM_ID, RESET_ITEM_TEXT, 100, false);
        self.db
            .upsert_pasteboard_item(&to_pasteboard_item(&item))
            .map_err(|_| CLIPBOARD_EDIT_FAILED)?;
        self.db
            .record_clipboard_text(RESET_ITEM_TEXT, &item.copied_at)
            .map_err(|_| CLIPBOARD_EDIT_FAILED)?;
        self.state.lock().reset_item = Some(item);
        Ok(())
    }
}

fn verify_private_profile(profile: &Profile) -> Result<(), &'static str> {
    fixture_owner::verify(profile).map_err(|_| BASELINE_INVALID)?;
    verify_private_directory(&profile.root, &profile.root.join("app-data"))
}

fn verify_private_directory(root: &Path, path: &Path) -> Result<(), &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| BASELINE_INVALID)?;
    if !metadata.file_type().is_dir() {
        return Err(BASELINE_INVALID);
    }
    let canonical_root = fs::canonicalize(root).map_err(|_| BASELINE_INVALID)?;
    let canonical_path = fs::canonicalize(path).map_err(|_| BASELINE_INVALID)?;
    if canonical_path.as_path() != path || !canonical_path.starts_with(&canonical_root) {
        return Err(BASELINE_INVALID);
    }
    Ok(())
}

fn verify_private_directory_if_present(root: &Path, path: &Path) -> Result<(), &'static str> {
    match fs::symlink_metadata(path) {
        Ok(_) => verify_private_directory(root, path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(BASELINE_INVALID),
    }
}

fn seed_item(id: &'static str, text: &'static str, age_days: u64, pinned: bool) -> SeedItem {
    SeedItem {
        id,
        text,
        copied_at: atools_core::utils::iso_days_ago(age_days),
        pinned,
    }
}

fn to_pasteboard_item(seed: &SeedItem) -> PasteboardItem {
    PasteboardItem {
        id: seed.id.into(),
        kind: PasteboardItemKind::Text,
        title: None,
        source_app: None,
        source_device_id: "renderer-general-policies-fixture".into(),
        copied_at: seed.copied_at.clone(),
        updated_at: seed.copied_at.clone(),
        content_fingerprint: format!("renderer-general-policies:{}", seed.id),
        payload: json!({"text": seed.text}),
        ocr_text: None,
        pinboard_id: None,
        pinboard_order_key: None,
        pinned: seed.pinned,
        field_clocks: json!({}),
    }
}

fn pasteboard_count(db: &Database) -> Result<u64, &'static str> {
    let rows = db
        .search_pasteboard_items("", None, &[], MAX_PASTEBOARD_ROWS, 0)
        .map_err(|_| CLIPBOARD_CAPTURE_FAILED)?;
    if rows.len() == MAX_PASTEBOARD_ROWS {
        return Err(CLIPBOARD_CAPTURE_FAILED);
    }
    u64::try_from(rows.len()).map_err(|_| CLIPBOARD_CAPTURE_FAILED)
}

fn legacy_count(db: &Database) -> Result<u64, &'static str> {
    let page = db
        .clipboard_history_page("", 1, 1)
        .map_err(|_| CLIPBOARD_CAPTURE_FAILED)?;
    u64::try_from(page.total).map_err(|_| CLIPBOARD_CAPTURE_FAILED)
}

fn item_present(db: &Database, seed: &SeedItem) -> Result<bool, &'static str> {
    let Some(item) = db
        .get_pasteboard_item(seed.id)
        .map_err(|_| CLIPBOARD_CAPTURE_FAILED)?
    else {
        return Ok(false);
    };
    Ok(item.kind == PasteboardItemKind::Text
        && item.pinned == seed.pinned
        && item.copied_at == seed.copied_at
        && item.payload.get("text").and_then(Value::as_str) == Some(seed.text))
}

fn legacy_present(db: &Database, text: &str, copied_at: &str) -> Result<bool, &'static str> {
    let entries = db
        .search_clipboard_history(text, 2)
        .map_err(|_| CLIPBOARD_CAPTURE_FAILED)?;
    Ok(entries.iter().any(|entry| {
        entry.text == text
            && entry.first_copied_at == copied_at
            && entry.last_copied_at == copied_at
    }))
}

fn stored_retention_days(db: &Database) -> Result<u64, &'static str> {
    let raw = db
        .get_setting("settings-general")
        .map_err(|_| CLIPBOARD_CAPTURE_FAILED)?
        .ok_or(CLIPBOARD_CAPTURE_FAILED)?;
    let value: Value = serde_json::from_str(&raw).map_err(|_| CLIPBOARD_CAPTURE_FAILED)?;
    value["clipboardRetentionDays"]
        .as_u64()
        .filter(|days| (1..=3650).contains(days))
        .ok_or(CLIPBOARD_CAPTURE_FAILED)
}
