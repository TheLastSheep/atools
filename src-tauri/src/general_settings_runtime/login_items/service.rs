use super::{transaction::ServiceStatus, UNAVAILABLE, UNSUPPORTED};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[allow(dead_code)]
pub(super) const WINDOWS_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

/// Production SMAppService port shared by the ordinary toggle and durable
/// legacy migration host. The caller owns serialization around this adapter.
#[cfg(target_os = "macos")]
pub(super) struct MainAppService;

#[cfg(target_os = "macos")]
impl super::transaction::ServicePort for MainAppService {
    fn status(&mut self) -> Result<ServiceStatus, &'static str> {
        status()
    }

    fn set_enabled(&mut self, enabled: bool) -> Result<(), &'static str> {
        set_enabled(enabled)
    }
}

pub(super) struct SystemLoginItemsBackend<'a> {
    #[allow(dead_code)]
    identifier: &'a str,
}

impl<'a> SystemLoginItemsBackend<'a> {
    pub(super) fn new(identifier: &'a str) -> Self {
        Self { identifier }
    }
}

impl super::transaction::ServicePort for SystemLoginItemsBackend<'_> {
    fn status(&mut self) -> Result<ServiceStatus, &'static str> {
        #[cfg(target_os = "macos")]
        {
            status()
        }
        #[cfg(target_os = "linux")]
        {
            let config_dir = dirs::config_dir().ok_or(UNAVAILABLE)?;
            linux_status_in(&config_dir, self.identifier)
        }
        #[cfg(target_os = "windows")]
        {
            windows_status(self.identifier)
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        {
            Err(UNSUPPORTED)
        }
    }

    fn set_enabled(&mut self, enabled: bool) -> Result<(), &'static str> {
        #[cfg(target_os = "macos")]
        {
            set_enabled(enabled)
        }
        #[cfg(target_os = "linux")]
        {
            let config_dir = dirs::config_dir().ok_or(UNAVAILABLE)?;
            let exec_path = std::env::current_exe().map_err(|_| UNAVAILABLE)?;
            linux_set_enabled_in(&config_dir, self.identifier, &exec_path, enabled)
        }
        #[cfg(target_os = "windows")]
        {
            let exec_path = std::env::current_exe().map_err(|_| UNAVAILABLE)?;
            windows_set_enabled(self.identifier, &exec_path, enabled)
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        {
            let _ = enabled;
            Err(UNSUPPORTED)
        }
    }
}

#[allow(dead_code)]
pub(super) fn linux_autostart_desktop_path(config_dir: &Path, identifier: &str) -> PathBuf {
    config_dir
        .join("autostart")
        .join(format!("{identifier}.desktop"))
}

#[allow(dead_code)]
pub(super) fn render_linux_autostart_desktop(
    identifier: &str,
    exec_path: &Path,
    enabled: bool,
) -> String {
    let escaped_exec = exec_path.to_string_lossy().replace('"', "\\\"");
    let flag = if enabled { "true" } else { "false" };
    let hidden = if enabled { "false" } else { "true" };
    format!(
        "[Desktop Entry]\nType=Application\nName=ATools\nComment=ATools Desktop Launcher\nExec=\"{escaped_exec}\"\nTerminal=false\nX-GNOME-Autostart-enabled={flag}\nHidden={hidden}\nX-ATools-Identifier={identifier}\n"
    )
}

#[allow(dead_code)]
pub(super) fn parse_linux_autostart_enabled(content: &str) -> bool {
    let mut in_desktop_entry = false;
    let mut is_application = false;
    let mut has_exec = false;
    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            in_desktop_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_desktop_entry {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        if key == "Hidden" && value.eq_ignore_ascii_case("true") {
            return false;
        }
        if key == "X-GNOME-Autostart-enabled" && value.eq_ignore_ascii_case("false") {
            return false;
        }
        if key == "Type" && value == "Application" {
            is_application = true;
        }
        if key == "Exec" && !value.trim_matches('"').is_empty() {
            has_exec = true;
        }
    }
    is_application && has_exec
}

#[allow(dead_code)]
pub(super) fn linux_status_in(
    config_dir: &Path,
    identifier: &str,
) -> Result<ServiceStatus, &'static str> {
    let desktop_path = linux_autostart_desktop_path(config_dir, identifier);
    match fs::read_to_string(&desktop_path) {
        Ok(content) => Ok(if parse_linux_autostart_enabled(&content) {
            ServiceStatus::Enabled
        } else {
            ServiceStatus::NotRegistered
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(ServiceStatus::NotRegistered)
        }
        Err(_) => Err(UNAVAILABLE),
    }
}

#[allow(dead_code)]
pub(super) fn linux_set_enabled_in(
    config_dir: &Path,
    identifier: &str,
    exec_path: &Path,
    enabled: bool,
) -> Result<(), &'static str> {
    let desktop_path = linux_autostart_desktop_path(config_dir, identifier);
    if enabled {
        let parent = desktop_path.parent().ok_or(UNAVAILABLE)?;
        fs::create_dir_all(parent).map_err(|_| UNAVAILABLE)?;
        let content = render_linux_autostart_desktop(identifier, exec_path, true);
        fs::write(&desktop_path, content).map_err(|_| UNAVAILABLE)?;
        Ok(())
    } else {
        match fs::remove_file(&desktop_path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(UNAVAILABLE),
        }
    }
}

#[allow(dead_code)]
pub(super) fn build_windows_reg_query_args(identifier: &str) -> Vec<String> {
    vec![
        "query".to_owned(),
        WINDOWS_RUN_KEY.to_owned(),
        "/v".to_owned(),
        identifier.to_owned(),
    ]
}

#[allow(dead_code)]
pub(super) fn build_windows_reg_set_args(
    identifier: &str,
    exec_path: &Path,
    enabled: bool,
) -> Vec<String> {
    if enabled {
        vec![
            "add".to_owned(),
            WINDOWS_RUN_KEY.to_owned(),
            "/v".to_owned(),
            identifier.to_owned(),
            "/t".to_owned(),
            "REG_SZ".to_owned(),
            "/d".to_owned(),
            format!("\"{}\"", exec_path.to_string_lossy()),
            "/f".to_owned(),
        ]
    } else {
        vec![
            "delete".to_owned(),
            WINDOWS_RUN_KEY.to_owned(),
            "/v".to_owned(),
            identifier.to_owned(),
            "/f".to_owned(),
        ]
    }
}

#[allow(dead_code)]
pub(super) fn parse_windows_reg_query_output(
    exit_success: bool,
    stdout: &str,
    identifier: &str,
) -> ServiceStatus {
    if !exit_success {
        return ServiceStatus::NotRegistered;
    }
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with(identifier) {
            if let Some((_, value)) = trimmed.split_once("REG_SZ") {
                if !value.trim().trim_matches('"').is_empty() {
                    return ServiceStatus::Enabled;
                }
            }
        }
    }
    ServiceStatus::NotRegistered
}

#[cfg(target_os = "windows")]
fn windows_status(identifier: &str) -> Result<ServiceStatus, &'static str> {
    let args = build_windows_reg_query_args(identifier);
    let output = std::process::Command::new("reg.exe")
        .args(&args)
        .output()
        .map_err(|_| UNAVAILABLE)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_windows_reg_query_output(
        output.status.success(),
        &stdout,
        identifier,
    ))
}

#[cfg(target_os = "windows")]
fn windows_set_enabled(
    identifier: &str,
    exec_path: &Path,
    enabled: bool,
) -> Result<(), &'static str> {
    let args = build_windows_reg_set_args(identifier, exec_path, enabled);
    let output = std::process::Command::new("reg.exe")
        .args(&args)
        .output()
        .map_err(|_| UNAVAILABLE)?;
    if output.status.success() || !enabled {
        Ok(())
    } else {
        Err(UNAVAILABLE)
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{ServiceStatus, UNAVAILABLE, UNSUPPORTED};
    use objc2::{
        msg_send,
        rc::autoreleasepool,
        runtime::{AnyClass, AnyObject, Bool},
        sel,
    };
    use std::{
        ffi::{c_void, CStr},
        ptr,
    };

    #[link(name = "ServiceManagement", kind = "framework")]
    extern "C" {
        static kSMDomainUserLaunchd: *const c_void;
    }

    pub(in crate::general_settings_runtime::login_items) fn current_bundle_identifier_matches(
        expected: &str,
    ) -> bool {
        if expected.is_empty() || expected.len() > 256 {
            return false;
        }
        autoreleasepool(|_| unsafe {
            let Some(bundle_class) = AnyClass::get(cstr(b"NSBundle\0")) else {
                return false;
            };
            let main_bundle_selector = sel!(mainBundle);
            let bundle_identifier_selector = sel!(bundleIdentifier);
            let utf8_selector = sel!(UTF8String);
            if bundle_class.class_method(main_bundle_selector).is_none() {
                return false;
            }
            let bundle: *mut AnyObject = msg_send![bundle_class, mainBundle];
            if bundle.is_null() {
                return false;
            }
            let bundle = &*bundle;
            if !bundle.class().responds_to(bundle_identifier_selector) {
                return false;
            }
            let identifier: *mut AnyObject = msg_send![bundle, bundleIdentifier];
            if identifier.is_null() {
                return false;
            }
            let identifier = &*identifier;
            if !identifier.class().responds_to(utf8_selector) {
                return false;
            }
            let utf8: *const std::ffi::c_char = msg_send![identifier, UTF8String];
            if utf8.is_null() {
                return false;
            }
            let expected = expected.as_bytes();
            for index in 0..=256 {
                let byte = *utf8.add(index) as u8;
                if byte == 0 {
                    return &expected[..] == std::slice::from_raw_parts(utf8.cast::<u8>(), index);
                }
                if index == expected.len() || index == 256 {
                    return false;
                }
            }
            false
        })
    }

    pub(in crate::general_settings_runtime::login_items) fn status(
    ) -> Result<ServiceStatus, &'static str> {
        autoreleasepool(|_| unsafe {
            let service = main_app_service()?;
            let raw: isize = msg_send![&*service, status];
            Ok(match raw {
                0 => ServiceStatus::NotRegistered,
                1 => ServiceStatus::Enabled,
                2 => ServiceStatus::RequiresApproval,
                3 => ServiceStatus::NotFound,
                value => ServiceStatus::Unknown(value),
            })
        })
    }

    pub(in crate::general_settings_runtime::login_items) fn set_enabled(
        enabled: bool,
    ) -> Result<(), &'static str> {
        autoreleasepool(|_| unsafe {
            let service = main_app_service()?;
            let success: Bool = if enabled {
                msg_send![&*service, registerAndReturnError: ptr::null_mut::<*mut AnyObject>()]
            } else {
                msg_send![&*service, unregisterAndReturnError: ptr::null_mut::<*mut AnyObject>()]
            };
            if success.as_bool() {
                Ok(())
            } else {
                Err(UNAVAILABLE)
            }
        })
    }

    unsafe fn main_app_service() -> Result<*mut AnyObject, &'static str> {
        // Keep the framework linked while resolving the class dynamically so
        // older macOS releases can fail closed instead of failing to launch.
        let _framework_anchor = unsafe { ptr::read_volatile(&kSMDomainUserLaunchd) };
        let Some(class) = AnyClass::get(cstr(b"SMAppService\0")) else {
            return Err(UNSUPPORTED);
        };
        let main_service = sel!(mainAppService);
        let status = sel!(status);
        let register = sel!(registerAndReturnError:);
        let unregister = sel!(unregisterAndReturnError:);
        if class.class_method(main_service).is_none()
            || class.instance_method(status).is_none()
            || class.instance_method(register).is_none()
            || class.instance_method(unregister).is_none()
        {
            return Err(UNSUPPORTED);
        }
        let service: *mut AnyObject = msg_send![class, mainAppService];
        if service.is_null() {
            Err(UNAVAILABLE)
        } else {
            Ok(service)
        }
    }

    fn cstr(value: &'static [u8]) -> &'static CStr {
        CStr::from_bytes_with_nul(value).expect("static Objective-C class name")
    }
}

#[cfg(target_os = "macos")]
pub(super) use macos::{current_bundle_identifier_matches, set_enabled, status};

#[cfg(not(target_os = "macos"))]
pub(super) fn status() -> Result<ServiceStatus, &'static str> {
    Err(UNSUPPORTED)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn set_enabled(_enabled: bool) -> Result<(), &'static str> {
    Err(UNSUPPORTED)
}
