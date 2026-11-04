const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(super) fn trusted_host_window(label: &str) -> Result<(), String> {
    if matches!(label, "main" | "plugin-detach") {
        Ok(())
    } else {
        Err("Plugin window source is unavailable to this window".into())
    }
}

pub(super) fn validate_generation(generation: u64) -> Result<(), String> {
    if generation == 0 || generation > MAX_SAFE_INTEGER {
        Err("Invalid plugin frame generation".into())
    } else {
        Ok(())
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn validate_nonce(nonce: &str) -> Result<(), String> {
    if nonce.len() == 32
        && nonce
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err("Invalid plugin document nonce".into())
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn validate_frame_id(frame_id: &str) -> Result<(), String> {
    if frame_id == "main" {
        return Ok(());
    }
    let Some(id) = frame_id.strip_prefix("child:") else {
        return Err("Invalid plugin frame identity".into());
    };
    if id.is_empty()
        || id.len() > 128
        || id == "."
        || id == ".."
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("Invalid plugin frame identity".into());
    }
    Ok(())
}

pub(super) fn validate_source_binding_id(id: &str) -> Result<(), String> {
    if id.len() == 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err("Invalid plugin window source id".into())
    }
}

pub(super) fn validate_renderer_label(renderer: &str) -> Result<(), String> {
    if !renderer.is_empty()
        && renderer.len() <= 256
        && renderer.trim() == renderer
        && !renderer.chars().any(char::is_control)
    {
        Ok(())
    } else {
        Err("Invalid native plugin renderer label".into())
    }
}
