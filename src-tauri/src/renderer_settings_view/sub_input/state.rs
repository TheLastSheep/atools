use std::sync::{Mutex, MutexGuard};

use super::protocol::{ControlRequest, InputAction, MainInputRequest};

pub(crate) const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub(crate) const DEFAULT_PLACEHOLDER: &str = "搜索";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SubInputSnapshot {
    pub(crate) generation: u64,
    pub(crate) revision: u64,
    pub(crate) value_version: u64,
    pub(crate) control_sequence: u64,
    pub(crate) user_sequence: u64,
    pub(crate) visible: bool,
    pub(crate) placeholder: String,
    pub(crate) value: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct SubInputDiagnostics {
    pub(crate) closed: bool,
    pub(crate) visible: bool,
    pub(crate) generation: u64,
    pub(crate) control_sequence: u64,
    pub(crate) user_sequence: u64,
    pub(crate) revision: u64,
    pub(crate) value_version: u64,
    pub(crate) value_bytes: usize,
    pub(crate) placeholder_bytes: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Transition {
    pub(crate) snapshot: SubInputSnapshot,
    pub(crate) action: InputAction,
    pub(crate) focus: bool,
    pub(crate) applied: bool,
    pub(crate) closed: bool,
}

struct Current {
    closed: bool,
    generation: u64,
    revision: u64,
    value_version: u64,
    control_sequence: u64,
    user_sequence: u64,
    visible: bool,
    placeholder: String,
    value: String,
}

pub(crate) struct SubInputBuffer {
    current: Mutex<Current>,
    operation_gate: tokio::sync::Mutex<()>,
}

impl Default for SubInputBuffer {
    fn default() -> Self {
        Self::new()
    }
}

impl SubInputBuffer {
    pub(crate) fn new() -> Self {
        Self {
            current: Mutex::new(Current {
                closed: false,
                generation: 0,
                revision: 1,
                value_version: 0,
                control_sequence: 0,
                user_sequence: 0,
                visible: false,
                placeholder: DEFAULT_PLACEHOLDER.to_owned(),
                value: String::new(),
            }),
            operation_gate: tokio::sync::Mutex::new(()),
        }
    }

    /// Serializes accepted state transitions with their ordered Native delivery.
    pub(crate) async fn serialize_operations(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.operation_gate.lock().await
    }

    pub(crate) fn apply_control(&self, request: &ControlRequest) -> Transition {
        let mut current = self.lock();
        if current.closed {
            return transition(&current, request.action, false, true, false);
        }

        if !valid_control_fence(&current, request) {
            return transition(&current, request.action, false, false, false);
        }
        if matches!(request.action, InputAction::Set | InputAction::Remove) {
            if request.generation <= current.generation {
                return transition(&current, request.action, false, false, false);
            }
        }
        if !matches!(request.action, InputAction::Set | InputAction::Remove)
            && request.generation != current.generation
        {
            return transition(&current, request.action, false, false, false);
        }

        if request.action == InputAction::Focus || request.action == InputAction::Select {
            if !current.visible {
                current.control_sequence = request.sequence;
                return transition(&current, request.action, false, false, false);
            }
        }

        let Some(next_revision) = next_counter(current.revision) else {
            return transition(&current, request.action, false, false, false);
        };

        let next_value_version = if request.action == InputAction::Value {
            let Some(next) = next_counter(current.value_version) else {
                return transition(&current, request.action, false, false, false);
            };
            next
        } else {
            current.value_version
        };

        current.control_sequence = request.sequence;
        current.revision = next_revision;
        current.value_version = next_value_version;

        match request.action {
            InputAction::Set => {
                current.generation = request.generation;
                current.visible = true;
                current.placeholder = request
                    .placeholder
                    .as_deref()
                    .filter(|placeholder| !placeholder.is_empty())
                    .unwrap_or(DEFAULT_PLACEHOLDER)
                    .to_owned();
            }
            InputAction::Remove => {
                current.generation = request.generation;
                current.visible = false;
            }
            InputAction::Value => {
                current.value = request.value.clone().unwrap_or_default();
            }
            InputAction::Focus | InputAction::Select | InputAction::Blur => {}
        }

        transition(
            &current,
            request.action,
            request.action.requests_focus(request.focus),
            false,
            true,
        )
    }

    pub(crate) fn apply_main_input(&self, request: &MainInputRequest) -> Transition {
        let mut current = self.lock();
        if current.closed {
            return transition(&current, InputAction::Value, true, true, false);
        }
        if request.generation != current.generation
            || request.value_version != current.value_version
            || !current.visible
            || request.sequence <= current.user_sequence
        {
            return transition(&current, InputAction::Value, true, false, false);
        }
        let Some(next_revision) = next_counter(current.revision) else {
            return transition(&current, InputAction::Value, true, false, false);
        };

        current.user_sequence = request.sequence;
        current.value = request.text.clone();
        current.revision = next_revision;
        transition(&current, InputAction::Value, true, false, true)
    }

    #[cfg(test)]
    pub(crate) fn snapshot(&self) -> SubInputSnapshot {
        let current = self.lock();
        snapshot(&current)
    }

    pub(crate) fn diagnostics(&self) -> SubInputDiagnostics {
        let current = self.lock();
        SubInputDiagnostics {
            closed: current.closed,
            visible: current.visible,
            generation: current.generation,
            control_sequence: current.control_sequence,
            user_sequence: current.user_sequence,
            revision: current.revision,
            value_version: current.value_version,
            value_bytes: current.value.len(),
            placeholder_bytes: current.placeholder.len(),
        }
    }

    /// Clears session text explicitly so old SessionView Arcs cannot retain it.
    pub(crate) fn close(&self) {
        let mut current = self.lock();
        current.closed = true;
        current.visible = false;
        current.value.clear();
        current.placeholder.clear();
    }

    fn lock(&self) -> MutexGuard<'_, Current> {
        self.current
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn valid_control_fence(current: &Current, request: &ControlRequest) -> bool {
    request.sequence > current.control_sequence
        && request.sequence <= MAX_SAFE_INTEGER
        && request.generation > 0
        && request.generation <= MAX_SAFE_INTEGER
}

fn next_counter(value: u64) -> Option<u64> {
    let next = value.checked_add(1)?;
    (next <= MAX_SAFE_INTEGER).then_some(next)
}

fn snapshot(current: &Current) -> SubInputSnapshot {
    SubInputSnapshot {
        generation: current.generation,
        revision: current.revision,
        value_version: current.value_version,
        control_sequence: current.control_sequence,
        user_sequence: current.user_sequence,
        visible: current.visible,
        placeholder: current.placeholder.clone(),
        value: current.value.clone(),
    }
}

fn transition(
    current: &Current,
    action: InputAction,
    focus: bool,
    closed: bool,
    applied: bool,
) -> Transition {
    Transition {
        snapshot: snapshot(current),
        action,
        focus,
        applied,
        closed,
    }
}
