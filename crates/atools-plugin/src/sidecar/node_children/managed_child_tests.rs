use super::OutputStream;
use super::{queue_close_if_ready, queue_exit_event, stream_error_event, ExitInfo};
use std::collections::VecDeque;

#[test]
fn exit_is_immediate_and_stream_error_stays_before_close() {
    let mut events = VecDeque::new();
    let mut close_queued = false;
    let exit = ExitInfo {
        code: Some(1),
        signal: None,
    };

    queue_exit_event(42, &exit, &mut events);
    assert_eq!(events.len(), 1, "exit does not wait for stdio to close");
    assert_eq!(events.front().unwrap()["event"], "exit");
    events.push_back(stream_error_event(42, OutputStream::Stdout, "read failed"));

    queue_close_if_ready(
        42,
        Some(&exit),
        false,
        false,
        true,
        &mut close_queued,
        &mut events,
    );
    assert!(!close_queued);
    assert_eq!(events.len(), 2);
    assert_eq!(events[1]["childId"], "42");
    assert_eq!(events[1]["error"]["code"], "ERR_ATOOLS_CHILD_OUTPUT_READ");

    queue_close_if_ready(
        42,
        Some(&exit),
        true,
        true,
        true,
        &mut close_queued,
        &mut events,
    );
    assert!(close_queued);
    assert_eq!(events.len(), 3);
    assert_eq!(events.pop_front().unwrap()["event"], "exit");
    assert_eq!(events.pop_front().unwrap()["event"], "streamError");
    assert_eq!(events.pop_front().unwrap()["event"], "close");
}
