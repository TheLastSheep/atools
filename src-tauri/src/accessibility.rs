#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccessibilityPermissionStatus {
    pub supported: bool,
    pub trusted: bool,
    pub settings_url: Option<String>,
}

const MACOS_ACCESSIBILITY_SETTINGS_URL: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
}

#[cfg(target_os = "macos")]
fn accessibility_trusted() -> bool {
    // SAFETY: AXIsProcessTrusted takes no arguments and returns a CoreServices Boolean.
    unsafe { AXIsProcessTrusted() != 0 }
}

#[cfg(not(target_os = "macos"))]
fn accessibility_trusted() -> bool {
    true
}

#[tauri::command]
pub fn get_accessibility_permission_status() -> AccessibilityPermissionStatus {
    AccessibilityPermissionStatus {
        supported: cfg!(target_os = "macos"),
        trusted: accessibility_trusted(),
        settings_url: cfg!(target_os = "macos")
            .then(|| MACOS_ACCESSIBILITY_SETTINGS_URL.to_string()),
    }
}

#[tauri::command]
pub fn open_accessibility_settings() -> Result<AccessibilityPermissionStatus, String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(MACOS_ACCESSIBILITY_SETTINGS_URL)
            .spawn()
            .map_err(|error| format!("无法打开辅助功能设置：{error}"))?;
    }
    Ok(get_accessibility_permission_status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accessibility_status_matches_platform_contract() {
        let status = get_accessibility_permission_status();
        if cfg!(target_os = "macos") {
            assert!(status.supported);
            assert_eq!(
                status.settings_url.as_deref(),
                Some(MACOS_ACCESSIBILITY_SETTINGS_URL)
            );
        } else {
            assert!(!status.supported);
            assert!(status.trusted);
            assert!(status.settings_url.is_none());
        }
    }
}
