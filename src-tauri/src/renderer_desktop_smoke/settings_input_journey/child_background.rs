use tauri::{Webview, Wry};

const BACKGROUND_MACOS_ONLY: &str = "settings-input-background-requires-macos";

#[cfg(target_os = "macos")]
const BACKGROUND_DEADLINE: std::time::Duration = std::time::Duration::from_secs(2);
#[cfg(target_os = "macos")]
const BACKGROUND_DISPATCH_FAILED: &str = "settings-input-background-dispatch-failed";
#[cfg(target_os = "macos")]
const BACKGROUND_TIMEOUT: &str = "settings-input-background-timeout";
#[cfg(target_os = "macos")]
const BACKGROUND_CALLBACK_INTERRUPTED: &str = "settings-input-background-callback-interrupted";
#[cfg(target_os = "macos")]
const BACKGROUND_MAIN_THREAD_UNAVAILABLE: &str =
    "settings-input-background-main-thread-unavailable";
#[cfg(target_os = "macos")]
const BACKGROUND_WEBVIEW_UNAVAILABLE: &str = "settings-input-background-webview-unavailable";
#[cfg(target_os = "macos")]
const BACKGROUND_VALUE_MISSING: &str = "settings-input-background-value-missing";
#[cfg(target_os = "macos")]
const BACKGROUND_VALUE_TYPE_INVALID: &str = "settings-input-background-value-type-invalid";
#[cfg(target_os = "macos")]
const BACKGROUND_POLICY_DEADLINE: std::time::Duration = std::time::Duration::from_secs(2);
#[cfg(target_os = "macos")]
const BACKGROUND_POLICY_DISPATCH_FAILED: &str = "settings-input-background-policy-dispatch-failed";
#[cfg(target_os = "macos")]
const BACKGROUND_POLICY_TIMEOUT: &str = "settings-input-background-policy-timeout";
#[cfg(target_os = "macos")]
const BACKGROUND_POLICY_CALLBACK_INTERRUPTED: &str =
    "settings-input-background-policy-callback-interrupted";
#[cfg(target_os = "macos")]
const BACKGROUND_POLICY_MAIN_THREAD_UNAVAILABLE: &str =
    "settings-input-background-policy-main-thread-unavailable";
#[cfg(target_os = "macos")]
const BACKGROUND_POLICY_WEBVIEW_UNAVAILABLE: &str =
    "settings-input-background-policy-webview-unavailable";
#[cfg(target_os = "macos")]
const BACKGROUND_POLICY_VALUE_MISSING: &str = "settings-input-background-policy-value-missing";
#[cfg(target_os = "macos")]
const BACKGROUND_POLICY_VALUE_TYPE_INVALID: &str =
    "settings-input-background-policy-value-type-invalid";
#[cfg(target_os = "macos")]
const BACKGROUND_POLICY_VALUE_INVALID: &str = "settings-input-background-policy-value-invalid";

#[cfg(target_os = "macos")]
type NativeResult<T> = Result<T, &'static str>;
#[cfg(target_os = "macos")]
type BackgroundResult = NativeResult<bool>;
#[cfg(target_os = "macos")]
type PendingNative<T> =
    std::sync::Arc<parking_lot::Mutex<Option<tokio::sync::oneshot::Sender<NativeResult<T>>>>>;
#[cfg(target_os = "macos")]
type PendingBackground = PendingNative<bool>;

pub(super) async fn draws_background(child: &Webview<Wry>) -> Result<bool, &'static str> {
    #[cfg(target_os = "macos")]
    {
        draws_background_macos(child).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = child;
        Err(BACKGROUND_MACOS_ONLY)
    }
}

pub(super) async fn inactive_scheduling_policy(
    child: &Webview<Wry>,
) -> Result<&'static str, &'static str> {
    #[cfg(target_os = "macos")]
    {
        inactive_scheduling_policy_macos(child).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = child;
        Ok("unsupported")
    }
}

#[cfg(target_os = "macos")]
async fn draws_background_macos(child: &Webview<Wry>) -> BackgroundResult {
    use std::sync::Arc;

    let (sender, receiver) = tokio::sync::oneshot::channel();
    let pending = Arc::new(parking_lot::Mutex::new(Some(sender)));
    let scheduled_pending = Arc::clone(&pending);

    tokio::time::timeout(BACKGROUND_DEADLINE, async {
        child
            .with_webview(move |platform| {
                use objc2::runtime::AnyObject;
                use objc2::MainThreadMarker;
                use objc2_foundation::{ns_string, NSNumber, NSObjectNSKeyValueCoding};
                use objc2_web_kit::WKWebView;

                if !has_open_receiver(&scheduled_pending) {
                    return;
                }
                let Some(_main_thread) = MainThreadMarker::new() else {
                    reject_pending(&scheduled_pending, BACKGROUND_MAIN_THREAD_UNAVAILABLE);
                    return;
                };
                let pointer = platform.inner();
                if pointer.is_null() {
                    reject_pending(&scheduled_pending, BACKGROUND_WEBVIEW_UNAVAILABLE);
                    return;
                }

                // Tauri lends this WKWebView only for the duration of this callback.
                let native = unsafe { &*pointer.cast::<WKWebView>() };
                let configuration = unsafe { native.configuration() };
                let value: Option<objc2::rc::Retained<AnyObject>> =
                    configuration.valueForKey(ns_string!("drawsBackground"));
                let result = match value {
                    None => Err(BACKGROUND_VALUE_MISSING),
                    Some(value) => match value.downcast_ref::<NSNumber>() {
                        Some(number) => Ok(number.boolValue()),
                        None => Err(BACKGROUND_VALUE_TYPE_INVALID),
                    },
                };
                deliver(&scheduled_pending, result);
            })
            .map_err(|_| BACKGROUND_DISPATCH_FAILED)?;

        receiver
            .await
            .map_err(|_| BACKGROUND_CALLBACK_INTERRUPTED)?
    })
    .await
    .map_err(|_| BACKGROUND_TIMEOUT)?
}

#[cfg(target_os = "macos")]
async fn inactive_scheduling_policy_macos(child: &Webview<Wry>) -> NativeResult<&'static str> {
    use std::sync::Arc;

    let (sender, receiver) = tokio::sync::oneshot::channel();
    let pending: PendingNative<&'static str> = Arc::new(parking_lot::Mutex::new(Some(sender)));
    let scheduled_pending = Arc::clone(&pending);

    tokio::time::timeout(BACKGROUND_POLICY_DEADLINE, async {
        child
            .with_webview(move |platform| {
                use objc2::runtime::AnyObject;
                use objc2::MainThreadMarker;
                use objc2_foundation::{
                    ns_string, NSNumber, NSObjectNSKeyValueCoding, NSProcessInfo,
                };
                use objc2_web_kit::{WKInactiveSchedulingPolicy, WKWebView};

                if !has_open_receiver(&scheduled_pending) {
                    return;
                }
                let Some(_main_thread) = MainThreadMarker::new() else {
                    reject_pending(
                        &scheduled_pending,
                        BACKGROUND_POLICY_MAIN_THREAD_UNAVAILABLE,
                    );
                    return;
                };
                if NSProcessInfo::processInfo()
                    .operatingSystemVersion()
                    .majorVersion
                    < 14
                {
                    deliver(&scheduled_pending, Ok("unsupported"));
                    return;
                }

                let pointer = platform.inner();
                if pointer.is_null() {
                    reject_pending(&scheduled_pending, BACKGROUND_POLICY_WEBVIEW_UNAVAILABLE);
                    return;
                }

                // Tauri lends this WKWebView only for the duration of this callback.
                let native = unsafe { &*pointer.cast::<WKWebView>() };
                let configuration = unsafe { native.configuration() };
                let preferences = unsafe { configuration.preferences() };
                let value: Option<objc2::rc::Retained<AnyObject>> =
                    preferences.valueForKey(ns_string!("inactiveSchedulingPolicy"));
                let result = match value {
                    None => Err(BACKGROUND_POLICY_VALUE_MISSING),
                    Some(value) => match value.downcast_ref::<NSNumber>() {
                        None => Err(BACKGROUND_POLICY_VALUE_TYPE_INVALID),
                        Some(number) => match number.integerValue() {
                            value if value == WKInactiveSchedulingPolicy::None.0 => Ok("none"),
                            value if value == WKInactiveSchedulingPolicy::Suspend.0 => {
                                Ok("suspend")
                            }
                            value if value == WKInactiveSchedulingPolicy::Throttle.0 => {
                                Ok("throttle")
                            }
                            _ => Err(BACKGROUND_POLICY_VALUE_INVALID),
                        },
                    },
                };
                deliver(&scheduled_pending, result);
            })
            .map_err(|_| BACKGROUND_POLICY_DISPATCH_FAILED)?;

        receiver
            .await
            .map_err(|_| BACKGROUND_POLICY_CALLBACK_INTERRUPTED)?
    })
    .await
    .map_err(|_| BACKGROUND_POLICY_TIMEOUT)?
}

#[cfg(target_os = "macos")]
fn has_open_receiver<T>(pending: &PendingNative<T>) -> bool {
    pending
        .lock()
        .as_ref()
        .is_some_and(|sender| !sender.is_closed())
}

#[cfg(target_os = "macos")]
fn reject_pending<T>(pending: &PendingNative<T>, error: &'static str) {
    deliver(pending, Err(error));
}

#[cfg(target_os = "macos")]
fn deliver<T>(pending: &PendingNative<T>, result: NativeResult<T>) {
    if let Some(sender) = pending.lock().take() {
        let _ = sender.send(result);
    }
}
