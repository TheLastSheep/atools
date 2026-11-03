//! Optional current-thread CPU clock for integration-test diagnostics.
//! CPU samples are taken outside the wall-clock intervals in the test cases.

#[cfg(target_os = "macos")]
fn current_thread_cpu_ns() -> Option<u128> {
    use std::ffi::{c_int, c_long};

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
    // CLOCK_THREAD_CPUTIME_ID is 16 in the macOS SDK used by the repository host.
    // SAFETY: value is a valid writable timespec with the platform C layout.
    let status = unsafe { clock_gettime(16, &mut value) };
    if status != 0 || value.tv_sec < 0 || !(0..1_000_000_000).contains(&value.tv_nsec) {
        return None;
    }
    Some(value.tv_sec as u128 * 1_000_000_000 + value.tv_nsec as u128)
}

#[cfg(not(target_os = "macos"))]
fn current_thread_cpu_ns() -> Option<u128> {
    None
}

pub fn start_ns() -> Option<u128> {
    current_thread_cpu_ns()
}

/// Call only after the paired wall `Instant::elapsed()` value has been saved.
pub fn elapsed_ns(start: Option<u128>) -> Option<u128> {
    let start = start?;
    current_thread_cpu_ns()?.checked_sub(start)
}

pub fn display(value: Option<u128>) -> String {
    value.map_or_else(|| "unavailable".to_owned(), |ns| ns.to_string())
}
