use super::*;
use serde_json::json;

fn action(id: &str, label: &str, enabled: Option<bool>) -> RendererMenuItem {
    RendererMenuItem::Action(RendererActionMenuItem {
        id: id.to_string(),
        label: label.to_string(),
        enabled,
    })
}

fn menu_action(path: &str, action: &str, payload_fields: &str) -> String {
    format!("{action}:{{\"path\":\"{path}\"{payload_fields}}}")
}

#[test]
fn renderer_rows_and_separators_accept_only_the_typed_contract() {
    let rows: Vec<RendererMenuItem> = serde_json::from_str(
        r#"[{"id":"pin-app:{\"path\":\"/tmp/app\",\"type\":\"app\"}","label":"Pin"},{"type":"separator"}]"#,
    )
    .unwrap();

    assert_eq!(rows.len(), 2);
    assert!(matches!(rows[1], RendererMenuItem::Separator(_)));
    assert!(serde_json::from_str::<RendererMenuItem>(
        r#"{"id":"future-action:{}","label":"Future","submenu":[]}"#
    )
    .is_err());
    assert!(serde_json::from_str::<RendererMenuItem>(
        r#"{"id":"future-action:{}","label":"Future","enabled":null}"#
    )
    .is_err());
    assert!(serde_json::from_str::<RendererMenuItem>(r#"{"type":"unknown"}"#).is_err());
}

#[test]
fn main_context_requires_both_main_labels() {
    assert!(is_main_context("main", "main"));
    assert!(!is_main_context("plugin-window", "main"));
    assert!(!is_main_context("main", "plugin-window"));
}

#[test]
fn four_supported_actions_require_a_bounded_object_with_string_path() {
    for id in [
        menu_action("/tmp/app", "pin-app", ",\"type\":\"app\""),
        menu_action("/tmp/app", "unpin-app", ""),
        menu_action("/tmp/app", "remove-from-history", ""),
        menu_action("/tmp/app", "reveal-in-finder", ""),
    ] {
        assert!(supported_action_id(&id), "{id}");
    }

    for id in [
        "pin-app:[]",
        "pin-app:{\"type\":\"app\"}",
        "pin-app:{\"path\":42,\"type\":\"app\"}",
        "pin-app:{\"path\":\"\",\"type\":\"app\"}",
        "pin-app:{\"path\":\"a\\u0000b\",\"type\":\"app\"}",
        "unsupported:{\"path\":\"/tmp/app\"}",
        "pin-app:{\"path\":\"/tmp/app\",\"type\":\"app\",\"featureCode\":\"plugin\"}",
        "unpin-app:{\"path\":\"/tmp/app\",\"featureCode\":\"plugin\"}",
        "remove-from-history:{\"path\":\"/tmp/app\",\"featureCode\":42}",
    ] {
        assert!(!supported_action_id(id), "{id}");
    }
}

#[test]
fn recommendation_pin_actions_require_core_valid_records_and_supported_types() {
    let actions = [
        "pin-recommendation",
        "unpin-recommendation",
        "move-recommendation-to-front",
    ];
    for action_name in actions {
        for kind in ["direct", "plugin", "builtin"] {
            let payload = json!({
                "path": "/plugins/example",
                "name": "Example",
                "type": kind,
                "pluginName": "example",
                "featureCode": "feature"
            });
            assert!(
                supported_action_id(&format!("{action_name}:{}", payload)),
                "{action_name}:{payload}"
            );
        }

        for payload in [
            json!({"path":"/plugins/example","name":"Example","type":"app"}),
            json!({"path":"","name":"Example","type":"plugin"}),
            json!({"path":"/plugins/example\0bad","name":"Example","type":"plugin"}),
            json!({"path":"/plugins/example","name":"Example","type":"plugin","featureCode":42}),
            json!({"path":"/plugins/example","name":"Example","type":"plugin","pluginName":null}),
        ] {
            assert!(
                !supported_action_id(&format!("{action_name}:{payload}")),
                "{action_name}:{payload}"
            );
        }
    }

    assert!(!supported_action_id(
        "future-recommendation-action:{\"path\":\"/plugins/example\",\"name\":\"Example\",\"type\":\"plugin\"}"
    ));
}

#[test]
fn recommendation_selection_returns_the_original_action_id_once() {
    let action_id = format!(
        "pin-recommendation:{}",
        json!({"path":"/plugins/example","name":"Example","type":"plugin","pluginName":"example","featureCode":"feature"})
    );
    let items = [action(&action_id, "取消置顶", None)];
    let (rows, session) = prepare_menu_items(&items, "0123456789abcdef0123456789abcdef").unwrap();
    let PreparedMenuRow::Item {
        native_id, enabled, ..
    } = &rows[0]
    else {
        panic!("expected recommendation menu item");
    };

    assert!(*enabled);
    let mut active = Some(session);
    assert_eq!(
        resolve_selection(&mut active, native_id, Instant::now()),
        Some(action_id.clone())
    );
    assert!(active.is_none());
    assert_eq!(
        resolve_selection(&mut active, native_id, Instant::now()),
        None
    );
}

#[test]
fn pin_app_only_accepts_legacy_apps_or_direct_app_entries() {
    assert!(supported_action_id(
        "pin-app:{\"path\":\"/tmp/app\",\"type\":\"app\"}"
    ));
    assert!(supported_action_id(
        "pin-app:{\"path\":\"/tmp/app\",\"type\":\"direct\",\"subType\":\"app\"}"
    ));
    assert!(!supported_action_id(
        "pin-app:{\"path\":\"/tmp/plugin\",\"type\":\"plugin\"}"
    ));
    assert!(!supported_action_id(
        "pin-app:{\"path\":\"/tmp/plugin\",\"type\":\"direct\",\"subType\":\"plugin\"}"
    ));
}

#[test]
fn unsupported_and_explicitly_disabled_actions_remain_unselectable() {
    let items = vec![
        action(
            "pin-super-panel:{\"path\":\"/tmp/app\"}",
            "固定到超级面板",
            None,
        ),
        action(
            "pin-app:{\"path\":\"/tmp/app\",\"type\":\"app\"}",
            "固定到搜索框",
            Some(false),
        ),
    ];
    let (rows, session) = prepare_menu_items(&items, "0123456789abcdef0123456789abcdef").unwrap();

    assert!(matches!(
        rows[0],
        PreparedMenuRow::Item { enabled: false, .. }
    ));
    assert!(matches!(
        rows[1],
        PreparedMenuRow::Item { enabled: false, .. }
    ));
    assert!(session.action_ids_by_native_id.is_empty());
}

#[test]
fn row_count_label_and_total_payload_budgets_are_enforced() {
    let too_many = (0..=MAX_MENU_ROWS)
        .map(|index| action(&format!("unknown:{index}"), "Item", None))
        .collect::<Vec<_>>();
    assert!(validate_menu_items(&too_many).is_err());

    let long_label = action("unknown:payload", &"x".repeat(MAX_LABEL_BYTES + 1), None);
    assert!(validate_menu_items(&[long_label]).is_err());

    let long_id = action(
        &format!("{}", "x".repeat(MAX_ACTION_ID_BYTES + 1)),
        "Item",
        None,
    );
    assert!(validate_menu_items(&[long_id]).is_err());

    let large_payload = (0..9)
        .map(|_| {
            action(
                &format!("{}", "x".repeat(MAX_ACTION_ID_BYTES - 8)),
                "Item",
                None,
            )
        })
        .collect::<Vec<_>>();
    assert!(validate_menu_items(&large_payload).is_err());
}

#[test]
fn native_ids_are_nonce_scoped_and_selections_are_single_use() {
    let items = [action(
        "pin-app:{\"path\":\"/tmp/app\",\"type\":\"app\"}",
        "Pin",
        None,
    )];
    let (rows, mut session) =
        prepare_menu_items(&items, "0123456789abcdef0123456789abcdef").unwrap();
    let PreparedMenuRow::Item { native_id, .. } = &rows[0] else {
        panic!("expected action row");
    };
    let expected = items[0].as_action().unwrap().id.clone();

    assert_eq!(
        resolve_selection(&mut Some(session.clone()), native_id, Instant::now()),
        Some(expected.clone())
    );
    assert_eq!(
        resolve_selection(
            &mut Some(session.clone()),
            "atools-renderer-context-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0",
            Instant::now()
        ),
        None
    );

    let mut active = Some(session);
    assert_eq!(
        resolve_selection(&mut active, native_id, Instant::now()),
        Some(expected)
    );
    assert!(active.is_none());
    assert_eq!(
        resolve_selection(&mut active, native_id, Instant::now()),
        None
    );
}

#[test]
fn disabled_event_id_cannot_dispatch_a_different_action() {
    let items = [
        action(
            "pin-super-panel:{\"path\":\"/tmp/app\"}",
            "Unsupported",
            None,
        ),
        action("unpin-app:{\"path\":\"/tmp/app\"}", "Unpin", None),
    ];
    let (rows, mut session) =
        prepare_menu_items(&items, "0123456789abcdef0123456789abcdef").unwrap();
    let PreparedMenuRow::Item {
        native_id: disabled_id,
        ..
    } = &rows[0]
    else {
        panic!("expected disabled row");
    };
    let PreparedMenuRow::Item {
        native_id: enabled_id,
        ..
    } = &rows[1]
    else {
        panic!("expected enabled row");
    };

    assert_eq!(
        resolve_selection(&mut Some(session.clone()), disabled_id, Instant::now()),
        None
    );
    assert_eq!(
        resolve_selection(&mut Some(session.clone()), enabled_id, Instant::now()),
        Some(items[1].as_action().unwrap().id.clone())
    );
    assert!(session.action_ids_by_native_id.contains_key(enabled_id));
}

#[test]
fn expired_sessions_reject_and_release_their_action_registry() {
    let native_id = native_menu_item_id("0123456789abcdef0123456789abcdef", 0);
    let mut session = Some(MenuSession {
        nonce: "0123456789abcdef0123456789abcdef".into(),
        expires_at: Some(Instant::now() - Duration::from_secs(1)),
        action_ids_by_native_id: HashMap::from([(native_id.clone(), "unpin-app:{}".into())]),
    });

    assert_eq!(
        resolve_selection(&mut session, &native_id, Instant::now()),
        None
    );
    assert!(session.is_none());
}

impl RendererMenuItem {
    fn as_action(&self) -> Option<&RendererActionMenuItem> {
        match self {
            Self::Action(item) => Some(item),
            Self::Separator(_) | Self::More(_) => None,
        }
    }
}

#[test]
fn only_one_more_level_and_exact_app_shortcut_action_are_enabled() {
    let good = r#"[{"label":"更多","submenu":[{"id":"add-global-shortcut:{\"path\":\"/A.app\",\"name\":\"A\",\"subType\":\"app\"}","label":"设置全局快捷键","enabled":true}]}]"#;
    let rows: Vec<RendererMenuItem> = serde_json::from_str(good).unwrap();
    assert!(validate_menu_items(&rows).is_ok());
    let (prepared, session) =
        prepare_menu_items(&rows, "0123456789abcdef0123456789abcdef").unwrap();
    assert!(matches!(&prepared[0], PreparedMenuRow::More { items, .. } if items.len()==1));
    assert_eq!(session.action_ids_by_native_id.len(), 1);
    for bad in [
        good.replace("更多", "任意"),
        good.replace("subType\\\":\\\"app", "subType\\\":\\\"plugin"),
        good.replace("add-global-shortcut", "pin-super-panel"),
    ] {
        let rows: Vec<RendererMenuItem> = serde_json::from_str(&bad).unwrap();
        assert!(validate_menu_items(&rows).is_err(), "{bad}");
    }
    assert!(!app_shortcut_action_id("add-global-shortcut:{\"path\":\"/A.app\",\"name\":\"A\",\"subType\":\"app\",\"confirmed\":true}"));
}

#[test]
fn app_shortcut_menu_caller_accepts_bounded_escaped_identity_beyond_old_id_cap() {
    let path = format!("/Applications/{}", "\\\"".repeat(7_500));
    let name = "\"".repeat(4_096);
    let id = format!(
        "add-global-shortcut:{}",
        serde_json::to_string(&json!({"path":path,"name":name,"subType":"app"})).unwrap()
    );
    assert!(id.len() > MAX_ACTION_ID_BYTES);
    assert!(id.len() < MAX_APP_SHORTCUT_ACTION_ID_BYTES);
    let items = vec![RendererMenuItem::More(RendererMoreMenuItem {
        label: "更多".into(),
        submenu: vec![RendererActionMenuItem {
            id: id.clone(),
            label: "设置全局快捷键".into(),
            enabled: Some(true),
        }],
    })];
    validate_menu_items(&items).unwrap();
    let (rows, mut session) =
        prepare_menu_items(&items, "0123456789abcdef0123456789abcdef").unwrap();
    let PreparedMenuRow::More { items, .. } = &rows[0] else {
        panic!("More missing")
    };
    let PreparedMenuRow::Item {
        native_id, enabled, ..
    } = &items[0]
    else {
        panic!("action missing")
    };
    assert!(*enabled);
    let mut session = Some(session);
    assert_eq!(
        resolve_selection(&mut session, native_id, Instant::now()),
        Some(id)
    );
}

#[test]
fn larger_menu_id_budget_never_expands_other_actions_fields_or_outer_payload() {
    let ordinary = format!(
        "reveal-in-finder:{}",
        serde_json::to_string(&json!({"path":"x".repeat(MAX_ACTION_ID_BYTES)})).unwrap()
    );
    assert!(validate_menu_items(&[action(&ordinary, "Finder", None)]).is_err());
    for payload in [
        json!({"path":"x".repeat(16*1024+1),"name":"A","subType":"app"}),
        json!({"path":"/A.app","name":"x".repeat(4_096+1),"subType":"app"}),
        json!({"path":"/A.app","name":"A","subType":"app","confirmed":true}),
    ] {
        let id = format!("add-global-shortcut:{payload}");
        assert!(!app_shortcut_action_id(&id));
        let menu = RendererMenuItem::More(RendererMoreMenuItem {
            label: "更多".into(),
            submenu: vec![RendererActionMenuItem {
                id,
                label: "Shortcut".into(),
                enabled: Some(true),
            }],
        });
        assert!(validate_menu_items(&[menu]).is_err());
    }
    // Inner valid fields can expand at both JSON layers; the old overall budget
    // still wins, even for the exact new action.
    let id = format!(
        "add-global-shortcut:{}",
        serde_json::to_string(
            &json!({"path":"\u{1}".repeat(16*1024),"name":"\u{1}".repeat(4096),"subType":"app"})
        )
        .unwrap()
    );
    assert!(app_shortcut_action_id(&id));
    assert!(id.len() < MAX_APP_SHORTCUT_ACTION_ID_BYTES);
    assert!(validate_menu_items(&[action(&id, "Shortcut", None)]).is_err());
}
