use super::super::MAX_PAGE_BYTES;
use super::*;
use serde_json::json;

fn document(disabled: Value) -> Value {
    json!({
        "disable-commands": disabled,
        "pinned-commands": [],
        "super-panel-pinned": [],
        "global-shortcuts": [],
        "app-shortcuts": [],
    })
}

#[test]
fn complete_single_page_read_exposes_only_the_frozen_disabled_command_base() {
    let buffers = CommandDataBuffers::new("session-a".into(), "bundle-a".into());
    let bytes = serde_json::to_vec(&document(json!(["plugin:feature:cmd:text"]))).unwrap();
    let token = buffers.store_command_settings(bytes.clone()).unwrap();
    assert_eq!(
        buffers
            .store_command_settings(serde_json::to_vec(&document(Value::Null)).unwrap())
            .unwrap(),
        token
    );

    assert_eq!(
        buffers
            .first_page(DataKind::CommandSettings, &token)
            .unwrap()
            .bytes,
        bytes
    );
    assert_eq!(
        buffers
            .command_settings_disabled_commands_base(&token)
            .unwrap(),
        json!(["plugin:feature:cmd:text"])
    );
}

#[test]
fn paged_snapshot_cannot_be_used_as_a_cas_base_until_its_final_page_is_read() {
    let buffers = CommandDataBuffers::new("session-a".into(), "bundle-a".into());
    let disabled = json!([
        "direct:app:/Applications/Editor.app",
        format!("plugin:fixture:{}", "a".repeat(16_400)),
        format!("legacy:{}", "b".repeat(16_400)),
    ]);
    let disabled_ids = disabled.as_array().unwrap();
    assert!(disabled_ids.len() <= 4096);
    assert!(disabled_ids.iter().all(|id| {
        id.as_str()
            .is_some_and(|id| !id.is_empty() && id.len() <= 16_448)
    }));
    assert!(serde_json::to_vec(&disabled).unwrap().len() <= 128 * 1024);
    let original = serde_json::to_vec(&document(disabled.clone())).unwrap();
    assert!(original.len() > MAX_PAGE_BYTES);
    assert!(original.len() <= 128 * 1024);
    assert!(original.len() <= MAX_COMMAND_SETTINGS_BYTES);
    let token = buffers.store_command_settings(original.clone()).unwrap();

    let first = buffers
        .first_page(DataKind::CommandSettings, &token)
        .unwrap();
    assert_eq!(first.next_offset, MAX_PAGE_BYTES);
    assert_eq!(
        serde_json::to_value(
            buffers
                .command_settings_disabled_commands_base(&token)
                .unwrap_err(),
        )
        .unwrap()["code"],
        "SETTINGS_DISABLED_COMMANDS_BASE_INVALID"
    );

    let mut offset = first.next_offset;
    while offset < first.total_bytes {
        let page = buffers
            .next_page(DataKind::CommandSettings, &token, offset)
            .unwrap();
        offset = page.next_offset;
    }
    assert_eq!(
        buffers
            .command_settings_disabled_commands_base(&token)
            .unwrap(),
        disabled
    );
}

#[test]
fn disabled_command_base_rejects_wrong_scope_tokens_and_closed_or_invalidated_snapshots() {
    let first = CommandDataBuffers::new("session-a".into(), "bundle-a".into());
    let other_session = CommandDataBuffers::new("session-b".into(), "bundle-a".into());
    let other_bundle = CommandDataBuffers::new("session-a".into(), "bundle-b".into());
    let token = first
        .store_command_settings(serde_json::to_vec(&document(Value::Null)).unwrap())
        .unwrap();
    first.first_page(DataKind::CommandSettings, &token).unwrap();
    let command_token = first.store_commands(b"{}".to_vec()).unwrap();

    for invalid in [
        first.command_settings_disabled_commands_base("unknown"),
        first.command_settings_disabled_commands_base(&command_token),
        other_session.command_settings_disabled_commands_base(&token),
        other_bundle.command_settings_disabled_commands_base(&token),
    ] {
        assert_eq!(
            serde_json::to_value(invalid.unwrap_err()).unwrap()["code"],
            "SETTINGS_DISABLED_COMMANDS_BASE_INVALID"
        );
    }

    assert!(first.invalidate_command_settings());
    assert_eq!(first.command_settings_token().unwrap(), None);
    assert_eq!(first.command_settings_bytes(), 0);
    assert_eq!(
        serde_json::to_value(
            first
                .command_settings_disabled_commands_base(&token)
                .unwrap_err()
        )
        .unwrap()["code"],
        "SETTINGS_DISABLED_COMMANDS_BASE_INVALID"
    );

    let refreshed = serde_json::to_vec(&document(json!(["refreshed"]))).unwrap();
    let refreshed_token = first.store_command_settings(refreshed.clone()).unwrap();
    assert_ne!(refreshed_token, token);
    assert_eq!(first.command_settings_bytes(), refreshed.len());
    first
        .first_page(DataKind::CommandSettings, &refreshed_token)
        .unwrap();
    assert_eq!(
        first
            .command_settings_disabled_commands_base(&refreshed_token)
            .unwrap(),
        json!(["refreshed"])
    );

    first.close();
    assert!(!first.invalidate_command_settings());
    assert!(first
        .store_command_settings(serde_json::to_vec(&document(Value::Null)).unwrap())
        .is_err());
    assert_eq!(
        serde_json::to_value(
            first
                .command_settings_disabled_commands_base(&token)
                .unwrap_err()
        )
        .unwrap()["code"],
        "SETTINGS_DISABLED_COMMANDS_BASE_INVALID"
    );
}

#[test]
fn one_page_read_marks_only_the_returned_snapshot_complete() {
    let buffers = CommandDataBuffers::new("session-a".into(), "bundle-a".into());
    let token = buffers
        .store_command_settings(serde_json::to_vec(&document(Value::Null)).unwrap())
        .unwrap();
    assert_eq!(
        serde_json::to_value(
            buffers
                .command_settings_disabled_commands_base(&token)
                .unwrap_err()
        )
        .unwrap()["code"],
        "SETTINGS_DISABLED_COMMANDS_BASE_INVALID"
    );
    buffers
        .first_page(DataKind::CommandSettings, &token)
        .unwrap();
    assert_eq!(
        buffers
            .command_settings_disabled_commands_base(&token)
            .unwrap(),
        Value::Null
    );
}

#[test]
fn command_settings_snapshot_rejects_empty_oversized_and_invalid_json() {
    let buffers = CommandDataBuffers::new("session-a".into(), "bundle-a".into());
    assert!(buffers.store_command_settings(Vec::new()).is_err());
    assert!(buffers
        .store_command_settings(vec![b' '; MAX_COMMAND_SETTINGS_BYTES + 1])
        .is_err());
    assert!(buffers
        .store_command_settings(b"not-json".to_vec())
        .is_err());
}

#[test]
fn command_settings_data_kind_keeps_the_fixed_wire_name() {
    assert_eq!(
        DataKind::parse("commandSettings").unwrap(),
        DataKind::CommandSettings
    );
    assert_eq!(DataKind::CommandSettings.as_str(), "commandSettings");
    assert!(DataKind::parse("command-settings").is_err());
}
