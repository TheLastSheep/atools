//! Event-time decoder: no key-state polling and no guessed device flag bits.
use super::double_tap::{DoubleTapDetector, InputEdge, Modifier, PhysicalModifier, Side};
use std::time::Duration;

#[derive(Default)]
pub(super) struct InputState {
    detector: DoubleTapDetector,
    synchronized: bool,
    modifiers: u8,
    others: [u64; 4],
    last: Option<Duration>,
    lost: bool,
}
impl InputState {
    pub(super) fn reset(&mut self) {
        self.detector.reset();
        self.synchronized = false;
        self.modifiers = 0;
        self.others = [0; 4];
        self.last = None;
        self.lost = true;
    }
    pub(super) fn take_lost(&mut self) -> bool {
        std::mem::take(&mut self.lost)
    }
    pub(super) fn establish(&mut self, held: [u64; 4]) {
        self.reset();
        self.lost = false;
        self.others = held;
        self.synchronized = held.iter().all(|bits| *bits == 0);
    }
    pub(super) fn observe(
        &mut self,
        kind: u32,
        key: u16,
        groups: u8,
        time: Duration,
    ) -> Option<Modifier> {
        if self.last.is_some_and(|last| time < last) {
            self.reset();
        }
        self.last = Some(time);
        if key >= 128 {
            self.reset();
            return None;
        }
        let bit = 1u64 << (key % 64);
        let index = key as usize / 64;
        if !self.synchronized {
            if kind == 11 {
                self.others[index] &= !bit;
            } else if kind == 10 {
                self.others[index] |= bit;
            } else if kind == 12 {
                if let Some(physical) = physical_modifier(key) {
                    let group = 1 << (physical.modifier as u8);
                    if groups & group == 0 {
                        for code in 0..256 {
                            if physical_modifier(code)
                                .is_some_and(|p| p.modifier == physical.modifier)
                            {
                                self.others[code as usize / 64] &= !(1u64 << (code % 64));
                            }
                        }
                    } else {
                        self.others[index] ^= bit;
                    }
                } else {
                    self.reset();
                    return None;
                }
            }
            if groups == 0 && self.others.iter().all(|bits| *bits == 0) {
                self.synchronized = true;
            }
            return None;
        }
        if kind == 10 || kind == 11 {
            if kind == 10 {
                self.others[index] |= bit;
            } else {
                self.others[index] &= !bit;
            }
            self.detector.observe(
                if kind == 10 {
                    InputEdge::OtherKeyDown
                } else {
                    InputEdge::OtherKeyUp
                },
                time,
            );
            return None;
        }
        if kind != 12 {
            return None;
        }
        let Some(physical) = physical_modifier(key) else {
            self.reset();
            return None;
        };
        let physical_bit = 1 << (physical.modifier as u8 * 2 + physical.side as u8);
        let down = self.modifiers & physical_bit == 0;
        self.modifiers ^= physical_bit;
        let projected = (0..4).fold(0u8, |flags, modifier| {
            flags
                | if self.modifiers & (3 << (modifier * 2)) != 0 {
                    1 << modifier
                } else {
                    0
                }
        });
        if projected != groups {
            self.reset();
            return None;
        }
        self.detector.observe(
            if down {
                InputEdge::ModifierDown(physical)
            } else {
                InputEdge::ModifierUp(physical)
            },
            time,
        )
    }
}
// Carbon/HIToolbox Events.h kVK_* declarations, not CGEvent device flag bits.
pub(super) fn physical_modifier(key: u16) -> Option<PhysicalModifier> {
    const KVK_COMMAND: u16 = 0x37;
    const KVK_RIGHT_COMMAND: u16 = 0x36;
    const KVK_CONTROL: u16 = 0x3b;
    const KVK_RIGHT_CONTROL: u16 = 0x3e;
    const KVK_OPTION: u16 = 0x3a;
    const KVK_RIGHT_OPTION: u16 = 0x3d;
    const KVK_SHIFT: u16 = 0x38;
    const KVK_RIGHT_SHIFT: u16 = 0x3c;
    let (modifier, side) = match key {
        KVK_COMMAND => (Modifier::Command, Side::Left),
        KVK_RIGHT_COMMAND => (Modifier::Command, Side::Right),
        KVK_CONTROL => (Modifier::Control, Side::Left),
        KVK_RIGHT_CONTROL => (Modifier::Control, Side::Right),
        KVK_OPTION => (Modifier::Alt, Side::Left),
        KVK_RIGHT_OPTION => (Modifier::Alt, Side::Right),
        KVK_SHIFT => (Modifier::Shift, Side::Left),
        KVK_RIGHT_SHIFT => (Modifier::Shift, Side::Right),
        _ => return None,
    };
    Some(PhysicalModifier { modifier, side })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn send(state: &mut InputState, kind: u32, key: u16, flags: u8, ms: u64) -> Option<Modifier> {
        state.observe(kind, key, flags, Duration::from_millis(ms))
    }
    #[test]
    fn initial_held_and_flags_discontinuity_never_manufacture_taps() {
        let mut state = InputState::default();
        assert_eq!(send(&mut state, 12, 0x37, 1, 1), None);
        assert_eq!(send(&mut state, 12, 0x37, 0, 2), None);
        assert_eq!(send(&mut state, 12, 0x37, 1, 10), None);
        assert_eq!(send(&mut state, 12, 0x37, 0, 20), None);
        assert_eq!(send(&mut state, 12, 0x37, 1, 30), None);
        assert_eq!(send(&mut state, 12, 0x37, 0, 40), Some(Modifier::Command));
        assert_eq!(send(&mut state, 12, 0x37, 0, 50), None);
        assert!(!state.synchronized);
    }
    #[test]
    fn initial_snapshot_held_keys_must_drain_before_detection() {
        let mut state = InputState::default();
        let mut held = [0; 4];
        held[0] = 1;
        state.establish(held);
        for (time, flags) in [(10, 1), (20, 0), (30, 1), (40, 0)] {
            assert_eq!(send(&mut state, 12, 0x37, flags, time), None);
        }
        assert!(!state.synchronized);
        send(&mut state, 11, 0, 0, 50);
        assert!(state.synchronized);
    }
    #[test]
    fn r73_initial_fn_or_caps_release_requests_event_driven_rebaseline() {
        for key in [0x3f, 0x39] {
            let mut state = InputState::default();
            let mut held = [0; 4];
            held[key / 64] = 1 << (key % 64);
            state.establish(held);
            assert_eq!(send(&mut state, 12, key as u16, 0, 1), None);
            assert!(
                state.take_lost(),
                "unmapped modifier release must request a new snapshot"
            );
            state.establish([0; 4]);
            for (time, flags) in [(10, 1), (20, 0), (30, 1)] {
                assert_eq!(send(&mut state, 12, 0x37, flags, time), None);
            }
            assert_eq!(send(&mut state, 12, 0x37, 0, 40), Some(Modifier::Command));
        }
    }
}

pub(super) fn snapshot(mut key_down: impl FnMut(u16) -> bool) -> [u64; 4] {
    let mut held = [0; 4];
    for key in 0..128u16 {
        if key_down(key) {
            held[key as usize / 64] |= 1u64 << (key % 64);
        }
    }
    held
}
