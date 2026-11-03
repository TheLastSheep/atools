pub(super) fn is_expected_child_probe_url(label: &str, url: &tauri::Url) -> bool {
    let Some(session_id) = label.strip_prefix("ztools-settings-") else {
        return false;
    };
    crate::renderer_settings_view::is_expected_settings_url(url, session_id)
}

#[cfg(test)]
mod tests {
    use super::is_expected_child_probe_url;
    use tauri::Url;

    const ID: &str = "00000000000040008000000000000001";
    const LABEL: &str = "ztools-settings-00000000000040008000000000000001";

    fn url(fragment: &str) -> Url {
        Url::parse(&format!(
            "atools-settings://{ID}.localhost/index.html#{fragment}"
        ))
        .unwrap()
    }

    #[test]
    fn accepts_the_production_routes_and_shortcuts_timestamp() {
        for route in ["/generalSetting", "/allCommands", "/shortcuts"] {
            assert!(is_expected_child_probe_url(LABEL, &url(route)));
        }
        assert!(is_expected_child_probe_url(
            LABEL,
            &url("/shortcuts?_t=1793229234123")
        ));
    }

    #[test]
    fn rejects_mismatched_identity_and_noncanonical_shortcuts_routes() {
        for (label, value) in [
            (
                "ztools-settings-00000000000040008000000000000002",
                url("/shortcuts?_t=123"),
            ),
            ("ztools-settings-not-a-session", url("/shortcuts")),
            ("other-child", url("/shortcuts")),
            (
                LABEL,
                Url::parse(&format!(
                    "atools-settings://wrong.localhost/index.html#/shortcuts"
                ))
                .unwrap(),
            ),
            (
                LABEL,
                Url::parse(&format!(
                    "atools-settings://{ID}.localhost/other.html#/shortcuts"
                ))
                .unwrap(),
            ),
            (
                LABEL,
                Url::parse(&format!(
                    "atools-settings://{ID}.localhost/index.html?debug=1#/shortcuts"
                ))
                .unwrap(),
            ),
            (LABEL, url("/shortcuts?_t=123&extra=1")),
            (LABEL, url("/shortcuts%3F_t=123")),
            (LABEL, url("/shortcuts?_t=0")),
            (LABEL, url("/shortcuts?_t=0123")),
        ] {
            assert!(!is_expected_child_probe_url(label, &value), "{value}");
        }
    }
}
