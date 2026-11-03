//! Pure edge detector. Owners must reset it when monitoring stops or loses continuity.
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Modifier {
    Command,
    Control,
    Alt,
    Shift,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Side {
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PhysicalModifier {
    pub(crate) modifier: Modifier,
    pub(crate) side: Side,
}

impl PhysicalModifier {
    fn bit(self) -> u8 {
        1 << (self.modifier as u8 * 2 + self.side as u8)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InputEdge {
    ModifierDown(PhysicalModifier),
    ModifierUp(PhysicalModifier),
    OtherKeyDown,
    OtherKeyUp,
    Reset,
}

#[derive(Debug, Default)]
pub(crate) struct DoubleTapDetector {
    pressed: u8,
    down: u8,
    modifier_down_time: Option<Duration>,
    non_modifier_pressed: bool,
    last_up: Option<(Modifier, Duration)>,
    last_observed: Option<Duration>,
}

impl DoubleTapDetector {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn reset(&mut self) {
        *self = Self::default();
    }

    /// `now` is time since a monotonic owner epoch, never wall-clock time.
    /// A rollback discards the edge as well as history: an unknown down/up
    /// cannot manufacture a complete tap after the continuity break.
    pub(crate) fn observe(&mut self, edge: InputEdge, now: Duration) -> Option<Modifier> {
        if edge == InputEdge::Reset {
            self.reset();
            return None;
        }
        if self.last_observed.is_some_and(|last| now < last) {
            self.reset();
            return None;
        }
        self.last_observed = Some(now);
        match edge {
            InputEdge::ModifierDown(key) => {
                if self.pressed & key.bit() == 0 {
                    self.down |= key.bit();
                }
                // Match upstream's shared clock, including observed overlapping sides.
                if self.modifier_down_time.is_none() {
                    self.modifier_down_time = Some(now);
                }
                self.pressed |= key.bit();
                None
            }
            InputEdge::ModifierUp(key) => {
                let was_pressed = self.pressed & key.bit() != 0;
                self.pressed &= !key.bit();
                let observed_down = self.down & key.bit() != 0;
                self.down &= !key.bit();
                let started = self.modifier_down_time.take();
                if !was_pressed || !observed_down {
                    self.down = 0;
                    self.last_up = None;
                    return None;
                }
                if started.is_some_and(|started| now - started > Duration::from_millis(300)) {
                    self.last_up = None;
                    return None;
                }
                if self.non_modifier_pressed {
                    self.non_modifier_pressed = false;
                    self.last_up = None;
                    return None;
                }
                if self.last_up.is_some_and(|(modifier, released)| {
                    modifier == key.modifier && now - released < Duration::from_millis(400)
                }) {
                    self.last_up = None;
                    return Some(key.modifier);
                }
                self.last_up = Some((key.modifier, now));
                None
            }
            InputEdge::OtherKeyDown => {
                self.non_modifier_pressed = true;
                self.last_up = None;
                None
            }
            InputEdge::OtherKeyUp => {
                self.non_modifier_pressed = false;
                self.modifier_down_time = None;
                None
            }
            InputEdge::Reset => unreachable!(),
        }
    }
}

#[cfg(test)]
#[path = "double_tap_tests.rs"]
mod tests;
