use std::ptr;

use objc2::MainThreadMarker;
use objc2_app_kit::NSWindow;
use tauri::{AppHandle, WebviewWindow, Wry};
use tauri_nspanel::ManagerExt;

use super::{
    content_matches, delegate_matches, ns_window, restore_subview_masks, runtime_methods,
    same_native_panel, subview_masks_match, OriginalWindowSnapshot, RestorationFacts,
    MAIN_PANEL_RECOVERY_FAILED, RUNTIME_METHOD_LIFETIME,
};

pub(super) fn restore(
    app: &AppHandle,
    window: &WebviewWindow<Wry>,
    snapshot: &OriginalWindowSnapshot,
) -> Result<RestorationFacts, &'static str> {
    let _main_thread = MainThreadMarker::new().ok_or(MAIN_PANEL_RECOVERY_FAILED)?;
    let panel = app
        .get_webview_panel("main")
        .map_err(|_| MAIN_PANEL_RECOVERY_FAILED)?;
    let native = panel.as_panel();
    if window.is_visible().unwrap_or(true)
        || native.isVisible()
        || !same_native_panel(window, native, snapshot)
    {
        return Err(MAIN_PANEL_RECOVERY_FAILED);
    }

    let floating_baseline = snapshot
        .panel_floating_before_config
        .ok_or(MAIN_PANEL_RECOVERY_FAILED)?;
    let becomes_key_baseline = snapshot
        .panel_becomes_key_only_before_config
        .ok_or(MAIN_PANEL_RECOVERY_FAILED)?;

    panel
        .set_style_mask(snapshot.style_mask)
        .map_err(|_| MAIN_PANEL_RECOVERY_FAILED)?;
    panel.set_floating_panel(floating_baseline);
    panel.set_becomes_key_only_if_needed(becomes_key_baseline);
    panel.set_hides_on_deactivate(snapshot.hides_on_deactivate);
    panel.set_level(i64::try_from(snapshot.level).map_err(|_| MAIN_PANEL_RECOVERY_FAILED)?);
    panel.set_collection_behavior(snapshot.collection_behavior);
    restore_subview_masks(snapshot)?;

    let panel_floating_baseline_restored = native.isFloatingPanel() == floating_baseline;
    let panel_becomes_key_baseline_restored =
        native.becomesKeyOnlyIfNeeded() == becomes_key_baseline;
    if native.styleMask() != snapshot.style_mask
        || native.level() != snapshot.level
        || native.collectionBehavior() != snapshot.collection_behavior
        || !panel_floating_baseline_restored
        || !panel_becomes_key_baseline_restored
        || native.hidesOnDeactivate() != snapshot.hides_on_deactivate
    {
        return Err(MAIN_PANEL_RECOVERY_FAILED);
    }

    // This is the pinned library's supported inverse for its class conversion.
    let returned_window = panel.to_window().ok_or(MAIN_PANEL_RECOVERY_FAILED)?;
    if returned_window.label() != "main" {
        return Err(MAIN_PANEL_RECOVERY_FAILED);
    }
    let restored = ns_window(&returned_window).map_err(|_| MAIN_PANEL_RECOVERY_FAILED)?;
    if (restored as *const NSWindow) as usize != snapshot.window_address
        || !ptr::eq(restored.class(), snapshot.original_class)
    {
        return Err(MAIN_PANEL_RECOVERY_FAILED);
    }
    // The library sets this false while returning ownership to Tauri; restore the exact value
    // captured from the original TaoWindow after the class is back in place.
    unsafe { restored.setReleasedWhenClosed(snapshot.released_when_closed) };
    if let Some(delegate) = snapshot.delegate.as_ref() {
        restored.setDelegate(Some(&**delegate));
    }

    let same_native_window = (restored as *const NSWindow) as usize == snapshot.window_address;
    let original_class_restored = ptr::eq(restored.class(), snapshot.original_class);
    let original_delegate_restored = delegate_matches(restored, snapshot.delegate_address);
    let released_when_closed_restored =
        restored.isReleasedWhenClosed() == snapshot.released_when_closed;
    let subview_masks_restored = subview_masks_match(snapshot);
    let content_view_restored = content_matches(restored, snapshot);
    let style_mask_restored = restored.styleMask() == snapshot.style_mask;
    let level_restored = restored.level() == snapshot.level;
    let collection_behavior_restored =
        restored.collectionBehavior() == snapshot.collection_behavior;
    let hides_on_deactivate_restored = restored.hidesOnDeactivate() == snapshot.hides_on_deactivate;
    let can_become_key_restored = restored.canBecomeKeyWindow() == snapshot.can_become_key;
    let can_become_main_restored = restored.canBecomeMainWindow() == snapshot.can_become_main;
    let text_input_method_remains = runtime_methods::added_since(
        snapshot.text_input_methods.as_ref(),
        runtime_methods::snapshot(&snapshot.content_view).as_ref(),
    );
    let facts = RestorationFacts {
        same_native_window,
        original_class_restored,
        original_delegate_restored,
        released_when_closed_restored,
        subview_masks_restored,
        content_view_restored,
        style_mask_restored,
        level_restored,
        collection_behavior_restored,
        hides_on_deactivate_restored,
        can_become_key_restored,
        can_become_main_restored,
        panel_floating_baseline_restored,
        panel_becomes_key_baseline_restored,
        window_restored: true,
        text_input_method_remains,
        runtime_method_lifetime: RUNTIME_METHOD_LIFETIME,
        runtime_method_removal_supported: false,
    };
    if !facts.same_native_window
        || !facts.original_class_restored
        || !facts.original_delegate_restored
        || !facts.released_when_closed_restored
        || !facts.subview_masks_restored
        || !facts.content_view_restored
        || !facts.style_mask_restored
        || !facts.level_restored
        || !facts.collection_behavior_restored
        || !facts.hides_on_deactivate_restored
        || !facts.can_become_key_restored
        || !facts.can_become_main_restored
        || !facts.panel_floating_baseline_restored
        || !facts.panel_becomes_key_baseline_restored
    {
        return Err(MAIN_PANEL_RECOVERY_FAILED);
    }
    Ok(facts)
}
