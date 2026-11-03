use super::*;
pub fn open_or_reveal_path(arguments: Value) -> Result<Value, String> {
    let path = arguments
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "Missing path".to_string())?;
    let reveal = arguments
        .get("reveal")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        if reveal {
            command.arg("-R");
        }
        command.arg(path);
        let output = command
            .output()
            .map_err(|e| format!("Failed to run macOS open for {}: {}", path, e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let command_name = if reveal { "open -R" } else { "open" };
            return Err(format!(
                "{} failed for {}{}",
                command_name,
                path,
                if stderr.is_empty() {
                    format!(" with status {}", output.status)
                } else {
                    format!(": {}", stderr)
                }
            ));
        }
        Ok(json!({ "ok": true, "path": path, "reveal": reveal }))
    } else {
        Err(format!(
            "Unsupported platform for open_or_reveal_path: {}. This built-in tool currently supports macOS open/open -R only.",
            std::env::consts::OS
        ))
    }
}

pub(super) async fn guarded_app_open(
    arguments: Value,
    grant: crate::app_launch_fence::AppLaunchGrant,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        grant.check_catalog()?;
        let path = grant.path().to_owned();
        if !cfg!(target_os = "macos") {
            return Err("Unsupported platform for app launch".into());
        }
        let child = grant.spawn(|| {
            Command::new("open")
                .arg(&path)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to run macOS open for {path}: {e}"))
        })?;
        let output = child
            .wait_with_output()
            .map_err(|e| format!("Failed waiting for macOS open for {path}: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "open failed for {path}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let _ = arguments;
        Ok(json!({"ok": true, "path": path, "reveal": false}))
    })
    .await
    .map_err(|e| format!("App launch worker failed: {e}"))?
}

pub(super) fn open_url(app: &AppHandle, arguments: Value) -> Result<Value, String> {
    use tauri_plugin_opener::OpenerExt;

    let target = validated_open_url(&arguments)?;
    app.opener()
        .open_url(&target, None::<&str>)
        .map_err(|error| format!("Failed to open URL: {error}"))?;
    Ok(json!({ "ok": true, "url": target }))
}

pub(super) fn validated_open_url(arguments: &Value) -> Result<String, String> {
    let raw = arguments
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Missing URL".to_string())?;
    let parsed = url::Url::parse(raw).map_err(|error| format!("Invalid URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("URL must use http or https".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("URL must include a host".to_string());
    }
    Ok(parsed.to_string())
}

pub fn get_current_context() -> Result<Value, String> {
    let browser_url = read_browser_url();
    let foreground_app = read_foreground_app();
    let finder_path = read_finder_path();
    Ok(json!({
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "home": dirs::home_dir().map(|p| p.to_string_lossy().to_string()),
        "desktop": dirs::desktop_dir().map(|p| p.to_string_lossy().to_string()),
        "downloads": dirs::download_dir().map(|p| p.to_string_lossy().to_string()),
        "browser_url": browser_url.value,
        "browser_url_reason": browser_url.reason,
        "foreground_app": foreground_app.value,
        "foreground_app_reason": foreground_app.reason,
        "finder_path": finder_path.value,
        "finder_path_reason": finder_path.reason
    }))
}
