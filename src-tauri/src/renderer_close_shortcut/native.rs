//! Read AppKit roles through freshly verified logical ownership and current indexes.
use super::{
    menu::Slot,
    policy,
    roles::{self, Action, Modifiers, Role},
};
use objc2::{msg_send, rc::Retained, runtime::AnyObject, sel, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSEventModifierFlags};
use objc2_foundation::NSString;
use tauri::{menu::Menu, AppHandle, Wry};

/// Retains the native object while its address is used as identity, preventing ABA.
/// A non-main Drop dispatches the owned +1 back to the native thread.
pub(super) struct Instance {
    pointer: usize,
    app: AppHandle,
}
impl Instance {
    fn retain(app: &AppHandle, object: &Retained<AnyObject>) -> Self {
        Self {
            pointer: Retained::into_raw(object.clone()) as usize,
            app: app.clone(),
        }
    }
    pub(super) fn address(&self) -> usize {
        self.pointer
    }
}
impl Drop for Instance {
    fn drop(&mut self) {
        let pointer = self.pointer;
        let release = move || unsafe {
            drop(Retained::from_raw(pointer as *mut AnyObject));
        };
        if MainThreadMarker::new().is_some() {
            release();
        } else if self.app.run_on_main_thread(release).is_err() {
            tracing::warn!("Native menu identity retained after event-loop shutdown");
        }
    }
}
pub(super) fn hold_root(app: &AppHandle, owned: &Menu<Wry>) -> Result<Instance, String> {
    Ok(Instance::retain(app, &root(app, owned)?))
}

fn application() -> Result<Retained<NSApplication>, String> {
    Ok(NSApplication::sharedApplication(
        MainThreadMarker::new().ok_or(policy::RECOVERY)?,
    ))
}
fn root(app: &AppHandle, owned: &Menu<Wry>) -> Result<Retained<AnyObject>, String> {
    if app.menu().is_none_or(|menu| menu.id() != owned.id()) {
        return Err(policy::RECOVERY.into());
    }
    let application = application()?;
    let root: Option<Retained<AnyObject>> = unsafe { msg_send![&*application, mainMenu] };
    root.ok_or_else(|| policy::RECOVERY.into())
}
pub(super) fn root_pointer(app: &AppHandle, owned: &Menu<Wry>) -> Result<usize, String> {
    Ok(Retained::as_ptr(&root(app, owned)?) as usize)
}
fn item(menu: &AnyObject, index: usize) -> Result<Retained<AnyObject>, String> {
    let count: isize = unsafe { msg_send![menu, numberOfItems] };
    if index >= count.max(0) as usize {
        return Err(policy::RECOVERY.into());
    }
    let item: Option<Retained<AnyObject>> = unsafe { msg_send![menu,itemAtIndex:index as isize] };
    item.ok_or_else(|| policy::RECOVERY.into())
}
pub(super) fn verify_parent(
    app: &AppHandle,
    owned: &Menu<Wry>,
    expected_root: usize,
    slot: &mut Slot,
) -> Result<Retained<AnyObject>, String> {
    let root = root(app, owned)?;
    if expected_root != 0 && Retained::as_ptr(&root) as usize != expected_root {
        return Err(policy::RECOVERY.into());
    }
    let roots = owned.items().map_err(|_| policy::RECOVERY)?;
    let parents: Vec<_> = roots
        .iter()
        .enumerate()
        .filter(|(_, entry)| entry.id() == slot.parent.id())
        .collect();
    if parents.len() != 1 {
        return Err(policy::RECOVERY.into());
    }
    let parent_item = item(&root, parents[0].0)?;
    let parent: Option<Retained<AnyObject>> = unsafe { msg_send![&*parent_item, submenu] };
    let parent = parent.ok_or(policy::RECOVERY)?;
    let pointer = Retained::as_ptr(&parent) as usize;
    if slot.native_parent != 0 && slot.native_parent != pointer {
        return Err(policy::RECOVERY.into());
    }
    if !super::instance_identity::accepts(
        slot.parent_hold.as_ref().map(Instance::address),
        pointer,
        slot.native_parent == 0,
    ) {
        return Err(policy::RECOVERY.into());
    }
    if slot.parent_hold.is_none() {
        slot.parent_hold = Some(Instance::retain(app, &parent));
    }
    slot.native_parent = pointer;
    Ok(parent)
}
pub(super) fn verify_slot(
    app: &AppHandle,
    owned: &Menu<Wry>,
    expected_root: usize,
    slot: &mut Slot,
    expected: Option<Role>,
) -> Result<Role, String> {
    let parent = verify_parent(app, owned, expected_root, slot)?;
    let items = slot.parent.items().map_err(|_| policy::RECOVERY)?;
    let roles: Vec<_> = items
        .iter()
        .enumerate()
        .filter(|(_, entry)| {
            entry.id() == slot.native.id()
                || entry.id() == slot.on.id()
                || entry.id() == slot.off.id()
        })
        .collect();
    if roles.len() != 1 {
        return Err(policy::RECOVERY.into());
    }
    let (_, role) = roles[0];
    let is_native = role.id() == slot.native.id();
    let is_on = role.id() == slot.on.id();
    let role = if is_native {
        Role::Native
    } else if is_on {
        Role::Enabled
    } else {
        Role::Disabled
    };
    if expected.is_some_and(|expected| expected != role) {
        return Err(policy::RECOVERY.into());
    }
    let native = item(&parent, roles[0].0)?;
    let pointer = Retained::as_ptr(&native) as usize;
    if !super::instance_identity::accepts(
        slot.item_hold.as_ref().map(Instance::address),
        pointer,
        slot.allow_new_item,
    ) {
        return Err(policy::RECOVERY.into());
    }
    let action: Option<objc2::runtime::Sel> = unsafe { msg_send![&*native, action] };
    let key: Retained<NSString> = unsafe { msg_send![&*native, keyEquivalent] };
    let flags: NSEventModifierFlags = unsafe { msg_send![&*native, keyEquivalentModifierMask] };
    let action = if action == Some(sel!(performClose:)) {
        Action::Native
    } else if action == Some(sel!(fireMenuItemAction:)) {
        Action::Custom
    } else {
        Action::Other
    };
    let modifiers = if flags == NSEventModifierFlags::Command {
        Modifiers::Command
    } else if flags.is_empty() {
        Modifiers::Empty
    } else {
        Modifiers::Other
    };
    if !roles::matches_readback(role, action, &key.to_string(), modifiers) {
        return Err(policy::RECOVERY.into());
    }
    if slot.item_hold.is_none() {
        slot.item_hold = Some(Instance::retain(app, &native));
    }
    slot.allow_new_item = false;
    let current_parent = verify_parent(app, owned, expected_root, slot)?;
    if Retained::as_ptr(&current_parent) != Retained::as_ptr(&parent) {
        return Err(policy::RECOVERY.into());
    }
    Ok(role)
}

pub(super) fn perform_native_close() -> Result<(), String> {
    let application = application()?;
    let _: bool = unsafe {
        msg_send![&*application,sendAction:sel!(performClose:),to:std::ptr::null::<AnyObject>(),from:std::ptr::null::<AnyObject>()]
    };
    Ok(())
}

pub(super) fn key_window() -> Result<usize, String> {
    let application = application()?;
    let window: Option<Retained<AnyObject>> = unsafe { msg_send![&*application, keyWindow] };
    Ok(window
        .as_ref()
        .map_or(0, |window| Retained::as_ptr(window) as usize))
}
