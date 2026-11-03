//! Owned standard menu roles. Only tracked Close slots may be replaced after installation.
use super::{
    native, policy,
    roles::{self, Role},
    Runtime, Snapshot,
};
use tauri::{
    menu::{AboutMetadata, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu},
    AppHandle, Manager, Wry,
};
pub(super) const CLOSE_ON: &str = "atools.original.close.on";
pub(super) const CLOSE_OFF: &str = "atools.original.close.off";
const ROOT_ID: &str = "atools.original.menu";
pub(super) struct Slot {
    pub(super) parent: Submenu<Wry>,
    pub(super) native: PredefinedMenuItem<Wry>,
    pub(super) on: MenuItem<Wry>,
    pub(super) off: MenuItem<Wry>,
    pub(super) native_parent: usize,
    pub(super) detached: Option<usize>,
    pub(super) parent_hold: Option<native::Instance>,
    pub(super) item_hold: Option<native::Instance>,
    pub(super) allow_new_item: bool,
}
pub(super) struct State {
    pub(super) root: Menu<Wry>,
    pub(super) native_root: usize,
    root_hold: Option<native::Instance>,
    pub(super) slots: Vec<Slot>,
    pub(super) projection: roles::Projection,
}
pub(super) fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    if !super::is_original(app) {
        return Menu::default(app);
    }
    let on = MenuItem::with_id(app, CLOSE_ON, "Close", true, Some("Cmd+W"))?;
    let off = MenuItem::with_id(app, CLOSE_OFF, "Close", true, None::<&str>)?;
    let file_close = PredefinedMenuItem::close_window(app, None)?;
    let window_close = PredefinedMenuItem::close_window(app, None)?;
    let file =
        Submenu::with_id_and_items(app, "atools.original.file", "File", true, &[&file_close])?;
    let window = Submenu::with_id_and_items(
        app,
        "__tauri_window_menu__",
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &window_close,
        ],
    )?;
    let info = app.package_info();
    let metadata = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        authors: app
            .config()
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };
    let application = Submenu::with_id_and_items(
        app,
        "atools.original.application",
        info.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(metadata))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_id_and_items(
        app,
        "atools.original.edit",
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_id_and_items(
        app,
        "atools.original.view",
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;
    let help = Submenu::with_id_and_items(app, "__tauri_help_menu__", "Help", true, &[])?;
    let root = Menu::with_id_and_items(
        app,
        ROOT_ID,
        &[&application, &file, &edit, &view, &window, &help],
    )?;
    let raw = app
        .state::<crate::state::AppState>()
        .db
        .get_setting("settings-general")
        .map_err(|error| tauri::Error::Anyhow(anyhow::anyhow!(error.to_string())))?;
    let runtime = app.state::<Runtime>();
    *runtime.state.lock() = Some(State {
        root: root.clone(),
        native_root: 0,
        root_hold: None,
        slots: vec![
            Slot {
                parent: file,
                native: file_close,
                on: on.clone(),
                off: off.clone(),
                native_parent: 0,
                detached: None,
                parent_hold: None,
                item_hold: None,
                allow_new_item: true,
            },
            Slot {
                parent: window,
                native: window_close,
                on,
                off,
                native_parent: 0,
                detached: None,
                parent_hold: None,
                item_hold: None,
                allow_new_item: true,
            },
        ],
        projection: roles::Projection {
            snapshot: Snapshot {
                enabled: policy::enabled(raw.as_deref()),
                generation: 1,
            },
            known: true,
        },
    });
    Ok(root)
}
struct NativeSlots<'a> {
    app: &'a AppHandle,
    root: &'a Menu<Wry>,
    native_root: &'a mut usize,
    root_hold: &'a mut Option<native::Instance>,
    slots: &'a mut [Slot],
}
impl roles::Port for NativeSlots<'_> {
    fn focused_main(&mut self) -> bool {
        super::window_compat::focused(self.app).is_some_and(|window| window.label() == "main")
    }
    fn select(&mut self, index: usize, role: Role) -> Result<Role, String> {
        if self
            .app
            .menu()
            .is_none_or(|menu| menu.id() != self.root.id())
        {
            return Err(policy::RECOVERY.into());
        }
        let root = native::root_pointer(self.app, self.root)?;
        if *self.native_root == 0 {
            let hold = native::hold_root(self.app, self.root)?;
            if hold.address() != root {
                return Err(policy::RECOVERY.into());
            }
            *self.root_hold = Some(hold);
            *self.native_root = root;
        } else if *self.native_root != root {
            return Err(policy::RECOVERY.into());
        }
        let slot = self.slots.get_mut(index).ok_or(policy::RECOVERY)?;
        native::verify_parent(self.app, self.root, *self.native_root, slot)?;
        let items = slot.parent.items().map_err(|_| policy::RECOVERY)?;
        let tracked: Vec<_> = items
            .iter()
            .enumerate()
            .filter(|(_, item)| {
                item.id() == slot.native.id()
                    || item.id() == slot.on.id()
                    || item.id() == slot.off.id()
            })
            .collect();
        let position = if let Some(position) = slot.detached {
            if !tracked.is_empty() || position > items.len() {
                return Err(policy::RECOVERY.into());
            }
            position
        } else {
            if tracked.len() != 1 {
                return Err(policy::RECOVERY.into());
            }
            tracked[0].0
        };
        if slot.detached.is_none() {
            native::verify_slot(self.app, self.root, *self.native_root, slot, None)?;
        }
        let desired = match role {
            Role::Native => slot.native.id(),
            Role::Enabled => slot.on.id(),
            Role::Disabled => slot.off.id(),
        };
        if tracked.first().map(|(_, item)| item.id()) != Some(desired) {
            if let Some((_, item)) = tracked.first() {
                slot.parent.remove(*item).map_err(|_| policy::RECOVERY)?;
                slot.item_hold.take();
                slot.allow_new_item = false;
                slot.detached = Some(position);
            }
            native::verify_parent(self.app, self.root, *self.native_root, slot)?;
            match role {
                Role::Native => slot.parent.insert(&slot.native, position),
                Role::Enabled => slot.parent.insert(&slot.on, position),
                Role::Disabled => slot.parent.insert(&slot.off, position),
            }
            .map_err(|_| policy::RECOVERY)?;
            slot.detached = None;
            slot.allow_new_item = true;
        }
        native::verify_slot(self.app, self.root, *self.native_root, slot, Some(role))
    }
}
fn with_projection<T>(
    app: &AppHandle,
    state: &mut State,
    action: impl FnOnce(&mut NativeSlots<'_>, &mut roles::Projection) -> Result<T, String>,
) -> Result<T, String> {
    let mut port = NativeSlots {
        app,
        root: &state.root,
        native_root: &mut state.native_root,
        root_hold: &mut state.root_hold,
        slots: &mut state.slots,
    };
    action(&mut port, &mut state.projection)
}
fn access<T>(
    app: &AppHandle,
    action: impl FnOnce(&mut State) -> Result<T, String>,
) -> Result<T, String> {
    if !super::is_original(app) {
        return Err(policy::UNSUPPORTED.into());
    }
    let runtime = app.try_state::<Runtime>().ok_or(policy::RECOVERY)?;
    if runtime.closed.load(std::sync::atomic::Ordering::Acquire) {
        return Err(policy::RECOVERY.into());
    }
    let mut lock = runtime.state.try_lock().ok_or(policy::RECOVERY)?;
    let state = lock.as_mut().ok_or(policy::RECOVERY)?;
    action(state)
}
pub(super) fn refresh(app: &AppHandle) -> Result<(), String> {
    access(app, |state| {
        with_projection(app, state, |port, projection| {
            roles::refresh(port, projection)
        })
    })
}
pub(super) fn read(app: &AppHandle) -> Result<Snapshot, String> {
    super::on_main(app, |app| {
        access(&app, |state| {
            with_projection(&app, state, |port, projection| {
                roles::refresh(port, projection)?;
                Ok(projection.snapshot)
            })
        })
    })
}
pub(super) fn apply(app: &AppHandle, target: bool) -> Result<Snapshot, String> {
    super::on_main(app, move |app| {
        access(&app, |state| {
            with_projection(&app, state, |port, projection| {
                roles::apply(port, projection, target)
            })
        })
    })
}
pub(super) fn restore(app: &AppHandle, before: Snapshot, applied: Snapshot) -> Result<(), String> {
    super::on_main(app, move |app| {
        access(&app, |state| {
            with_projection(&app, state, |port, projection| {
                roles::restore(port, projection, before, applied)
            })
        })
    })
}

pub(super) fn release_readback_holds(app: &AppHandle) -> Result<(), String> {
    super::on_main(app, |app| {
        let runtime = app.try_state::<Runtime>().ok_or(policy::RECOVERY)?;
        let mut state = runtime.state.try_lock().ok_or(policy::RECOVERY)?;
        if let Some(state) = state.as_mut() {
            for slot in &mut state.slots {
                slot.item_hold.take();
                slot.parent_hold.take();
            }
            state.root_hold.take();
        }
        Ok(())
    })
}
