use super::*;
use serde_json::json;
use std::sync::Arc;

fn large_json_string(length: usize) -> Vec<u8> {
    serde_json::to_vec(&"x".repeat(length)).unwrap()
}

#[test]
fn repeated_large_command_reads_restart_pagination_without_replacing_snapshot() {
    let buffers = CommandDataBuffers::new("session-a".into(), "bundle-a".into());
    let token = buffers
        .store_commands(large_json_string(MAX_PAGE_BYTES + 31))
        .unwrap();

    for _ in 0..2 {
        let first = buffers.first_page(DataKind::Commands, &token).unwrap();
        assert_eq!(first.offset, 0);
        assert_eq!(first.next_offset, MAX_PAGE_BYTES);
        let second = buffers
            .next_page(DataKind::Commands, &token, first.next_offset)
            .unwrap();
        assert_eq!(second.next_offset, second.total_bytes);
    }
}

#[tokio::test]
async fn command_catalog_invalidation_discards_only_the_command_snapshot() {
    let buffers = CommandDataBuffers::new("session-a".into(), "bundle-a".into());
    let old_commands = buffers
        .store_commands(br#"{"commands":["old"]}"#.to_vec())
        .unwrap();
    let aliases = buffers
        .store_alias_base(
            Some("alias-raw".into()),
            json!({"plugin":{"run":"Run"}}),
            serde_json::to_vec(&json!({"plugin":{"run":"Run"}})).unwrap(),
        )
        .unwrap();
    let command_settings = buffers
        .store_command_settings(serde_json::to_vec(&json!({"disable-commands":[]})).unwrap())
        .unwrap();

    assert!(buffers.invalidate_commands().await);
    assert_eq!(buffers.commands_token().unwrap(), None);
    assert!(buffers
        .first_page(DataKind::Commands, &old_commands)
        .is_err());
    assert_eq!(buffers.alias_base().unwrap().unwrap().token, aliases.token);
    assert_eq!(
        buffers.command_settings_token().unwrap().as_deref(),
        Some(command_settings.as_str())
    );

    let new_commands = buffers
        .store_commands(br#"{"commands":["new"]}"#.to_vec())
        .unwrap();
    assert_ne!(new_commands, old_commands);
    let page = buffers
        .first_page(DataKind::Commands, &new_commands)
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&page.bytes).unwrap()["commands"][0],
        "new"
    );
}

#[tokio::test]
async fn command_invalidation_waits_for_the_active_catalog_read_gate() {
    let buffers = Arc::new(CommandDataBuffers::new(
        "session-a".into(),
        "bundle-a".into(),
    ));
    buffers
        .store_commands(br#"{"commands":["old"]}"#.to_vec())
        .unwrap();
    let read_gate = buffers.commands_read_gate.lock().await;
    let invalidation_buffers = Arc::clone(&buffers);
    let mut invalidation =
        tokio::spawn(async move { invalidation_buffers.invalidate_commands().await });
    tokio::task::yield_now().await;
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(5), &mut invalidation)
            .await
            .is_err()
    );
    assert!(buffers.commands_token().unwrap().is_some());
    drop(read_gate);
    assert!(invalidation.await.unwrap());
    assert_eq!(buffers.commands_token().unwrap(), None);
}

#[test]
fn large_alias_reads_restart_after_a_write_and_keep_the_new_base_writable() {
    let buffers = CommandDataBuffers::new("session-a".into(), "bundle-a".into());
    let old_value = json!({"bucket": "o".repeat(MAX_PAGE_BYTES + 50)});
    let old_bytes = serde_json::to_vec(&old_value).unwrap();
    let old_base = buffers
        .store_alias_base(Some("old-raw".into()), old_value, old_bytes)
        .unwrap();

    for _ in 0..2 {
        let first = buffers
            .first_page(DataKind::Aliases, &old_base.token)
            .unwrap();
        buffers
            .next_page(DataKind::Aliases, &old_base.token, first.next_offset)
            .unwrap();
    }
    let retained = buffers
        .store_alias_base(
            Some("different-raw".into()),
            json!({"bucket":"different"}),
            serde_json::to_vec(&json!({"bucket":"different"})).unwrap(),
        )
        .unwrap();
    assert_eq!(retained.token, old_base.token);
    assert_eq!(retained.raw.as_deref(), Some("old-raw"));

    let desired = json!({"bucket": "n".repeat(MAX_PAGE_BYTES + 60)});
    let desired_bytes = serde_json::to_vec(&desired).unwrap();
    let reservation = buffers
        .reserve_inline_write(&old_base.token, desired_bytes.clone())
        .unwrap();
    let staged = buffers.take_staged_write(&reservation.write_token).unwrap();
    assert_eq!(staged.desired, desired);
    let next_token = buffers
        .finish_alias_write_success(
            &reservation.write_token,
            Some("new-raw".into()),
            &desired,
            desired_bytes,
        )
        .unwrap()
        .unwrap();
    assert!(buffers
        .first_page(DataKind::Aliases, &old_base.token)
        .is_err());

    for _ in 0..2 {
        let first_again = buffers.first_page(DataKind::Aliases, &next_token).unwrap();
        let second_again = buffers
            .next_page(DataKind::Aliases, &next_token, first_again.next_offset)
            .unwrap();
        assert_eq!(second_again.next_offset, second_again.total_bytes);
    }
    let reservation = buffers
        .reserve_inline_write(&next_token, serde_json::to_vec(&json!({})).unwrap())
        .unwrap();
    assert!(buffers
        .abort_staged_write(&reservation.write_token)
        .unwrap());
}

#[test]
fn aliases_cannot_be_written_until_every_initial_page_is_read() {
    let buffers = CommandDataBuffers::new("session-a".into(), "bundle-a".into());
    let value = json!({"bucket": "x".repeat(MAX_PAGE_BYTES + 4)});
    let bytes = serde_json::to_vec(&value).unwrap();
    let base = buffers
        .store_alias_base(Some("raw".into()), value, bytes)
        .unwrap();
    assert!(buffers
        .reserve_inline_write(&base.token, b"{}".to_vec())
        .is_err());

    let first = buffers.first_page(DataKind::Aliases, &base.token).unwrap();
    assert!(buffers
        .next_page(DataKind::Aliases, &base.token, first.next_offset + 1)
        .is_err());
    buffers
        .next_page(DataKind::Aliases, &base.token, first.next_offset)
        .unwrap();
    assert!(buffers
        .reserve_inline_write(&base.token, b"{}".to_vec())
        .is_ok());
}

#[test]
fn close_clears_active_buffers_even_while_a_session_view_is_held() {
    let buffers = Arc::new(CommandDataBuffers::new(
        "session-a".into(),
        "bundle-a".into(),
    ));
    let value = json!({"id":[{"alias":"before"}]});
    let base = buffers
        .store_alias_base(None, value.clone(), serde_json::to_vec(&value).unwrap())
        .unwrap();
    buffers
        .store_command_settings(serde_json::to_vec(&json!({"settings": [1, 2, 3]})).unwrap())
        .unwrap();
    let reservation = buffers
        .reserve_inline_write(&base.token, serde_json::to_vec(&json!({})).unwrap())
        .unwrap();
    let held_view = Arc::clone(&buffers);
    assert!(held_view.command_settings_bytes() > 0);

    let mut marked = false;
    buffers
        .close_after_mark(|| {
            marked = true;
            Ok::<_, String>(())
        })
        .unwrap();
    assert!(marked);
    assert_eq!(held_view.diagnostics(), (0, 0, 0, true));
    assert_eq!(held_view.command_settings_bytes(), 0);
    assert!(held_view
        .take_staged_write(&reservation.write_token)
        .is_err());
}

#[test]
fn invalid_append_offset_discards_the_staged_candidate() {
    let buffers = CommandDataBuffers::new("session-a".into(), "bundle-a".into());
    let value = json!({"id":[{"alias":"before"}]});
    let base = buffers
        .store_alias_base(None, value.clone(), serde_json::to_vec(&value).unwrap())
        .unwrap();
    let reservation = buffers.begin_alias_write(&base.token, 4).unwrap();

    assert!(buffers
        .append_alias_write(&reservation.write_token, 1, b"{}")
        .is_err());
    assert!(buffers
        .staged_write_offset(&reservation.write_token)
        .is_err());
}

#[test]
fn tokens_are_bound_to_the_session_and_bundle() {
    let first = CommandDataBuffers::new("session-a".into(), "bundle-a".into());
    let second = CommandDataBuffers::new("session-b".into(), "bundle-a".into());
    let third = CommandDataBuffers::new("session-a".into(), "bundle-b".into());
    let token = first.store_commands(b"{}".to_vec()).unwrap();

    assert!(second.first_page(DataKind::Commands, &token).is_err());
    assert!(third.first_page(DataKind::Commands, &token).is_err());
    assert!(first.first_page(DataKind::Aliases, &token).is_err());
    first.close();
    assert!(first.first_page(DataKind::Commands, &token).is_err());
}

#[test]
fn write_in_flight_error_is_reported_while_alias_candidate_is_staged() {
    let buffers = CommandDataBuffers::new("session-a".into(), "bundle-a".into());
    let value = json!({"id":[{"alias":"before"}]});
    let base = buffers
        .store_alias_base(None, value.clone(), serde_json::to_vec(&value).unwrap())
        .unwrap();
    buffers.begin_alias_write(&base.token, 2).unwrap();

    let error = buffers.alias_base().unwrap_err();
    let serialized = serde_json::to_value(error).unwrap();
    assert_eq!(serialized["code"], "SETTINGS_ALIAS_WRITE_IN_FLIGHT");
}
