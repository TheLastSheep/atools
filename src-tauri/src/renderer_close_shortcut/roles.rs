//! Three prebuilt roles avoid muda0.19.2's native None-accelerator clearing bug.
use super::{policy, Snapshot};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Role {
    Native,
    Enabled,
    Disabled,
}
pub(super) trait Port {
    fn focused_main(&mut self) -> bool;
    /// Selects only an owned slot and returns its actual native readback.
    fn select(&mut self, index: usize, role: Role) -> Result<Role, String>;
}
pub(super) struct Projection {
    pub(super) snapshot: Snapshot,
    pub(super) known: bool,
}
pub(super) fn role(main: bool, enabled: bool) -> Role {
    if !main {
        Role::Native
    } else if enabled {
        Role::Enabled
    } else {
        Role::Disabled
    }
}
fn project(port: &mut impl Port, enabled: bool) -> Result<(), String> {
    for _ in 0..2 {
        let main = port.focused_main();
        let desired = role(main, enabled);
        for index in 0..2 {
            if port.select(index, desired)? != desired {
                return Err(policy::RECOVERY.into());
            }
        }
        if port.focused_main() == main {
            return Ok(());
        }
    }
    Err(policy::RECOVERY.into())
}
pub(super) fn refresh(port: &mut impl Port, state: &mut Projection) -> Result<(), String> {
    if !state.known {
        return Err(policy::RECOVERY.into());
    }
    if let Err(error) = project(port, state.snapshot.enabled) {
        state.known = false;
        return Err(error);
    }
    Ok(())
}
pub(super) fn apply(
    port: &mut impl Port,
    state: &mut Projection,
    target: bool,
) -> Result<Snapshot, String> {
    refresh(port, state)?;
    let before = state.snapshot;
    let candidate = Snapshot {
        enabled: target,
        generation: before.generation.checked_add(1).ok_or(policy::REJECTED)?,
    };
    if project(port, target).is_ok() {
        state.snapshot = candidate;
        return Ok(candidate);
    }
    if project(port, before.enabled).is_ok() {
        Err(policy::REJECTED.into())
    } else {
        state.known = false;
        Err(policy::RECOVERY.into())
    }
}
pub(super) fn restore(
    port: &mut impl Port,
    state: &mut Projection,
    before: Snapshot,
    applied: Snapshot,
) -> Result<(), String> {
    if state.snapshot != applied || before.generation.checked_add(1) != Some(applied.generation) {
        return Err(policy::RECOVERY.into());
    }
    match project(port, before.enabled) {
        Ok(()) => {
            state.snapshot = Snapshot {
                enabled: before.enabled,
                generation: applied.generation.checked_add(1).ok_or(policy::RECOVERY)?,
            };
            state.known = true;
            Ok(())
        }
        Err(error) => {
            state.known = false;
            Err(error)
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Action {
    Native,
    Custom,
    Other,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Modifiers {
    Command,
    Empty,
    Other,
}
pub(super) fn matches_readback(
    role: Role,
    action: Action,
    key: &str,
    modifiers: Modifiers,
) -> bool {
    match role {
        Role::Native => action == Action::Native && key == "w" && modifiers == Modifiers::Command,
        Role::Enabled => action == Action::Custom && key == "w" && modifiers == Modifiers::Command,
        Role::Disabled => {
            action == Action::Custom && key.is_empty() && modifiers == Modifiers::Empty
        }
    }
}
#[cfg(test)]
#[path = "roles_tests.rs"]
mod tests;
