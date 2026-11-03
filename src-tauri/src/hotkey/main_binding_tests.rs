use super::*;

#[test]
fn repeated_modifier_aliases_are_the_only_new_binding_syntax() {
    for (aliases, modifier) in [
        (&["Cmd", "Command", "Super"][..], Modifier::Command),
        (&["Ctrl", "Control"][..], Modifier::Control),
        (&["Alt", "Option"][..], Modifier::Alt),
        (&["Shift"][..], Modifier::Shift),
    ] {
        for left in aliases {
            for right in aliases {
                assert_eq!(
                    parse_main_binding(&format!("{left}+{right}")),
                    Ok(MainBinding::DoubleTap(modifier))
                );
            }
        }
    }
    assert_eq!(
        parse_main_binding("command+CMD"),
        Ok(MainBinding::DoubleTap(Modifier::Command))
    );
}

#[test]
fn ordinary_accelerators_keep_the_existing_parser_and_normalization() {
    for label in [
        "Option+Z",
        "Command+Space",
        "Ctrl+Shift+K",
        "F1",
        "F12",
        "Command+Ctrl+Option+Shift+F10",
    ] {
        assert_eq!(
            parse_main_binding(label),
            super::super::owned_main::parse_main_hotkey(label).map(MainBinding::Accelerator)
        );
    }
}

#[test]
fn old_rejections_and_malformed_gestures_remain_rejected() {
    for label in [
        "",
        "A",
        "Space",
        "Shift",
        "Ctrl+Control+K",
        "Option+Alt+K",
        " Alt+K",
        "Cmd+Ctrl",
        "Cmd+Cmd+Cmd",
        "Cmd+Cmd+Space",
        "Alt+Shift+Alt",
        "Cmd++Cmd",
        "+Cmd+Cmd",
        "Cmd+Cmd+",
        " Cmd+Cmd",
        "Cmd+Cmd ",
        "Cmd +Cmd",
        "Cmd+ Cmd",
        "Cmd\n+Cmd",
        "CommandOrControl+CommandOrControl",
        "Meta+Meta",
    ] {
        assert_eq!(
            parse_main_binding(label).unwrap_err(),
            "SETTINGS_HOTKEY_REJECTED",
            "{label:?}"
        );
    }
    assert!(parse_main_binding(&format!("Alt+{}", "K".repeat(257))).is_err());
}
