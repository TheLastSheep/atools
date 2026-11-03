use std::sync::OnceLock;

fn supports(platform: &str, version: Option<&str>) -> bool {
    match platform {
        "macos" => macos_major_version(version).is_some_and(|major| major >= 14),
        _ => false,
    }
}

fn macos_major_version(version: Option<&str>) -> Option<u32> {
    let version = version?;
    if version.is_empty()
        || version
            .split('.')
            .any(|component| component.is_empty() || !component.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    version.split('.').next()?.parse().ok()
}

pub(super) fn current_platform_supports() -> bool {
    static SUPPORTED: OnceLock<bool> = OnceLock::new();
    *SUPPORTED.get_or_init(detect_support)
}

#[cfg(target_os = "macos")]
fn detect_support() -> bool {
    supports("macos", macos_product_version().as_deref())
}

#[cfg(target_os = "windows")]
fn detect_support() -> bool {
    supports("windows", None)
}

#[cfg(target_os = "linux")]
fn detect_support() -> bool {
    supports("linux", None)
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn detect_support() -> bool {
    supports("other", None)
}

#[cfg(target_os = "macos")]
fn macos_product_version() -> Option<String> {
    const KEY: &[u8] = b"kern.osproductversion\0";
    let mut buffer = [0_u8; 64];
    let mut length = buffer.len();
    // SAFETY: KEY is NUL-terminated and buffer/length remain valid for the syscall.
    let result = unsafe {
        libc::sysctlbyname(
            KEY.as_ptr().cast(),
            buffer.as_mut_ptr().cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 || length == 0 || length > buffer.len() {
        return None;
    }
    let end = buffer[..length].iter().position(|byte| *byte == 0)?;
    std::str::from_utf8(&buffer[..end]).ok().map(String::from)
}

#[cfg(test)]
mod tests {
    use super::supports;

    #[test]
    fn macos_background_throttling_requires_version_14_or_newer() {
        assert!(!supports("macos", Some("13.6.7")));
        assert!(supports("macos", Some("14.0.0")));
        assert!(supports("macos", Some("26.1.0")));
        assert!(!supports("macos", None));
        assert!(!supports("macos", Some("unknown")));
        assert!(!supports("macos", Some("14.beta")));
    }

    #[test]
    fn background_throttling_is_rejected_on_unsupported_desktop_platforms() {
        for platform in ["windows", "linux", "other"] {
            assert!(!supports(platform, Some("26.0.0")));
        }
    }
}
