use super::{contract, delegate::NavigationObserverDelegate, Observer};
use objc2::{
    rc::{Retained, Weak},
    runtime::ProtocolObject,
};
use objc2_foundation::MainThreadMarker;
use objc2_web_kit::{WKNavigationDelegate, WKWebView};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager, WebviewWindow, WindowEvent};
use tokio::sync::oneshot;

const INSTALL_DEADLINE: Duration = Duration::from_secs(5);
const INSTALL_FAILED: &str = "Native navigation observer installation failed";
const INSTALL_CANCELLED: &str = "Native navigation observer installation cancelled";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Token {
    native_instance: usize,
    generation: u64,
}
#[derive(Clone, Copy)]
struct Ticket {
    token: Token,
    demand: u64,
}

#[derive(Default)]
struct Demands {
    pending: HashSet<u64>,
    permanent: bool,
}
impl Demands {
    fn promote(&mut self, demand: u64) {
        if self.pending.remove(&demand) {
            self.permanent = true;
        }
    }
    fn release(&mut self, demand: u64) -> bool {
        self.pending.remove(&demand) && self.pending.is_empty() && !self.permanent
    }
}

struct Installation {
    token: Token,
    view: Weak<WKWebView>,
    delegate: Option<Retained<NavigationObserverDelegate>>,
    demands: Demands,
}
#[derive(Default)]
struct Installations {
    next_generation: u64,
    by_instance: HashMap<usize, Installation>,
}

// WKWebView.navigationDelegate is weak. Strong Objective-C ownership never
// leaves this main-thread store; no Objective-C object is made Send or Sync.
thread_local! { static INSTALLATIONS: RefCell<Installations> = RefCell::default(); }

#[derive(Default)]
struct AttemptState {
    cancelled: bool,
    ticket: Option<Ticket>,
}
struct AttemptGuard {
    app: AppHandle,
    state: Arc<Mutex<AttemptState>>,
    armed: bool,
}
impl Drop for AttemptGuard {
    fn drop(&mut self) {
        if self.armed {
            cancel(&self.app, &self.state);
        }
    }
}

pub(super) async fn ensure(window: &WebviewWindow, observer: Observer) -> Result<(), String> {
    let state = Arc::new(Mutex::new(AttemptState::default()));
    let mut guard = AttemptGuard {
        app: window.app_handle().clone(),
        state: state.clone(),
        armed: true,
    };
    let install_window = window.clone();
    let (sender, receiver) = oneshot::channel();
    window
        .with_webview(move |platform| {
            let result = {
                let mut attempt = state.lock().unwrap_or_else(|error| error.into_inner());
                if attempt.cancelled || sender.is_closed() {
                    Err(INSTALL_CANCELLED.into())
                } else {
                    install(&install_window, platform.inner(), observer).map(|ticket| {
                        attempt.ticket = Some(ticket);
                    })
                }
            };
            if sender.send(result).is_err() {
                cancel(install_window.app_handle(), &state);
            }
        })
        .map_err(|_| INSTALL_FAILED)?;

    match tokio::time::timeout(INSTALL_DEADLINE, receiver).await {
        Ok(Ok(Ok(()))) => {
            let ticket = guard
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .ticket
                .ok_or(INSTALL_FAILED)?;
            // There is no await between accepting installation and disarming
            // this attempt. Other attempts retain independent pending tickets.
            on_main(&guard.app, move |mtm| promote(ticket, mtm))?;
            guard.armed = false;
            Ok(())
        }
        Ok(Ok(Err(error))) => Err(error),
        Ok(Err(_)) => Err(INSTALL_FAILED.into()),
        Err(_) => Err("Native navigation observer installation timed out".into()),
    }
}

fn cancel(app: &AppHandle, state: &Mutex<AttemptState>) {
    let ticket = {
        let mut attempt = state.lock().unwrap_or_else(|error| error.into_inner());
        attempt.cancelled = true;
        attempt.ticket.take()
    };
    if let Some(ticket) = ticket {
        // Failure means the event loop has exited; TLS then owns final teardown.
        let _ = on_main(app, move |mtm| release(ticket, mtm));
    }
}

fn on_main(
    app: &AppHandle,
    action: impl FnOnce(MainThreadMarker) + Send + 'static,
) -> Result<(), String> {
    if let Some(mtm) = MainThreadMarker::new() {
        action(mtm);
        Ok(())
    } else {
        app.run_on_main_thread(move || {
            if let Some(mtm) = MainThreadMarker::new() {
                action(mtm);
            }
        })
        .map_err(|_| INSTALL_FAILED.into())
    }
}

fn install(
    window: &WebviewWindow,
    native_view: *mut std::ffi::c_void,
    observer: Observer,
) -> Result<Ticket, String> {
    let mtm = MainThreadMarker::new().ok_or(INSTALL_FAILED)?;
    // SAFETY: Tauri exposes its live WKWebView inside this main-thread callback.
    // No raw view/frame pointer is retained as frame identity.
    let view = unsafe { native_view.cast::<WKWebView>().as_ref() }.ok_or(INSTALL_FAILED)?;
    let instance = native_view as usize;
    INSTALLATIONS.with(|store| {
        let mut store = store.borrow_mut();
        let demand = store.next_generation.checked_add(1).ok_or(INSTALL_FAILED)?;
        store.next_generation = demand;
        if store
            .by_instance
            .get(&instance)
            .is_some_and(|entry| entry.view.load().is_none())
        {
            store.by_instance.remove(&instance);
        }
        if let Some(existing) = store.by_instance.get_mut(&instance) {
            if let Some(delegate) = &existing.delegate {
                if !is_current(view, delegate) {
                    return Err("Native navigation observer delegate was replaced".into());
                }
            } else {
                existing.delegate = Some(install_delegate(view, observer, mtm)?);
            }
            existing.demands.pending.insert(demand);
            return Ok(Ticket {
                token: existing.token,
                demand,
            });
        }
        let delegate = install_delegate(view, observer, mtm)?;
        let token = Token {
            native_instance: instance,
            generation: demand,
        };
        let mut demands = Demands::default();
        demands.pending.insert(demand);
        store.by_instance.insert(
            instance,
            Installation {
                token,
                view: Weak::new(view),
                delegate: Some(delegate),
                demands,
            },
        );
        let app = window.app_handle().clone();
        // One destruction listener per native instance, including retries after
        // cancellation. A delegate-free tombstone remains until destruction.
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::Destroyed) {
                let _ = on_main(&app, move |mtm| destroy(token, mtm));
            }
        });
        Ok(Ticket { token, demand })
    })
}

fn install_delegate(
    view: &WKWebView,
    observer: Observer,
    mtm: MainThreadMarker,
) -> Result<Retained<NavigationObserverDelegate>, String> {
    // SAFETY: Main-thread getters return a retained original delegate.
    let original = unsafe { view.navigationDelegate() }.ok_or(INSTALL_FAILED)?;
    contract::validate_original(&original)?;
    let delegate = NavigationObserverDelegate::new(original, observer, mtm);
    // SAFETY: Local and TLS strong owners outlive this weak-property assignment.
    unsafe { view.setNavigationDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
    if !is_current(view, &delegate) {
        return Err(INSTALL_FAILED.into());
    }
    Ok(delegate)
}

fn is_current(view: &WKWebView, delegate: &NavigationObserverDelegate) -> bool {
    // SAFETY: All callers have a MainThreadMarker or are inside installation.
    unsafe { view.navigationDelegate() }.is_some_and(|current| {
        let expected = ProtocolObject::<dyn WKNavigationDelegate>::from_ref(delegate);
        std::ptr::eq::<ProtocolObject<dyn WKNavigationDelegate>>(&*current, expected)
    })
}

fn promote(ticket: Ticket, _mtm: MainThreadMarker) {
    INSTALLATIONS.with(|store| {
        if let Some(entry) = store
            .borrow_mut()
            .by_instance
            .get_mut(&ticket.token.native_instance)
        {
            if entry.token == ticket.token {
                entry.demands.promote(ticket.demand);
            }
        }
    });
}
fn release(ticket: Ticket, mtm: MainThreadMarker) {
    let removed = INSTALLATIONS.with(|store| {
        let mut store = store.borrow_mut();
        let entry = store.by_instance.get_mut(&ticket.token.native_instance)?;
        if entry.token != ticket.token || !entry.demands.release(ticket.demand) {
            return None;
        }
        Some((entry.view.clone(), entry.delegate.take()?))
    });
    if let Some((view, delegate)) = removed {
        restore(view, delegate, mtm);
    }
}
fn destroy(token: Token, mtm: MainThreadMarker) {
    let entry = INSTALLATIONS.with(|store| {
        let mut store = store.borrow_mut();
        if store.by_instance.get(&token.native_instance)?.token != token {
            return None;
        }
        store.by_instance.remove(&token.native_instance)
    });
    if let Some(entry) = entry {
        if let Some(delegate) = entry.delegate {
            restore(entry.view, delegate, mtm);
        }
    }
}
fn restore(
    view: Weak<WKWebView>,
    delegate: Retained<NavigationObserverDelegate>,
    _mtm: MainThreadMarker,
) {
    if let Some(view) = view.load() {
        if is_current(&view, &delegate) {
            // SAFETY: Restore only our current proxy before releasing its owner;
            // another native delegate's replacement is left untouched.
            unsafe { view.setNavigationDelegate(Some(delegate.original())) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Demands;
    #[test]
    fn cancelled_creator_cannot_remove_another_pending_or_successful_ensure() {
        let mut demands = Demands::default();
        demands.pending.extend([1, 2]);
        assert!(!demands.release(1));
        demands.promote(2);
        assert!(!demands.release(2));
        demands.pending.insert(3);
        assert!(!demands.release(3));
    }
    #[test]
    fn all_cancelled_attempts_request_cleanup_exactly_once() {
        let mut demands = Demands::default();
        demands.pending.extend([1, 2]);
        assert!(!demands.release(2));
        assert!(demands.release(1));
        assert!(!demands.release(1));
        demands.pending.insert(3);
        assert!(!demands.release(2));
        assert!(demands.release(3));
    }
}
