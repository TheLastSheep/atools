use tauri::{PhysicalPosition, PhysicalSize};

const MAIN_WINDOW_LABEL: &str = "main";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct LayoutBounds {
    y: u32,
    width: u32,
    height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LayoutPlan {
    Visible(LayoutBounds),
    Hidden,
}

fn plan_layout(
    parent_size: PhysicalSize<u32>,
    scale_factor: f64,
    header_logical: u32,
) -> Result<LayoutPlan, String> {
    if header_logical == 0 {
        return Err("Main child layout header height must be nonzero".into());
    }
    if !scale_factor.is_finite() || scale_factor <= 0.0 {
        return Err("Main child layout scale factor must be finite and positive".into());
    }

    let header_physical = (f64::from(header_logical) * scale_factor).round();
    if !header_physical.is_finite()
        || header_physical < 1.0
        || header_physical > f64::from(i32::MAX)
    {
        return Err("Main child layout header height is outside the physical pixel range".into());
    }
    let y = header_physical as u32;

    if parent_size.width == 0 || parent_size.height <= y {
        return Ok(LayoutPlan::Hidden);
    }

    Ok(LayoutPlan::Visible(LayoutBounds {
        y,
        width: parent_size.width,
        height: parent_size.height - y,
    }))
}

fn plan_owned_layout(
    size: PhysicalSize<u32>,
    scale: f64,
    header: u32,
    requested: Option<f64>,
) -> Result<LayoutPlan, String> {
    let mut plan = plan_layout(size, scale, header)?;
    if let (LayoutPlan::Visible(bounds), Some(desired)) = (&mut plan, requested) {
        let (position, size) =
            super::content_height::settings_child_bounds(size, scale, header, desired)?;
        bounds.y = position.y as u32;
        bounds.width = size.width;
        bounds.height = size.height;
    }
    Ok(plan)
}

#[derive(Clone, Debug)]
struct ActiveRegistration {
    id: u64,
    webview_label: String,
    header_logical: u32,
    requested_content: Option<f64>,
    parent_identity: Option<usize>,
    visible: bool,
}

#[derive(Default)]
struct RegistrationState {
    next_id: u64,
    active: Option<ActiveRegistration>,
}

impl RegistrationState {
    fn reserve(&mut self, webview_label: String, header_logical: u32) -> Result<u64, String> {
        self.reserve_requested(webview_label, header_logical, None)
    }

    fn reserve_requested(
        &mut self,
        webview_label: String,
        header_logical: u32,
        requested_content: Option<f64>,
    ) -> Result<u64, String> {
        if self.active.is_some() {
            return Err("A main child layout owner is already registered".into());
        }
        let id = self
            .next_id
            .checked_add(1)
            .ok_or_else(|| "Main child layout registration id space is exhausted".to_owned())?;
        self.next_id = id;
        self.active = Some(ActiveRegistration {
            id,
            webview_label,
            header_logical,
            requested_content,
            parent_identity: None,
            visible: false,
        });
        Ok(id)
    }

    fn release(&mut self, registration_id: u64) -> bool {
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.id == registration_id)
        {
            self.active = None;
            true
        } else {
            false
        }
    }
}

#[cfg(feature = "ztools-multiwebview")]
#[derive(Default)]
struct MainChildLayoutRegistry {
    state: std::sync::Mutex<RegistrationState>,
}

#[cfg(feature = "ztools-multiwebview")]
pub(crate) struct MainChildLayoutLease {
    registry: std::sync::Arc<MainChildLayoutRegistry>,
    registration_id: u64,
}

#[cfg(feature = "ztools-multiwebview")]
impl Drop for MainChildLayoutLease {
    fn drop(&mut self) {
        match self.registry.state.lock() {
            Ok(mut state) => {
                state.release(self.registration_id);
            }
            Err(_) => {
                tracing::error!("Main child layout registry mutex is poisoned during lease cleanup")
            }
        }
    }
}

#[cfg(feature = "ztools-multiwebview")]
fn ensure_registry(
    app: &tauri::AppHandle,
) -> Result<std::sync::Arc<MainChildLayoutRegistry>, String> {
    use tauri::Manager;

    if app
        .try_state::<std::sync::Arc<MainChildLayoutRegistry>>()
        .is_none()
    {
        app.manage(std::sync::Arc::new(MainChildLayoutRegistry::default()));
    }
    app.try_state::<std::sync::Arc<MainChildLayoutRegistry>>()
        .map(|state| std::sync::Arc::clone(state.inner()))
        .ok_or_else(|| "Main child layout registry is unavailable".into())
}

#[cfg(feature = "ztools-multiwebview")]
pub(crate) fn attach_main_child_layout(
    app: &tauri::AppHandle,
    child: &tauri::Webview,
    header_logical: u32,
) -> Result<MainChildLayoutLease, String> {
    attach_layout(app, child, header_logical, None)
}

#[cfg(feature = "ztools-multiwebview")]
pub(crate) fn attach_settings_child_layout(
    app: &tauri::AppHandle,
    child: &tauri::Webview,
    header_logical: u32,
    desired: f64,
) -> Result<MainChildLayoutLease, String> {
    attach_layout(app, child, header_logical, Some(desired))
}

#[cfg(feature = "ztools-multiwebview")]
pub(crate) fn attach_settings_child_layout_on_window(
    app: &tauri::AppHandle,
    parent: &tauri::Window,
    child: &tauri::Webview,
    header_logical: u32,
    desired: f64,
) -> Result<MainChildLayoutLease, String> {
    if window_identity(parent) != window_identity(&child.window()) {
        return Err("Settings child parent is no longer the captured Main".into());
    }
    attach_layout(app, child, header_logical, Some(desired))
}

#[cfg(feature = "ztools-multiwebview")]
fn window_identity(window: &tauri::Window) -> usize {
    use tauri::Manager;
    &*window.resources_table() as *const _ as usize
}

#[cfg(feature = "ztools-multiwebview")]
fn attach_layout(
    app: &tauri::AppHandle,
    child: &tauri::Webview,
    header_logical: u32,
    requested: Option<f64>,
) -> Result<MainChildLayoutLease, String> {
    use tauri::Manager;

    let parent = child.window();
    if parent.label() != MAIN_WINDOW_LABEL {
        return Err("Main child layout requires a webview parented to the main window".into());
    }
    if child.label() == MAIN_WINDOW_LABEL {
        return Err("The primary main webview cannot register as a child layout".into());
    }

    let registry = ensure_registry(app)?;
    let registration_id = {
        let mut state = registry
            .state
            .lock()
            .map_err(|_| "Main child layout registry mutex is poisoned".to_owned())?;
        let id = state.reserve_requested(child.label().to_owned(), header_logical, requested)?;
        if let Some(active) = state.active.as_mut() {
            active.parent_identity = Some(window_identity(&parent));
        }
        id
    };
    let lease = MainChildLayoutLease {
        registry: registry.clone(),
        registration_id,
    };

    child
        .set_auto_resize(false)
        .map_err(|error| format!("Could not disable main child auto-resize: {error}"))?;
    let layout = plan_owned_layout(
        parent
            .inner_size()
            .map_err(|error| format!("Could not read main window content size: {error}"))?,
        parent
            .scale_factor()
            .map_err(|error| format!("Could not read main window scale factor: {error}"))?,
        header_logical,
        requested,
    )?;
    match layout {
        LayoutPlan::Visible(bounds) => {
            apply_visible_layout(child, bounds)?;
            set_visible(&registry, registration_id, true);
        }
        LayoutPlan::Hidden => {
            hide_layout(
                &registry,
                registration_id,
                || crate::hotkey::recording_runtime::note_main_hidden(app),
                || {
                    child.hide().map_err(|error| {
                        format!("Could not hide child from collapsed main window: {error}")
                    })
                },
            )?;
            return Err("Main window has no content area below the fixed header".into());
        }
    }
    Ok(lease)
}

#[cfg(feature = "ztools-multiwebview")]
pub(crate) fn main_child_layout_active_count(app: &tauri::AppHandle) -> Result<usize, String> {
    use tauri::Manager;

    let Some(registry) = app.try_state::<std::sync::Arc<MainChildLayoutRegistry>>() else {
        return Ok(0);
    };
    let state = registry
        .state
        .lock()
        .map_err(|_| "Main child layout registry mutex is poisoned".to_owned())?;
    Ok(if state.active.is_some() { 1 } else { 0 })
}

#[cfg(feature = "ztools-multiwebview")]
fn apply_visible_layout(child: &tauri::Webview, bounds: LayoutBounds) -> Result<(), String> {
    child
        .set_bounds(tauri::Rect {
            position: tauri::Position::Physical(PhysicalPosition::new(
                0,
                i32::try_from(bounds.y)
                    .map_err(|_| "Main child layout y coordinate is out of range")?,
            )),
            size: tauri::Size::Physical(PhysicalSize::new(bounds.width, bounds.height)),
        })
        .map_err(|error| format!("Could not set main child bounds: {error}"))?;
    child
        .show()
        .map_err(|error| format!("Could not show main child webview: {error}"))
}

#[cfg(feature = "ztools-multiwebview")]
pub(crate) fn handle_main_child_layout_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    use tauri::Manager;

    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }
    let app = window.app_handle();
    let Some(registry) = app.try_state::<std::sync::Arc<MainChildLayoutRegistry>>() else {
        return;
    };
    let active = match registry.state.lock() {
        Ok(state) => state.active.clone(),
        Err(_) => {
            tracing::error!("Main child layout registry mutex is poisoned during window event");
            return;
        }
    };
    let Some(active) = active else {
        return;
    };

    if active.parent_identity != Some(window_identity(window)) {
        return;
    }
    if matches!(event, tauri::WindowEvent::Destroyed) {
        release_registration(registry.inner(), active.id);
        return;
    }
    if !matches!(
        event,
        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
    ) {
        return;
    }

    let Some(child) = app.get_webview(&active.webview_label) else {
        release_registration(registry.inner(), active.id);
        tracing::warn!("Registered main child webview is unavailable during parent resize");
        return;
    };
    if child.label() == MAIN_WINDOW_LABEL || child.window().label() != MAIN_WINDOW_LABEL {
        release_registration(registry.inner(), active.id);
        tracing::warn!("Registered main child webview no longer belongs to the main window");
        return;
    }

    let layout = window
        .inner_size()
        .map_err(|error| format!("Could not read main window content size: {error}"))
        .and_then(|size| {
            window
                .scale_factor()
                .map_err(|error| format!("Could not read main window scale factor: {error}"))
                .and_then(|scale| {
                    plan_owned_layout(size, scale, active.header_logical, active.requested_content)
                })
        });
    let result = layout.and_then(|layout| match layout {
        LayoutPlan::Visible(bounds) => {
            let result = apply_visible_layout(&child, bounds);
            set_visible(registry.inner(), active.id, result.is_ok());
            if result.is_err() {
                crate::hotkey::recording_runtime::note_main_hidden(app);
            }
            result
        }
        LayoutPlan::Hidden => hide_layout(
            registry.inner(),
            active.id,
            || crate::hotkey::recording_runtime::note_main_hidden(app),
            || {
                child.hide().map_err(|error| {
                    format!("Could not hide child from collapsed main window: {error}")
                })
            },
        ),
    });
    if let Err(error) = result {
        tracing::warn!(%error, "Main child layout could not be updated after parent resize");
    }
}

#[cfg(feature = "ztools-multiwebview")]
fn hide_layout(
    registry: &MainChildLayoutRegistry,
    id: u64,
    cancel: impl FnOnce(),
    hide: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    set_visible(registry, id, false);
    cancel();
    hide()
}

#[cfg(feature = "ztools-multiwebview")]
fn set_visible(registry: &MainChildLayoutRegistry, id: u64, visible: bool) {
    if let Ok(mut state) = registry.state.lock() {
        if let Some(active) = state.active.as_mut().filter(|active| active.id == id) {
            active.visible = visible;
        }
    }
}

#[cfg(feature = "ztools-multiwebview")]
pub(crate) fn main_child_is_visible(app: &tauri::AppHandle, label: &str) -> bool {
    use tauri::Manager;
    app.try_state::<std::sync::Arc<MainChildLayoutRegistry>>()
        .is_some_and(|registry| {
            registry.state.lock().is_ok_and(|state| {
                state
                    .active
                    .as_ref()
                    .is_some_and(|active| active.webview_label == label && active.visible)
            })
        })
}

#[cfg(feature = "ztools-multiwebview")]
fn release_registration(registry: &MainChildLayoutRegistry, registration_id: u64) {
    match registry.state.lock() {
        Ok(mut state) => {
            state.release(registration_id);
        }
        Err(_) => tracing::error!("Main child layout registry mutex is poisoned during cleanup"),
    }
}

#[cfg(not(feature = "ztools-multiwebview"))]
pub(crate) fn handle_main_child_layout_event(_window: &tauri::Window, _event: &tauri::WindowEvent) {
}

#[cfg(test)]
#[path = "main_child_layout_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "main_child_requested_tests.rs"]
mod requested_tests;
