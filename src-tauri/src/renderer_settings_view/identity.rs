pub(crate) fn is_valid_session_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && uuid::Uuid::parse_str(id)
            .is_ok_and(|uuid| uuid.get_version_num() == 4 && uuid.simple().to_string() == id)
}

pub(crate) fn is_expected_origin(origin: &str, id: &str) -> bool {
    is_valid_session_id(id) && origin == format!("atools-settings://{id}.localhost")
}

pub(crate) fn is_expected_settings_url(url: &tauri::Url, id: &str) -> bool {
    if !is_valid_session_id(id) {
        return false;
    }
    url.scheme() == "atools-settings"
        && url.host_str() == Some(format!("{id}.localhost").as_str())
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/index.html"
        && url.query().is_none()
        && is_allowed_settings_fragment(url.fragment())
}

fn is_allowed_settings_fragment(fragment: Option<&str>) -> bool {
    match fragment {
        Some("/generalSetting" | "/allCommands" | "/shortcuts" | "/localLaunch" | "/about") => true,
        Some(fragment) => {
            is_shortcuts_timestamp_fragment(fragment)
                || is_local_launch_timestamp_fragment(fragment)
        }
        None => false,
    }
}

pub(super) fn is_local_launch_settings_url(url: &tauri::Url, id: &str) -> bool {
    is_expected_settings_url(url, id)
        && url.fragment().is_some_and(|fragment| {
            fragment == "/localLaunch" || is_local_launch_timestamp_fragment(fragment)
        })
}

fn is_shortcuts_timestamp_fragment(fragment: &str) -> bool {
    is_timestamp_fragment(fragment, "/shortcuts?_t=")
}

fn is_local_launch_timestamp_fragment(fragment: &str) -> bool {
    is_timestamp_fragment(fragment, "/localLaunch?_t=")
}

fn is_timestamp_fragment(fragment: &str, prefix: &str) -> bool {
    let Some(timestamp) = fragment.strip_prefix(prefix) else {
        return false;
    };
    if !(1..=16).contains(&timestamp.len()) || !timestamp.bytes().all(|byte| byte.is_ascii_digit())
    {
        return false;
    }
    timestamp.parse::<u64>().is_ok_and(|value| {
        value > 0 && value <= 9_007_199_254_740_991 && value.to_string() == timestamp
    })
}

#[cfg(test)]
mod about_route_tests {
    use super::*;
    #[test]
    fn about_is_only_a_fragment_of_the_exact_owned_settings_document() {
        let id = "00000000000040008000000000000001";
        let base = format!("atools-settings://{id}.localhost/index.html");
        assert!(is_expected_settings_url(
            &tauri::Url::parse(&format!("{base}#/about")).unwrap(),
            id
        ));
        for suffix in [
            "#/About",
            "#/aboutSetting",
            "#/about?_t=1",
            "?debug=1#/about",
            "#/about/extra",
        ] {
            assert!(!is_expected_settings_url(
                &tauri::Url::parse(&format!("{base}{suffix}")).unwrap(),
                id
            ));
        }
        assert!(!is_expected_settings_url(
            &tauri::Url::parse("https://example.com/index.html#/about").unwrap(),
            id
        ));
    }
}
