use super::schema;
use crate::renderer_desktop_smoke::settings_input_journey::state::Harness;
use atools_core::db::{Database, RENDERER_DISABLED_COMMANDS_KEY};
use serde_json::Value;
use std::{collections::BTreeMap, time::Duration};
use tauri::async_runtime;

const DISABLED_KEY: &str = RENDERER_DISABLED_COMMANDS_KEY;
const UNRELATED_KEYS: [&str; 13] = [
    "settings-general",
    "ztools-renderer:command-aliases",
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
const SETTING_KEYS: [&str; 14] = [
    DISABLED_KEY,
    UNRELATED_KEYS[0],
    UNRELATED_KEYS[1],
    UNRELATED_KEYS[2],
    UNRELATED_KEYS[3],
    UNRELATED_KEYS[4],
    UNRELATED_KEYS[5],
    UNRELATED_KEYS[6],
    UNRELATED_KEYS[7],
    UNRELATED_KEYS[8],
    UNRELATED_KEYS[9],
    UNRELATED_KEYS[10],
    UNRELATED_KEYS[11],
    UNRELATED_KEYS[12],
];
const MAX_SETTING_BYTES: usize = 128 * 1024;
const MAX_SETTINGS_BYTES: usize = 4 * 1024 * 1024;
const STATE_TIMEOUT: Duration = Duration::from_secs(8);
const STATE_POLL: Duration = Duration::from_millis(50);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum DisabledSetting {
    Missing,
    Valid(Vec<String>),
    Invalid,
}

pub(super) struct SettingsSnapshot {
    pub(super) disabled: DisabledSetting,
    pub(super) unrelated: BTreeMap<String, Option<String>>,
}

pub(super) fn baseline_enabled(setting: &DisabledSetting) -> bool {
    match setting {
        DisabledSetting::Missing => true,
        DisabledSetting::Valid(values) => values.is_empty(),
        DisabledSetting::Invalid => false,
    }
}

pub(super) async fn read_settings(harness: &Harness) -> Result<SettingsSnapshot, &'static str> {
    let db = harness.database();
    async_runtime::spawn_blocking(move || read_settings_blocking(&db))
        .await
        .map_err(|_| schema::PROBE_FAILED)?
}

fn read_settings_blocking(db: &Database) -> Result<SettingsSnapshot, &'static str> {
    let values = db
        .read_settings_bounded(&SETTING_KEYS, MAX_SETTING_BYTES, MAX_SETTINGS_BYTES)
        .map_err(|_| schema::PROBE_FAILED)?;
    let disabled_raw = values.get(DISABLED_KEY).ok_or(schema::PROBE_FAILED)?;
    let unrelated = UNRELATED_KEYS
        .iter()
        .map(|key| {
            values
                .get(*key)
                .cloned()
                .map(|value| ((*key).to_owned(), value))
                .ok_or(schema::PROBE_FAILED)
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    Ok(SettingsSnapshot {
        disabled: parse_disabled_setting(disabled_raw.as_deref()),
        unrelated,
    })
}

fn parse_disabled_setting(raw: Option<&str>) -> DisabledSetting {
    let Some(raw) = raw else {
        return DisabledSetting::Missing;
    };
    let Ok(Value::Array(values)) = serde_json::from_str::<Value>(raw) else {
        return DisabledSetting::Invalid;
    };
    if values.len() > 4096 {
        return DisabledSetting::Invalid;
    }
    let mut ids = Vec::with_capacity(values.len());
    for value in values {
        let Some(id) = value.as_str() else {
            return DisabledSetting::Invalid;
        };
        if id.is_empty() || id.len() > 16_448 {
            return DisabledSetting::Invalid;
        }
        ids.push(id.to_owned());
    }
    DisabledSetting::Valid(ids)
}

pub(super) async fn wait_for_disabled_state(
    harness: &Harness,
    command_id: &str,
    should_be_disabled: bool,
) -> (bool, Option<SettingsSnapshot>) {
    let deadline = tokio::time::Instant::now() + STATE_TIMEOUT;
    let expected = if should_be_disabled {
        DisabledSetting::Valid(vec![command_id.to_owned()])
    } else {
        DisabledSetting::Valid(Vec::new())
    };
    let mut latest = None;
    loop {
        match read_settings(harness).await {
            Ok(snapshot) => {
                let matched = snapshot.disabled == expected;
                latest = Some(snapshot);
                if matched {
                    return (true, latest);
                }
            }
            Err(_) => {}
        }
        if tokio::time::Instant::now() >= deadline {
            return (false, latest);
        }
        tokio::time::sleep(STATE_POLL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::{baseline_enabled, parse_disabled_setting, DisabledSetting};

    #[test]
    fn disabled_setting_requires_valid_string_array_and_distinguishes_missing() {
        assert_eq!(parse_disabled_setting(None), DisabledSetting::Missing);
        assert_eq!(
            parse_disabled_setting(Some("[]")),
            DisabledSetting::Valid(Vec::new())
        );
        assert_eq!(
            parse_disabled_setting(Some(r#"["plugin:unknown","x","x"]"#)),
            DisabledSetting::Valid(vec![
                "plugin:unknown".to_owned(),
                "x".to_owned(),
                "x".to_owned()
            ])
        );
        for invalid in ["null", "7", "{}", "[3]", "[\"\"]"] {
            assert_eq!(
                parse_disabled_setting(Some(invalid)),
                DisabledSetting::Invalid
            );
        }
        let too_many = serde_json::to_string(&vec!["x"; 4097]).unwrap();
        assert_eq!(
            parse_disabled_setting(Some(&too_many)),
            DisabledSetting::Invalid
        );
        let too_long_id = format!("[\"{}\"]", "x".repeat(16_449));
        assert_eq!(
            parse_disabled_setting(Some(&too_long_id)),
            DisabledSetting::Invalid
        );
    }

    #[test]
    fn baseline_only_accepts_missing_or_explicit_empty() {
        assert!(baseline_enabled(&DisabledSetting::Missing));
        assert!(baseline_enabled(&DisabledSetting::Valid(Vec::new())));
        assert!(!baseline_enabled(&DisabledSetting::Valid(vec![
            "other".into()
        ])));
        assert!(!baseline_enabled(&DisabledSetting::Invalid));
    }
}
