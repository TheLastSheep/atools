#[cfg(target_os = "macos")]
use super::UNAVAILABLE;
use super::{transaction::ServiceStatus, UNSUPPORTED};

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
