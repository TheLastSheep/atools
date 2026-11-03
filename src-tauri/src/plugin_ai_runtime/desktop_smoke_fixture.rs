//! Bounded local OpenAI-compatible SSE peer for the opt-in native AI smoke.
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use tokio::sync::mpsc as async_mpsc;

const MAX_REQUESTS: usize = 4;
const MAX_HEADERS: usize = 16 * 1024;
const MAX_BODY: usize = 64 * 1024;
pub(super) const PROMPTS: [&str; MAX_REQUESTS] = [
    "native fixture stream prompt",
    "native fixture collect prompt",
    "native fixture ack prompt",
    "native fixture no-delta prompt",
];
// Together these fields exceed the complete 16 KiB Channel-envelope budget
// before native fragmentation, matching the dual-field regression boundary.
pub(super) const FIRST_PART_CHARS: usize = 8_161;
pub(super) const FINAL_CONTENT: &str = "fixture-content-final";

#[derive(Default)]
struct Summary {
    requests: usize,
    valid_requests: usize,
    closed_stall: bool,
    extra_requests: usize,
}

pub(super) struct LoopbackFixture {
    address: SocketAddr,
    stop: Arc<AtomicBool>,
    release: Sender<()>,
    summary: Arc<Mutex<Summary>>,
    thread: Option<JoinHandle<()>>,
}

impl LoopbackFixture {
    pub fn start(events: async_mpsc::Sender<Value>) -> Result<Self, String> {
        let listener =
            TcpListener::bind(("127.0.0.1", 0)).map_err(|_| "Local AI fixture bind failed")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "Local AI fixture listener setup failed")?;
        let address = listener
            .local_addr()
            .map_err(|_| "Local AI fixture address unavailable")?;
        let stop = Arc::new(AtomicBool::new(false));
        let summary = Arc::new(Mutex::new(Summary::default()));
        let worker_stop = stop.clone();
        let worker_summary = summary.clone();
        let (release, release_rx) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("atools-ai-fixture".into())
            .spawn(move || {
                serve(listener, events, worker_stop, worker_summary, release_rx);
            })
            .map_err(|_| "Local AI fixture thread failed")?;
        Ok(Self {
            address,
            stop,
            release,
            summary,
            thread: Some(thread),
        })
    }

    pub fn base_url(&self) -> String {
        format!("http://{}/v1", self.address)
    }

    pub fn release_stall(&self) {
        let _ = self.release.send(());
    }

    pub fn stop(mut self) -> Result<Value, String> {
        self.stop.store(true, Ordering::Release);
        self.release_stall();
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_millis(200));
        if self
            .thread
            .take()
            .is_some_and(|thread| thread.join().is_err())
        {
            return Err("Local AI fixture did not stop cleanly".into());
        }
        let summary = self
            .summary
            .lock()
            .map_err(|_| "Local AI fixture summary unavailable")?;
        Ok(
            json!({"requests":summary.requests,"validRequests":summary.valid_requests,
            "noDeltaConnectionClosed":summary.closed_stall,"extraRequests":summary.extra_requests}),
        )
    }
}

impl Drop for LoopbackFixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.release.send(());
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_millis(200));
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn serve(
    listener: TcpListener,
    events: async_mpsc::Sender<Value>,
    stop: Arc<AtomicBool>,
    summary: Arc<Mutex<Summary>>,
    release: Receiver<()>,
) {
    while !stop.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let index = summary
                    .lock()
                    .map(|mut state| {
                        let index = state.requests;
                        state.requests = state.requests.saturating_add(1);
                        index
                    })
                    .unwrap_or(MAX_REQUESTS);
                if index >= MAX_REQUESTS {
                    if let Ok(mut state) = summary.lock() {
                        state.extra_requests += 1;
                    }
                    respond(&mut stream, 429, "text/plain", b"fixture limit");
                    continue;
                }
                let (valid, authorized) = inspect_request(&mut stream, index);
                if valid && authorized {
                    if let Ok(mut state) = summary.lock() {
                        state.valid_requests += 1;
                    }
                }
                let _ = events.blocking_send(json!({"stage":"provider_request","index":index,
                    "requestValid":valid,"fixtureAuthorization":authorized}));
                if !valid || !authorized {
                    respond(&mut stream, 400, "text/plain", b"fixture request rejected");
                } else if index == 3 {
                    let closed = wait_for_client_close(&mut stream, &stop, &release);
                    if let Ok(mut state) = summary.lock() {
                        state.closed_stall = closed;
                    }
                } else {
                    let body = sse_body();
                    respond(&mut stream, 200, "text/event-stream", &body);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(_) => thread::sleep(Duration::from_millis(20)),
        }
    }
}

fn sse_body() -> Vec<u8> {
    let first = json!({"choices":[{"delta":{
        "content":"c".repeat(FIRST_PART_CHARS),
        "reasoning_content":"r".repeat(FIRST_PART_CHARS)
    },"finish_reason":null}]});
    let mut body = b"data: ".to_vec();
    if let Ok(encoded) = serde_json::to_vec(&first) {
        body.extend_from_slice(&encoded);
    }
    body.extend_from_slice(b"\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"fixture-content-final\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n");
    body
}

fn inspect_request(stream: &mut TcpStream, index: usize) -> (bool, bool) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let Some((headers, body)) = read_request(stream) else {
        return (false, false);
    };
    let mut lines = headers.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let authorization = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("authorization")
            .then(|| value.trim())
    });
    let authorized = authorization == Some("Bearer fixture-only-not-a-real-key");
    let parsed = serde_json::from_slice::<Value>(&body).ok();
    let valid = request_line == "POST /v1/chat/completions HTTP/1.1"
        && parsed.as_ref().is_some_and(|payload| {
            payload["model"] == "fixture-model"
                && payload["stream"] == true
                && payload["messages"][0]["content"] == PROMPTS[index]
        });
    (valid, authorized)
}

fn read_request(stream: &mut TcpStream) -> Option<(String, Vec<u8>)> {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 2048];
    let (header_end, body_len) = loop {
        if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            let header_end = end + 4;
            if header_end > MAX_HEADERS {
                return None;
            }
            let headers = std::str::from_utf8(&bytes[..end]).ok()?;
            let length = headers.split("\r\n").find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })?;
            if length > MAX_BODY {
                return None;
            }
            if bytes.len() >= header_end + length {
                break (header_end, length);
            }
        }
        if bytes.len() >= MAX_HEADERS + MAX_BODY {
            return None;
        }
        let count = stream.read(&mut chunk).ok()?;
        if count == 0 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..count]);
    };
    let header = std::str::from_utf8(&bytes[..header_end - 4])
        .ok()?
        .to_owned();
    let body = bytes[header_end..header_end + body_len].to_vec();
    Some((header, body))
}

fn wait_for_client_close(
    stream: &mut TcpStream,
    stop: &AtomicBool,
    release: &Receiver<()>,
) -> bool {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
    let mut byte = [0_u8; 1];
    loop {
        if stop.load(Ordering::Acquire) || release.try_recv().is_ok() {
            return false;
        }
        match stream.read(&mut byte) {
            Ok(0) => return true,
            Ok(_) => return false,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::Interrupted
                ) => {}
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => return true,
            Err(_) => return false,
        }
    }
}

fn respond(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) {
    let reason = if status == 200 {
        "OK"
    } else if status == 429 {
        "Too Many Requests"
    } else {
        "Bad Request"
    };
    let header = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    let _ = stream
        .write_all(header.as_bytes())
        .and_then(|_| stream.write_all(body));
    let _ = stream.flush();
}
