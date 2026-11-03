//! Test-only, opt-in clocks around the actual media query. No production telemetry.
use std::{cell::RefCell, io, time::Instant};

const MAX_CHECKPOINTS: usize = 16;

#[derive(Clone, Copy)]
pub(in crate::matcher) struct Reading {
    wall: Instant,
    cpu_ns: u128,
}

#[derive(Clone, Copy, Debug)]
pub(in crate::matcher) struct Elapsed {
    pub(in crate::matcher) wall_ns: u128,
    pub(in crate::matcher) cpu_ns: u128,
}

impl Reading {
    pub(in crate::matcher) fn now() -> io::Result<Self> {
        // Adjacent clocks bracket the same operation, with a measured clock-pair skew.
        let wall = Instant::now();
        let cpu_ns = thread_cpu_ns()?;
        Ok(Self { wall, cpu_ns })
    }

    pub(in crate::matcher) fn since(self, earlier: Self) -> io::Result<Elapsed> {
        Ok(Elapsed {
            wall_ns: self.wall.duration_since(earlier.wall).as_nanos(),
            cpu_ns: self
                .cpu_ns
                .checked_sub(earlier.cpu_ns)
                .ok_or_else(|| io::Error::other("thread CPU clock moved backwards"))?,
        })
    }
}

#[cfg(target_os = "macos")]
fn thread_cpu_ns() -> io::Result<u128> {
    use std::ffi::{c_int, c_long};
    // Local SDK _time.h: clockid_t enum value 16; _timespec.h and arm/_types.h:
    // timespec = { __darwin_time_t(long), long }. Kept entirely in cfg(test).
    #[repr(C)]
    struct Timespec {
        tv_sec: c_long,
        tv_nsec: c_long,
    }
    unsafe extern "C" {
        fn clock_gettime(clock_id: c_int, value: *mut Timespec) -> c_int;
    }
    let mut value = Timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: initialized writable timespec with the SDK C layout and a valid clock ID.
    let status = unsafe { clock_gettime(16, &mut value) };
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    if value.tv_sec < 0 || !(0..1_000_000_000).contains(&value.tv_nsec) {
        return Err(io::Error::other("invalid thread CPU timespec"));
    }
    Ok(value.tv_sec as u128 * 1_000_000_000 + value.tv_nsec as u128)
}

#[cfg(not(target_os = "macos"))]
fn thread_cpu_ns() -> io::Result<u128> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "diagnostic clock is macOS-only",
    ))
}

struct Buffer {
    checkpoints: Vec<(&'static str, Reading)>,
    error: Option<io::Error>,
}

thread_local! {
    static ACTIVE: RefCell<Option<Buffer>> = const { RefCell::new(None) };
}

pub(super) fn checkpoint(label: &'static str) {
    ACTIVE.with(|active| {
        let mut active = active.borrow_mut();
        let Some(buffer) = active.as_mut() else {
            return;
        };
        if buffer.error.is_some() {
            return;
        }
        if buffer.checkpoints.len() == MAX_CHECKPOINTS {
            buffer.error = Some(io::Error::other("diagnostic checkpoint capacity exceeded"));
            return;
        }
        match Reading::now() {
            Ok(reading) => buffer.checkpoints.push((label, reading)),
            Err(error) => buffer.error = Some(error),
        }
    });
}

pub(in crate::matcher) struct Trace {
    pub(in crate::matcher) elapsed: Elapsed,
    pub(in crate::matcher) segments: Vec<(&'static str, Elapsed)>,
}

pub(in crate::matcher) fn capture<T>(operation: impl FnOnce() -> T) -> io::Result<(T, Trace)> {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            ACTIVE.with(|active| {
                active.borrow_mut().take();
            });
        }
    }
    ACTIVE.with(|active| {
        let mut active = active.borrow_mut();
        assert!(active.is_none(), "diagnostic captures cannot nest");
        *active = Some(Buffer {
            checkpoints: Vec::with_capacity(MAX_CHECKPOINTS),
            error: None,
        });
    });
    let _reset = Reset;
    let started = Reading::now()?;
    let result = operation();
    let finished = Reading::now()?;
    let buffer = ACTIVE.with(|active| active.borrow_mut().take().unwrap());
    if let Some(error) = buffer.error {
        return Err(error);
    }
    let mut previous = started;
    let mut segments = Vec::with_capacity(buffer.checkpoints.len() + 1);
    for (label, reading) in buffer.checkpoints {
        segments.push((label, reading.since(previous)?));
        previous = reading;
    }
    segments.push(("query_return", finished.since(previous)?));
    Ok((
        result,
        Trace {
            elapsed: finished.since(started)?,
            segments,
        },
    ))
}

#[cfg(target_os = "macos")]
#[path = "media_query_diagnostics_tests.rs"]
mod tests;
