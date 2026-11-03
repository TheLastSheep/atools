use std::ptr;

use objc2::{
    rc::Retained,
    runtime::{AnyClass, NSObjectProtocol, ProtocolObject},
    sel, ClassType, MainThreadMarker,
};
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSModalPanelWindowLevel, NSPanel, NSRunningApplication, NSView,
    NSWindow, NSWindowCollectionBehavior, NSWindowDelegate, NSWindowStyleMask,
};
use tauri::{AppHandle, WebviewWindow, Window, Wry};
use tauri_nspanel::PanelHandle;

use super::{
    layout::{self, LayoutFacts, OriginalClassAssessment},
    runtime_methods::{self, TextInputMethodSnapshot},
    ConversionFacts, RestorationFacts, MAIN_PANEL_CONVERSION_FAILED, MAIN_PANEL_LAYOUT_REJECTED,
    MAIN_PANEL_RECOVERY_FAILED, MAIN_PANEL_WINDOW_UNAVAILABLE,
};

const RUNTIME_METHOD_LIFETIME: &str = "until-process-exit";

#[path = "diagnostics.rs"]
pub(super) mod diagnostics;
#[path = "restoration.rs"]
mod restoration;

#[derive(Clone)]
struct SubviewSnapshot {
    view: Retained<NSView>,
    autoresizing_mask: NSAutoresizingMaskOptions,
}

#[derive(Clone)]
pub(super) struct OriginalWindowSnapshot {
    window_address: usize,
    original_class: &'static AnyClass,
    original_class_name: String,
    original_class_assessment: OriginalClassAssessment,
    panel_class_name: String,
    original_instance_size: usize,
    panel_instance_size: usize,
    ns_panel_own_ivar_count: usize,
    focusable_offset: usize,
    parent_window_address: Option<usize>,
    content_view: Retained<NSView>,
    content_view_address: usize,
    subviews: Vec<SubviewSnapshot>,
    delegate: Option<Retained<ProtocolObject<dyn NSWindowDelegate>>>,
    delegate_address: Option<usize>,
    style_mask: NSWindowStyleMask,
    level: isize,
    collection_behavior: NSWindowCollectionBehavior,
    released_when_closed: bool,
    hides_on_deactivate: bool,
    can_become_key: bool,
    can_become_main: bool,
    selector_available: bool,
    text_input_methods: Option<TextInputMethodSnapshot>,
    panel_floating_before_config: Option<bool>,
    panel_becomes_key_only_before_config: Option<bool>,
}

thread_local! {
    static ORIGINAL_WINDOW: std::cell::RefCell<Option<OriginalWindowSnapshot>> = const {
        std::cell::RefCell::new(None)
    };
}

fn ns_window<'a>(window: &'a WebviewWindow<Wry>) -> Result<&'a NSWindow, &'static str> {
    let pointer = window
        .ns_window()
        .map_err(|_| MAIN_PANEL_WINDOW_UNAVAILABLE)?
        .cast::<NSWindow>();
    // SAFETY: Tauri owns the NSWindow for the lifetime of its WebviewWindow handle.
    unsafe { pointer.as_ref() }.ok_or(MAIN_PANEL_WINDOW_UNAVAILABLE)
}

pub(super) fn running_bundle_matches(expected: &str) -> bool {
    let Some(actual) = NSRunningApplication::currentApplication().bundleIdentifier() else {
        return false;
    };
    actual.to_string() == expected
}

fn class_name(class: &AnyClass) -> String {
    class.name().to_string_lossy().into_owned()
}

pub(super) fn capture_original(
    window: &WebviewWindow<Wry>,
) -> Result<(OriginalWindowSnapshot, LayoutFacts), &'static str> {
    let _main_thread = MainThreadMarker::new().ok_or(MAIN_PANEL_WINDOW_UNAVAILABLE)?;
    let native = ns_window(window)?;
    if native.isVisible() {
        return Err(MAIN_PANEL_WINDOW_UNAVAILABLE);
    }

    let original_class = native.class();
    let reported_class = layout::reported_class(native);
    let panel_class = super::RawAToolsMainPanel::class();
    let layout = layout::layout_facts(original_class, reported_class, panel_class)
        .ok_or(MAIN_PANEL_LAYOUT_REJECTED)?;
    if !layout.is_safe {
        return Err(MAIN_PANEL_LAYOUT_REJECTED);
    }
    let original_class_assessment = layout
        .original_class_assessment
        .clone()
        .ok_or(MAIN_PANEL_LAYOUT_REJECTED)?;

    let selector_available = native.respondsToSelector(sel!(_setPreventsActivation:));
    if !selector_available {
        return Err(MAIN_PANEL_LAYOUT_REJECTED);
    }

    let content_view = native.contentView().ok_or(MAIN_PANEL_WINDOW_UNAVAILABLE)?;
    let subviews = content_view.subviews();
    let captured_subviews = subviews
        .iter()
        .map(|view| SubviewSnapshot {
            view: view.clone(),
            autoresizing_mask: view.autoresizingMask(),
        })
        .collect();
    let delegate = native.delegate();
    let delegate_address = delegate
        .as_ref()
        .map(|value| (&**value as *const ProtocolObject<dyn NSWindowDelegate>) as usize);
    let parent_window_address = native
        .parentWindow()
        .as_ref()
        .map(|parent| (&**parent as *const NSWindow) as usize);
    let runtime_methods = runtime_methods::snapshot(&content_view);

    Ok((
        OriginalWindowSnapshot {
            window_address: (native as *const NSWindow) as usize,
            original_class,
            original_class_name: class_name(original_class),
            original_class_assessment,
            panel_class_name: class_name(panel_class),
            original_instance_size: layout.original_instance_size,
            panel_instance_size: layout.panel_instance_size,
            ns_panel_own_ivar_count: layout.ns_panel_own_ivar_count,
            focusable_offset: layout.focusable_offset,
            parent_window_address,
            content_view_address: (&*content_view as *const NSView) as usize,
            content_view,
            subviews: captured_subviews,
            delegate,
            delegate_address,
            style_mask: native.styleMask(),
            level: native.level(),
            collection_behavior: native.collectionBehavior(),
            released_when_closed: native.isReleasedWhenClosed(),
            hides_on_deactivate: native.hidesOnDeactivate(),
            can_become_key: native.canBecomeKeyWindow(),
            can_become_main: native.canBecomeMainWindow(),
            selector_available,
            text_input_methods: runtime_methods,
            panel_floating_before_config: None,
            panel_becomes_key_only_before_config: None,
        },
        layout,
    ))
}

pub(super) fn snapshot_slot_empty() -> bool {
    ORIGINAL_WINDOW.with(|current| current.borrow().is_none())
}

pub(super) fn store_snapshot(snapshot: OriginalWindowSnapshot) -> Result<(), ()> {
    ORIGINAL_WINDOW.with(|current| {
        let mut current = current.borrow_mut();
        if current.is_some() {
            return Err(());
        }
        *current = Some(snapshot);
        Ok(())
    })
}

pub(super) fn replace_snapshot(snapshot: OriginalWindowSnapshot) -> Result<(), ()> {
    ORIGINAL_WINDOW.with(|current| {
        let mut current = current.borrow_mut();
        if current.is_none() {
            return Err(());
        }
        *current = Some(snapshot);
        Ok(())
    })
}

pub(super) fn snapshot_clone() -> Option<OriginalWindowSnapshot> {
    ORIGINAL_WINDOW.with(|current| current.borrow().clone())
}

pub(super) fn clear_snapshot() {
    ORIGINAL_WINDOW.with(|current| *current.borrow_mut() = None);
}

pub(super) fn current_class_is_original(
    window: &WebviewWindow<Wry>,
    snapshot: &OriginalWindowSnapshot,
) -> bool {
    ns_window(window).is_ok_and(|native| {
        (native as *const NSWindow) as usize == snapshot.window_address
            && ptr::eq(native.class(), snapshot.original_class)
    })
}

pub(super) fn content_view_matches_original(
    window: &Window,
    snapshot: &OriginalWindowSnapshot,
) -> Result<bool, &'static str> {
    if window.label() != "main" {
        return Err(MAIN_PANEL_WINDOW_UNAVAILABLE);
    }
    let pointer = window
        .ns_window()
        .map_err(|_| MAIN_PANEL_WINDOW_UNAVAILABLE)?
        .cast::<NSWindow>();
    // SAFETY: The Tauri Window handle owns the native NSWindow for this read.
    let native = unsafe { pointer.as_ref() }.ok_or(MAIN_PANEL_WINDOW_UNAVAILABLE)?;
    Ok(
        (native as *const NSWindow) as usize == snapshot.window_address
            && content_matches(native, snapshot),
    )
}

pub(super) fn capture_panel_baseline(
    snapshot: &mut OriginalWindowSnapshot,
    panel: &PanelHandle<Wry>,
) {
    let native = panel.as_panel();
    snapshot.panel_floating_before_config = Some(native.isFloatingPanel());
    snapshot.panel_becomes_key_only_before_config = Some(native.becomesKeyOnlyIfNeeded());
}

pub(super) fn configure_and_verify(
    window: &WebviewWindow<Wry>,
    panel: &PanelHandle<Wry>,
    snapshot: &OriginalWindowSnapshot,
) -> Result<ConversionFacts, &'static str> {
    snapshot
        .panel_floating_before_config
        .ok_or(MAIN_PANEL_CONVERSION_FAILED)?;
    snapshot
        .panel_becomes_key_only_before_config
        .ok_or(MAIN_PANEL_CONVERSION_FAILED)?;

    panel.set_floating_panel(true);
    panel.set_hides_on_deactivate(false);
    panel.set_becomes_key_only_if_needed(false);
    let target_level = NSModalPanelWindowLevel + 1;
    panel.set_level(i64::try_from(target_level).map_err(|_| MAIN_PANEL_CONVERSION_FAILED)?);
    let native = panel.as_panel();
    panel
        .set_style_mask(native.styleMask() | NSWindowStyleMask::NonactivatingPanel)
        .map_err(|_| MAIN_PANEL_CONVERSION_FAILED)?;

    let facts = read_conversion_facts(window, panel, snapshot)?;
    if !conversion_facts_are_valid(&facts, true) {
        return Err(MAIN_PANEL_CONVERSION_FAILED);
    }
    Ok(facts)
}

pub(super) fn read_conversion_facts(
    window: &WebviewWindow<Wry>,
    panel: &PanelHandle<Wry>,
    snapshot: &OriginalWindowSnapshot,
) -> Result<ConversionFacts, &'static str> {
    let native = panel.as_panel();
    let same_window = ns_window(window).is_ok_and(|current| {
        (current as *const NSWindow) as usize == snapshot.window_address
            && ptr::eq(current.class(), panel.as_panel().class())
    });
    let runtime_added = runtime_methods::added_since(
        snapshot.text_input_methods.as_ref(),
        runtime_methods::snapshot(&snapshot.content_view).as_ref(),
    );
    let subview_resize_mask =
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable;
    let facts = ConversionFacts {
        scoped_identifier_matches: true,
        main_window_hidden_before_conversion: true,
        same_native_window: same_window,
        original_class: snapshot.original_class_name.clone(),
        original_class_assessment: snapshot.original_class_assessment.clone(),
        panel_class: snapshot.panel_class_name.clone(),
        original_instance_size: snapshot.original_instance_size,
        panel_instance_size: snapshot.panel_instance_size,
        tao_focusable_offset: snapshot.focusable_offset,
        ns_panel_own_ivar_count: snapshot.ns_panel_own_ivar_count,
        focusable_layout_safe: true,
        is_panel: native.isKindOfClass(NSPanel::class()),
        panel_class_matches: class_name(native.class()) == snapshot.panel_class_name,
        nonactivating_style: native
            .styleMask()
            .contains(NSWindowStyleMask::NonactivatingPanel),
        selector_available: snapshot.selector_available
            && native.respondsToSelector(sel!(_setPreventsActivation:)),
        can_become_key: native.canBecomeKeyWindow(),
        can_become_main: native.canBecomeMainWindow(),
        still_hidden: !native.isVisible(),
        original_delegate_unchanged: delegate_matches(native, snapshot.delegate_address),
        content_view_and_parent_unchanged: content_matches(native, snapshot),
        collection_behavior_unchanged: native.collectionBehavior() == snapshot.collection_behavior,
        released_when_closed_unchanged: native.isReleasedWhenClosed()
            == snapshot.released_when_closed,
        subview_masks_adjusted: snapshot
            .subviews
            .iter()
            .all(|item| item.view.autoresizingMask() == subview_resize_mask),
        level: i64::try_from(native.level()).map_err(|_| MAIN_PANEL_CONVERSION_FAILED)?,
        floating: native.isFloatingPanel(),
        hides_on_deactivate: native.hidesOnDeactivate(),
        becomes_key_only_if_needed: native.becomesKeyOnlyIfNeeded(),
        subview_count: snapshot.subviews.len(),
        text_input_method_added: runtime_added,
        runtime_method_lifetime: RUNTIME_METHOD_LIFETIME,
        runtime_method_removal_supported: false,
    };
    Ok(facts)
}

fn conversion_facts_are_valid(facts: &ConversionFacts, require_hidden: bool) -> bool {
    facts.same_native_window
        && facts.original_class_assessment.actual_class == facts.original_class
        && facts.original_class_assessment.actual_instance_size == facts.original_instance_size
        && facts
            .original_class_assessment
            .tao_direct_superclass_is_ns_window
        && facts.is_panel
        && facts.panel_class_matches
        && facts.nonactivating_style
        && facts.selector_available
        && facts.can_become_key
        && !facts.can_become_main
        && (!require_hidden || facts.still_hidden)
        && facts.original_delegate_unchanged
        && facts.content_view_and_parent_unchanged
        && facts.collection_behavior_unchanged
        && facts.released_when_closed_unchanged
        && facts.subview_masks_adjusted
        && facts.ns_panel_own_ivar_count == 0
        && i64::try_from(NSModalPanelWindowLevel + 1).ok() == Some(facts.level)
        && facts.floating
        && !facts.hides_on_deactivate
        && !facts.becomes_key_only_if_needed
}

pub(super) fn snapshot_conversion(
    window: &WebviewWindow<Wry>,
    panel: &PanelHandle<Wry>,
    snapshot: &OriginalWindowSnapshot,
) -> Result<ConversionFacts, &'static str> {
    let facts = read_conversion_facts(window, panel, snapshot)?;
    if !conversion_facts_are_valid(&facts, false) {
        return Err(MAIN_PANEL_CONVERSION_FAILED);
    }
    Ok(facts)
}

pub(super) fn restore(
    app: &AppHandle,
    window: &WebviewWindow<Wry>,
    snapshot: &OriginalWindowSnapshot,
) -> Result<RestorationFacts, &'static str> {
    restoration::restore(app, window, snapshot)
}

fn same_native_panel(
    window: &WebviewWindow<Wry>,
    panel: &NSPanel,
    snapshot: &OriginalWindowSnapshot,
) -> bool {
    ns_window(window).is_ok_and(|current| {
        (current as *const NSWindow) as usize == snapshot.window_address
            && (panel as *const NSPanel) as usize == snapshot.window_address
            && panel.isKindOfClass(NSPanel::class())
            && class_name(panel.class()) == snapshot.panel_class_name
    })
}

fn delegate_matches(window: &NSWindow, expected: Option<usize>) -> bool {
    let actual = window
        .delegate()
        .as_ref()
        .map(|delegate| (&**delegate as *const ProtocolObject<dyn NSWindowDelegate>) as usize);
    actual == expected
}

fn content_matches(window: &NSWindow, snapshot: &OriginalWindowSnapshot) -> bool {
    let Some(content) = window.contentView() else {
        return false;
    };
    (&*content as *const NSView) as usize == snapshot.content_view_address
        && window
            .parentWindow()
            .as_ref()
            .map(|parent| (&**parent as *const NSWindow) as usize)
            == snapshot.parent_window_address
}

fn restore_subview_masks(snapshot: &OriginalWindowSnapshot) -> Result<(), &'static str> {
    for item in &snapshot.subviews {
        item.view.setAutoresizingMask(item.autoresizing_mask);
        if item.view.autoresizingMask() != item.autoresizing_mask {
            return Err(MAIN_PANEL_RECOVERY_FAILED);
        }
    }
    Ok(())
}

fn subview_masks_match(snapshot: &OriginalWindowSnapshot) -> bool {
    snapshot
        .subviews
        .iter()
        .all(|item| item.view.autoresizingMask() == item.autoresizing_mask)
}
