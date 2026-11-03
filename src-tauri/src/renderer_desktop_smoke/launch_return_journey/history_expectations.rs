use crate::renderer_desktop_smoke::profile::LaunchTargetKind;
use serde_json::Value;

pub(super) fn history_matches(
    history: Option<&Value>,
    target_kind: LaunchTargetKind,
    items: u64,
    first_use: u64,
    second_use: u64,
) -> bool {
    let (app_items, local_items) = match target_kind {
        LaunchTargetKind::App => (items, 0),
        LaunchTargetKind::LocalShortcut => (0, items),
    };
    counter(history, "items") == Some(items)
        && counter(history, "firstUseCount") == Some(first_use)
        && counter(history, "secondUseCount") == Some(second_use)
        && counter(history, "appItems") == Some(app_items)
        && counter(history, "localShortcutItems") == Some(local_items)
}

fn counter(value: Option<&Value>, key: &str) -> Option<u64> {
    value?.get(key)?.as_u64()
}

#[cfg(test)]
mod tests {
    use super::history_matches;
    use crate::renderer_desktop_smoke::profile::LaunchTargetKind;
    use serde_json::json;

    #[test]
    fn history_counts_must_match_the_selected_target_kind() {
        let app_history = json!({
            "items": 2,
            "firstUseCount": 1,
            "secondUseCount": 1,
            "appItems": 2,
            "localShortcutItems": 0
        });
        let local_history = json!({
            "items": 2,
            "firstUseCount": 1,
            "secondUseCount": 1,
            "appItems": 0,
            "localShortcutItems": 2
        });

        assert!(history_matches(
            Some(&app_history),
            LaunchTargetKind::App,
            2,
            1,
            1
        ));
        assert!(history_matches(
            Some(&local_history),
            LaunchTargetKind::LocalShortcut,
            2,
            1,
            1
        ));
        assert!(!history_matches(
            Some(&local_history),
            LaunchTargetKind::App,
            2,
            1,
            1
        ));
    }
}
