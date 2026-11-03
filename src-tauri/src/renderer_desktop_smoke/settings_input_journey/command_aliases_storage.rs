use super::{command_aliases_schema as schema, state::Harness};
use atools_core::Database;
use serde_json::{json, Value};
use std::collections::BTreeMap;

const ALIASES_KEY: &str = "ztools-renderer:command-aliases";
const SENTINEL_COMMAND: &str = "fixture:atools-r41-preserved";
const OPAQUE_COMMAND: &str = "fixture:atools-r41-opaque";
const SENTINEL_ALIAS: &str = "atools-r41-preserve-sentinel";
const OPAQUE_RECORD: &str = "opaque-r41-value-preserved";
const MAX_SETTING_BYTES: usize = 128 * 1024;
const MAX_SETTINGS_BYTES: usize = 4 * 1024 * 1024;
const SETTING_KEYS: [&str; 14] = [
    atools_core::db::RENDERER_DISABLED_COMMANDS_KEY,
    "settings-general",
    ALIASES_KEY,
    "ztools-renderer:enabled-main-push-plugin",
    "ztools-renderer:search-preference",
    "ztools-renderer:recommendation-pinned",
    "ztools-renderer:command-history",
    "ztools-renderer:pinned-commands",
    "ztools-renderer:out-kill-plugin",
    "ztools-renderer:auto-detach-plugin",
    "ztools-renderer:auto-start-plugin",
    "ztools-renderer:super-panel-pinned",
    "ztools-renderer:local-shortcuts",
    "ztools-renderer:command-usage-stats",
];

pub(super) struct Baseline {
    pub(super) raw: String,
    pub(super) unrelated: BTreeMap<String, Option<String>>,
    pub(super) target_command: String,
}

pub(super) async fn seed_and_read_baseline(
    harness: &Harness,
    target: &(String, String),
) -> Result<(Database, Baseline), &'static str> {
    let profile = harness.profile_arc();
    let target_command = format!("direct:app:{}", target.1.replace('\\', "/"));
    tauri::async_runtime::spawn_blocking(move || {
        let path = profile.root.join("app-data/data.db");
        let independent = Database::open(&path).map_err(|_| schema::STATE_INVALID)?;
        let before = read_settings(&independent)?;
        if before.get(ALIASES_KEY).is_none_or(Option::is_some) {
            return Err(schema::BASELINE_INVALID);
        }
        let seeded = json!({
            SENTINEL_COMMAND: [{"alias": SENTINEL_ALIAS}],
            OPAQUE_COMMAND: [{"opaque": OPAQUE_RECORD}],
        });
        let raw = serde_json::to_string(&seeded).map_err(|_| schema::STATE_INVALID)?;
        independent
            .set_setting(ALIASES_KEY, &raw)
            .map_err(|_| schema::STATE_INVALID)?;
        let stored = independent
            .get_setting(ALIASES_KEY)
            .map_err(|_| schema::STATE_INVALID)?
            .ok_or(schema::STATE_INVALID)?;
        if stored != raw || !target_bucket_absent(&stored, &target_command) {
            return Err(schema::BASELINE_INVALID);
        }
        let after = read_settings(&independent)?;
        let unrelated = before
            .into_iter()
            .filter(|(key, _)| key != ALIASES_KEY)
            .collect::<BTreeMap<_, _>>();
        if !same_settings(&unrelated, &after, ALIASES_KEY) {
            return Err(schema::UNRELATED_CHANGED);
        }
        Ok((
            independent,
            Baseline {
                raw,
                unrelated,
                target_command,
            },
        ))
    })
    .await
    .map_err(|_| schema::STATE_INVALID)?
}

pub(super) async fn raw_aliases(db: &Database) -> Result<String, &'static str> {
    let db = db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        db.get_setting(ALIASES_KEY)
            .map_err(|_| schema::STATE_INVALID)?
            .ok_or(schema::STATE_INVALID)
    })
    .await
    .map_err(|_| schema::STATE_INVALID)?
}

pub(super) fn target_aliases_equal(raw: &str, command_id: &str, expected: &[&str]) -> bool {
    let Ok(value) = atools_core::db::normalize_renderer_command_aliases(Some(raw)) else {
        return false;
    };
    match value.get(command_id) {
        None => expected.is_empty(),
        Some(Value::Array(records)) => {
            let actual = records
                .iter()
                .filter_map(|record| record["alias"].as_str())
                .collect::<Vec<_>>();
            actual == expected
        }
        _ => false,
    }
}

pub(super) fn preserved_alias_data(raw: &str, baseline_raw: &str, command_id: &str) -> bool {
    let Ok(actual) = serde_json::from_str::<Value>(raw) else {
        return false;
    };
    let Ok(mut initial) = serde_json::from_str::<Value>(baseline_raw) else {
        return false;
    };
    let mut actual = actual;
    let Some(actual) = actual.as_object_mut() else {
        return false;
    };
    let Some(initial) = initial.as_object_mut() else {
        return false;
    };
    actual.remove(command_id);
    initial.remove(command_id);
    actual == initial
}

pub(super) async fn unrelated_preserved(
    db: &Database,
    baseline: &Baseline,
) -> Result<bool, &'static str> {
    let db = db.clone();
    let expected = baseline.unrelated.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let current = read_settings(&db)?;
        Ok(same_settings(&expected, &current, ALIASES_KEY))
    })
    .await
    .map_err(|_| schema::STATE_INVALID)?
}

pub(super) fn target_command(baseline: &Baseline) -> &str {
    &baseline.target_command
}

fn read_settings(db: &Database) -> Result<BTreeMap<String, Option<String>>, &'static str> {
    let settings = db
        .read_settings_bounded(&SETTING_KEYS, MAX_SETTING_BYTES, MAX_SETTINGS_BYTES)
        .map_err(|_| schema::STATE_INVALID)?;
    if settings.len() != SETTING_KEYS.len() {
        return Err(schema::STATE_INVALID);
    }
    Ok(settings)
}

fn same_settings(
    expected: &BTreeMap<String, Option<String>>,
    actual: &BTreeMap<String, Option<String>>,
    except: &str,
) -> bool {
    SETTING_KEYS
        .iter()
        .all(|key| *key == except || expected.get(*key) == actual.get(*key))
}

fn target_bucket_absent(raw: &str, target_command: &str) -> bool {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.get(target_command).cloned())
        .is_none_or(|bucket| bucket.as_array().is_some_and(Vec::is_empty))
}

#[cfg(test)]
mod tests {
    use super::{preserved_alias_data, target_aliases_equal, target_bucket_absent};

    #[test]
    fn alias_storage_helpers_preserve_sentinels_and_detect_target_state() {
        let baseline = r#"{"fixture:atools-r41-preserved":[{"alias":"atools-r41-preserve-sentinel"}],"fixture:atools-r41-opaque":[{"opaque":"opaque-r41-value-preserved"}]}"#;
        let added = r#"{"fixture:atools-r41-preserved":[{"alias":"atools-r41-preserve-sentinel"}],"fixture:atools-r41-opaque":[{"opaque":"opaque-r41-value-preserved"}],"direct:app:/Applications/Example.app":[{"alias":"alias-added"}]}"#;
        assert!(target_bucket_absent(
            baseline,
            "direct:app:/Applications/Example.app"
        ));
        assert!(target_aliases_equal(
            added,
            "direct:app:/Applications/Example.app",
            &["alias-added"]
        ));
        assert!(preserved_alias_data(
            added,
            baseline,
            "direct:app:/Applications/Example.app"
        ));
        let changed = added.replace(OPAQUE_PLACEHOLDER, "changed");
        assert!(!preserved_alias_data(
            &changed,
            baseline,
            "direct:app:/Applications/Example.app"
        ));
        let deleted = baseline;
        assert!(target_aliases_equal(
            deleted,
            "direct:app:/Applications/Example.app",
            &[]
        ));
    }

    const OPAQUE_PLACEHOLDER: &str = "opaque-r41-value-preserved";
}
