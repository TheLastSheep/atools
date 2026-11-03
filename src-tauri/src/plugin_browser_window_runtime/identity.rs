use serde_json::Value;

pub(super) const MAX_PRIVATE_BYTES: usize = 256 * 1024;

pub(super) fn validate_window_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 96
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Invalid host BrowserWindow ID".into());
    }
    Ok(())
}

pub(super) fn is_private_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub(super) fn validate_private_size(value: &Value) -> Result<(), String> {
    let encoded =
        serde_json::to_vec(value).map_err(|_| "Invalid BrowserWindow private arguments")?;
    if encoded.len() > MAX_PRIVATE_BYTES {
        return Err("BrowserWindow private arguments exceed the limit".into());
    }
    Ok(())
}

pub(super) fn private_id() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

pub(super) fn unique_native_label() -> String {
    format!("atools-native-browser-{}", uuid::Uuid::new_v4().simple())
}

pub(super) fn may_control_window(
    source_active: bool,
    owner_matches: bool,
    window_alive: bool,
    creator_binding_id: &str,
    source_binding_id: &str,
    source_frame_id: &str,
    frontend_window_id: &str,
) -> bool {
    source_active
        && owner_matches
        && window_alive
        && (creator_binding_id == source_binding_id
            || source_frame_id == format!("child:{frontend_window_id}"))
}

#[cfg(test)]
mod tests {
    use super::may_control_window;

    #[test]
    fn native_window_control_is_creator_or_exact_self_frame_only() {
        let allowed = |active, owner, alive, creator, binding, frame| {
            may_control_window(active, owner, alive, creator, binding, frame, "window-42")
        };
        assert!(allowed(true, true, true, "source-a", "source-a", "main"));
        assert!(allowed(
            true,
            true,
            true,
            "source-a",
            "source-b",
            "child:window-42"
        ));
        assert!(!allowed(
            true,
            true,
            true,
            "source-a",
            "source-b",
            "child:sibling"
        ));
        assert!(!allowed(false, true, true, "source-a", "source-a", "main"));
        assert!(!allowed(true, false, true, "source-a", "source-a", "main"));
        assert!(!allowed(true, true, false, "source-a", "source-a", "main"));
    }
}
