use super::super::{operations, state::Harness};
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyClass, NSObjectProtocol},
    ClassType, MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSModalPanelWindowLevel,
    NSPanel, NSResponder, NSView, NSWindow, NSWindowOcclusionState, NSWindowStyleMask, NSWorkspace,
};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use serde::Serialize;
use serde_json::Value;
use std::cell::RefCell;
use tauri::{AppHandle, Wry};

const BEFORE_UNAVAILABLE: &str = "main-panel-constructor-probe-before-unavailable";
const CREATE_FAILED: &str = "main-panel-constructor-probe-create-failed";
const SHOW_FAILED: &str = "main-panel-constructor-probe-show-failed";
const AFTER_UNAVAILABLE: &str = "main-panel-constructor-probe-after-unavailable";

define_class!(
    #[unsafe(super(NSPanel))]
    #[thread_kind = MainThreadOnly]
    #[name = "AToolsInitializedPanelProbe"]
    #[ivars = ()]
    pub struct AToolsInitializedPanelProbe;

    unsafe impl NSObjectProtocol for AToolsInitializedPanelProbe {}

    impl AToolsInitializedPanelProbe {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key_window(&self) -> bool {
            true
        }

        #[unsafe(method(canBecomeMainWindow))]
        fn can_become_main_window(&self) -> bool {
            false
        }
    }
);

define_class!(
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[name = "AToolsConstructorProbeFocusView"]
    #[ivars = ()]
    struct ConstructorProbeFocusView;

    unsafe impl NSObjectProtocol for ConstructorProbeFocusView {}

    impl ConstructorProbeFocusView {
        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> bool {
            true
        }
    }
);

impl AToolsInitializedPanelProbe {
    fn new(frame: NSRect, mtm: MainThreadMarker) -> Retained<Self> {
        let allocated = mtm.alloc::<Self>().set_ivars(());
        let style = NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel;
        // SAFETY: This initializes the freshly allocated subclass through NSPanel's designated
        // initializer while AppKit's main thread is current.
        unsafe {
            msg_send![super(allocated),
                initWithContentRect: frame,
                styleMask: style,
                backing: NSBackingStoreType::Buffered,
                defer: false]
        }
    }
}

impl ConstructorProbeFocusView {
    fn new(size: NSSize, mtm: MainThreadMarker) -> Retained<Self> {
        let allocated = mtm.alloc::<Self>().set_ivars(());
        let frame = NSRect::new(NSPoint::new(0.0, 0.0), size);
        // SAFETY: The new responder view is initialized on AppKit's main thread.
        unsafe { msg_send![super(allocated), initWithFrame: frame] }
    }
}

struct OwnedPanel {
    panel: Retained<AToolsInitializedPanelProbe>,
    focus_view: Retained<ConstructorProbeFocusView>,
    main_frame: NSRect,
    run_id: String,
}

thread_local! {
    static PANEL_OWNER: RefCell<Option<OwnedPanel>> = const { RefCell::new(None) };
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AppObservation {
    app_active: Option<bool>,
    app_hidden: Option<bool>,
    pub(super) activation_policy_regular: Option<bool>,
    frontmost_is_self: Option<bool>,
    frontmost_matches_baseline: Option<bool>,
    main_window_visible: Option<bool>,
    main_window_key: Option<bool>,
    app_activation_events: Option<u64>,
    main_key_events: Option<u64>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PanelObservation {
    class_name: Option<String>,
    is_panel: Option<bool>,
    style_mask_bits: Option<u64>,
    borderless_style: Option<bool>,
    nonactivating_style: Option<bool>,
    level: Option<i64>,
    floating: Option<bool>,
    hides_on_deactivate: Option<bool>,
    becomes_key_only_if_needed: Option<bool>,
    released_when_closed: Option<bool>,
    frame_matches_main: Option<bool>,
    visible: Option<bool>,
    key: Option<bool>,
    on_active_space: Option<bool>,
    occlusion_visible: Option<bool>,
    focus_view_found: Option<bool>,
    focus_view_is_first_responder: Option<bool>,
    app_active: Option<bool>,
    app_hidden: Option<bool>,
    pub(super) activation_policy_regular: Option<bool>,
    frontmost_is_self: Option<bool>,
    frontmost_matches_baseline: Option<bool>,
    main_window_visible: Option<bool>,
    main_window_key: Option<bool>,
    app_activation_events: Option<u64>,
    app_activation_event_delta: Option<u64>,
    main_key_events: Option<u64>,
    main_key_event_delta: Option<u64>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CleanupObservation {
    pub(super) panel_created: Option<bool>,
    pub(super) order_out_confirmed: Option<bool>,
    pub(super) close_requested: Option<bool>,
    pub(super) owner_cleared: Option<bool>,
    pub(super) native_operations_terminal: bool,
}

impl CleanupObservation {
    pub(super) fn safe(&self) -> bool {
        self.native_operations_terminal
            && self.owner_cleared == Some(true)
            && match self.panel_created {
                Some(false) => true,
                Some(true) => {
                    self.order_out_confirmed == Some(true) && self.close_requested == Some(true)
                }
                None => false,
            }
    }
}

pub(super) async fn capture_before(
    app: &AppHandle<Wry>,
    harness: &Harness,
) -> Result<AppObservation, &'static str> {
    let native = operations::capture_window(app, &harness.0.operations).await?;
    let activation_policy_regular = capture_activation_policy(app, harness).await?;
    let activation = operations::activation_observation(app, &harness.0.operations).await;
    if activation.is_none() {
        return Err(BEFORE_UNAVAILABLE);
    }
    Ok(app_observation(
        &native.snapshot,
        activation.as_ref(),
        harness.frontmost_matches_baseline(native.frontmost_pid),
        activation_policy_regular,
    ))
}

pub(super) async fn create_panel(
    app: &AppHandle<Wry>,
    harness: &Harness,
) -> Result<(), &'static str> {
    let dispatch_app = app.clone();
    let panel_app = dispatch_app.clone();
    let run_id = harness.0.profile.run_id.clone();
    harness
        .0
        .operations
        .run(&dispatch_app, move || {
            if PANEL_OWNER.with(|owner| owner.borrow().is_some()) {
                return Err(CREATE_FAILED);
            }
            let marker = MainThreadMarker::new().ok_or(CREATE_FAILED)?;
            let main_window = crate::window::main_window(&panel_app).map_err(|_| CREATE_FAILED)?;
            let pointer = main_window.ns_window().map_err(|_| CREATE_FAILED)?;
            if pointer.is_null() {
                return Err(CREATE_FAILED);
            }
            // SAFETY: Tauri owns the live main NSWindow and this closure is serialized onto the
            // AppKit main thread by NativeOperations.
            let main = unsafe { &*pointer.cast::<NSWindow>() };
            let frame = main.frame();
            let panel = AToolsInitializedPanelProbe::new(frame, marker);
            // SAFETY: The Retained owner below keeps the window alive after close.
            unsafe { panel.setReleasedWhenClosed(false) };
            panel.setFloatingPanel(true);
            panel.setHidesOnDeactivate(false);
            panel.setBecomesKeyOnlyIfNeeded(false);
            panel.setLevel(NSModalPanelWindowLevel + 1);

            let focus_view = ConstructorProbeFocusView::new(frame.size, marker);
            panel.setContentView(Some(&focus_view));
            panel.setInitialFirstResponder(Some(&focus_view));
            PANEL_OWNER.with(|owner| {
                *owner.borrow_mut() = Some(OwnedPanel {
                    panel,
                    focus_view,
                    main_frame: frame,
                    run_id,
                });
            });
            Ok(())
        })
        .await
}

pub(super) async fn show_panel(
    app: &AppHandle<Wry>,
    harness: &Harness,
) -> Result<(), &'static str> {
    let dispatch_app = app.clone();
    harness
        .0
        .operations
        .run(&dispatch_app, move || {
            let _marker = MainThreadMarker::new().ok_or(SHOW_FAILED)?;
            PANEL_OWNER.with(|owner| {
                let owner = owner.borrow();
                let owned = owner.as_ref().ok_or(SHOW_FAILED)?;
                owned.panel.orderFrontRegardless();
                owned.panel.makeKeyWindow();
                if !owned.panel.makeFirstResponder(Some(&owned.focus_view)) {
                    return Err(SHOW_FAILED);
                }
                Ok(())
            })
        })
        .await
        .map(|_| ())
}

pub(super) async fn capture_panel(
    app: &AppHandle<Wry>,
    harness: &Harness,
    before: &AppObservation,
) -> Result<PanelObservation, &'static str> {
    let dispatch_app = app.clone();
    let capture_app = dispatch_app.clone();
    let (panel, snapshot, frontmost_pid, activation_policy_regular) = harness
        .0
        .operations
        .run(&dispatch_app, move || {
            let marker = MainThreadMarker::new().ok_or(AFTER_UNAVAILABLE)?;
            let application = NSApplication::sharedApplication(marker);
            let activation_policy_regular =
                Some(application.activationPolicy() == NSApplicationActivationPolicy::Regular);
            let snapshot = crate::window::MainWindowSnapshot::capture(&capture_app);
            let snapshot = serde_json::to_value(snapshot).map_err(|_| AFTER_UNAVAILABLE)?;
            let current_pid = NSWorkspace::sharedWorkspace()
                .frontmostApplication()
                .map(|application| application.processIdentifier());
            let panel = PANEL_OWNER.with(|owner| {
                owner
                    .borrow()
                    .as_ref()
                    .map(|owned| inspect_panel(owned, marker))
            });
            Ok((
                panel.ok_or(AFTER_UNAVAILABLE)?,
                snapshot,
                current_pid,
                activation_policy_regular,
            ))
        })
        .await?;
    let activation = operations::activation_observation(app, &harness.0.operations).await;
    if activation.is_none() {
        return Err(AFTER_UNAVAILABLE);
    }
    Ok(merge_app_facts(
        panel,
        &snapshot,
        activation.as_ref(),
        harness.frontmost_matches_baseline(frontmost_pid),
        before,
        activation_policy_regular,
    ))
}

pub(super) async fn cleanup_panel(app: &AppHandle<Wry>, harness: &Harness) -> CleanupObservation {
    let dispatch_app = app.clone();
    let expected_run_id = harness.0.profile.run_id.clone();
    let result = harness
        .0
        .operations
        .run(&dispatch_app, move || {
            PANEL_OWNER.with(|owner| {
                let mut slot = owner.borrow_mut();
                let Some(owned) = slot.as_ref() else {
                    return Ok(CleanupObservation {
                        panel_created: Some(false),
                        order_out_confirmed: None,
                        close_requested: Some(false),
                        owner_cleared: Some(true),
                        native_operations_terminal: true,
                    });
                };
                if owned.run_id != expected_run_id {
                    return Ok(CleanupObservation {
                        panel_created: Some(false),
                        order_out_confirmed: None,
                        close_requested: Some(false),
                        owner_cleared: Some(false),
                        native_operations_terminal: true,
                    });
                }
                owned.panel.orderOut(None);
                let hidden = !owned.panel.isVisible();
                owned.panel.close();
                let hidden_after_close = !owned.panel.isVisible();
                if hidden_after_close {
                    let _owner = slot.take();
                }
                Ok(CleanupObservation {
                    panel_created: Some(true),
                    order_out_confirmed: Some(hidden),
                    close_requested: Some(true),
                    owner_cleared: Some(slot.is_none()),
                    native_operations_terminal: true,
                })
            })
        })
        .await;
    match result {
        Ok(mut cleanup) => {
            cleanup.native_operations_terminal = harness.0.operations.is_terminal();
            cleanup
        }
        Err(_) => CleanupObservation {
            panel_created: None,
            order_out_confirmed: None,
            close_requested: None,
            owner_cleared: Some(false),
            native_operations_terminal: harness.0.operations.is_terminal(),
        },
    }
}

fn inspect_panel(owned: &OwnedPanel, _marker: MainThreadMarker) -> PanelObservation {
    let panel = &owned.panel;
    let style = panel.styleMask();
    let content = panel.contentView();
    let focus_view_found = content.as_ref().is_some_and(|view| {
        std::ptr::eq(
            (&**view) as *const NSView,
            (&*owned.focus_view) as *const ConstructorProbeFocusView as *const NSView,
        )
    });
    let first_responder = panel.firstResponder();
    let focus_view_is_first_responder = first_responder.as_ref().is_some_and(|responder| {
        std::ptr::eq(
            (&**responder) as *const NSResponder,
            (&*owned.focus_view) as *const ConstructorProbeFocusView as *const NSResponder,
        )
    });
    PanelObservation {
        class_name: Some(class_name(panel.class())),
        is_panel: Some(panel.isKindOfClass(NSPanel::class())),
        style_mask_bits: Some(style.0 as u64),
        borderless_style: Some(!style.intersects(
            NSWindowStyleMask::Titled
                | NSWindowStyleMask::Closable
                | NSWindowStyleMask::Miniaturizable
                | NSWindowStyleMask::Resizable,
        )),
        nonactivating_style: Some(style.contains(NSWindowStyleMask::NonactivatingPanel)),
        level: i64::try_from(panel.level()).ok(),
        floating: Some(panel.isFloatingPanel()),
        hides_on_deactivate: Some(panel.hidesOnDeactivate()),
        becomes_key_only_if_needed: Some(panel.becomesKeyOnlyIfNeeded()),
        released_when_closed: Some(panel.isReleasedWhenClosed()),
        frame_matches_main: Some(rect_matches(panel.frame(), owned.main_frame)),
        visible: Some(panel.isVisible()),
        key: Some(panel.isKeyWindow()),
        on_active_space: Some(panel.isOnActiveSpace()),
        occlusion_visible: Some(
            panel
                .occlusionState()
                .contains(NSWindowOcclusionState::Visible),
        ),
        focus_view_found: Some(focus_view_found),
        focus_view_is_first_responder: Some(focus_view_is_first_responder),
        ..PanelObservation::default()
    }
}

fn merge_app_facts(
    mut panel: PanelObservation,
    snapshot: &Value,
    activation: Option<&Value>,
    frontmost_matches_baseline: Option<bool>,
    before: &AppObservation,
    activation_policy_regular: Option<bool>,
) -> PanelObservation {
    panel.app_active = snapshot.get("appActive").and_then(Value::as_bool);
    panel.app_hidden = snapshot.get("appHidden").and_then(Value::as_bool);
    panel.activation_policy_regular = activation_policy_regular;
    panel.frontmost_is_self = snapshot.get("frontmostIsSelf").and_then(Value::as_bool);
    panel.frontmost_matches_baseline = frontmost_matches_baseline;
    panel.main_window_visible = snapshot.get("mainVisible").and_then(Value::as_bool);
    panel.main_window_key = snapshot.get("mainKey").and_then(Value::as_bool);
    panel.app_activation_events = activation
        .and_then(|value| value.get("appActivationEvents"))
        .and_then(Value::as_u64);
    panel.main_key_events = activation
        .and_then(|value| value.get("mainKeyEvents"))
        .and_then(Value::as_u64);
    panel.app_activation_event_delta = panel
        .app_activation_events
        .zip(before.app_activation_events)
        .and_then(|(after, before)| after.checked_sub(before));
    panel.main_key_event_delta = panel
        .main_key_events
        .zip(before.main_key_events)
        .and_then(|(after, before)| after.checked_sub(before));
    panel
}

fn app_observation(
    snapshot: &Value,
    activation: Option<&Value>,
    frontmost_matches_baseline: Option<bool>,
    activation_policy_regular: bool,
) -> AppObservation {
    AppObservation {
        app_active: snapshot.get("appActive").and_then(Value::as_bool),
        app_hidden: snapshot.get("appHidden").and_then(Value::as_bool),
        activation_policy_regular: Some(activation_policy_regular),
        frontmost_is_self: snapshot.get("frontmostIsSelf").and_then(Value::as_bool),
        frontmost_matches_baseline,
        main_window_visible: snapshot.get("mainVisible").and_then(Value::as_bool),
        main_window_key: snapshot.get("mainKey").and_then(Value::as_bool),
        app_activation_events: activation
            .and_then(|value| value.get("appActivationEvents"))
            .and_then(Value::as_u64),
        main_key_events: activation
            .and_then(|value| value.get("mainKeyEvents"))
            .and_then(Value::as_u64),
    }
}

async fn capture_activation_policy(
    app: &AppHandle<Wry>,
    harness: &Harness,
) -> Result<bool, &'static str> {
    let dispatch_app = app.clone();
    harness
        .0
        .operations
        .run(&dispatch_app, move || {
            let marker = MainThreadMarker::new().ok_or(BEFORE_UNAVAILABLE)?;
            Ok(NSApplication::sharedApplication(marker).activationPolicy()
                == NSApplicationActivationPolicy::Regular)
        })
        .await
}

fn class_name(class: &AnyClass) -> String {
    class.name().to_string_lossy().into_owned()
}

fn rect_matches(left: NSRect, right: NSRect) -> bool {
    [
        left.origin.x - right.origin.x,
        left.origin.y - right.origin.y,
        left.size.width - right.size.width,
        left.size.height - right.size.height,
    ]
    .into_iter()
    .all(|difference| difference.is_finite() && difference.abs() <= 0.01)
}
