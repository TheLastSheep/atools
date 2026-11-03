//! Synthetic pages only. No plugin bridge, filesystem capability or network server.
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use tauri::http::{Request, Response};

pub const SCHEME: &str = "atools-origin";
const MAX_REQUESTS: usize = 128;
const CSP: &str = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src atools-origin: about:; connect-src 'self' ipc: http://ipc.localhost; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

pub struct Pages {
    pub parent_host: String,
    pub frames: Vec<Value>,
    hosts: HashMap<String, &'static str>,
    parent: Vec<u8>,
    child: String,
    library: Vec<u8>,
    run_id: String,
    requests: Mutex<Vec<Value>>,
    received: AtomicUsize,
}
impl Pages {
    pub fn new(
        run_id: &str,
        nonce: &str,
        parent: String,
        child: String,
        library: Vec<u8>,
    ) -> Result<Arc<Self>, String> {
        if parent.matches("__ATOOLS_ORIGIN_CONFIG__").count() != 1
            || child.matches("__ATOOLS_ORIGIN_CONFIG__").count() != 1
        {
            return Err("Each synthetic page must have exactly one config slot".into());
        }
        let suffix = run_id.replace('-', "");
        let parent_host = format!("parent-{suffix}.localhost");
        let mut hosts = HashMap::from([(parent_host.clone(), "parent")]);
        let mut frames = Vec::new();
        for id in ["a1", "a2", "b1"] {
            let host = format!("{id}-{suffix}.localhost");
            hosts.insert(host.clone(), id);
            let origin = format!("{SCHEME}://{host}");
            frames.push(json!({"id":id,"host":host,"url":format!("{origin}/index.html"),"expectedOrigin":origin}));
        }
        let config = json!({"runId":run_id,"reportNonce":nonce,"frames":frames,
            "parentExpectedOrigin":format!("{SCHEME}://{parent_host}")});
        let parent = parent
            .replace("__ATOOLS_ORIGIN_CONFIG__", &encode(&config))
            .into_bytes();
        Ok(Arc::new(Self {
            parent_host,
            frames,
            hosts,
            parent,
            child,
            library,
            run_id: run_id.into(),
            requests: Mutex::new(Vec::new()),
            received: AtomicUsize::new(0),
        }))
    }
    pub fn parent_url(&self) -> String {
        format!("{SCHEME}://{}/index.html", self.parent_host)
    }
    pub fn request_evidence(&self) -> Value {
        let received = self.received.load(Ordering::SeqCst);
        json!({"capacity":MAX_REQUESTS,"received":received,"truncated":received>MAX_REQUESTS,"entries":self.requests.lock().clone()})
    }
    pub fn serve(&self, request: Request<Vec<u8>>, window: &str) -> Response<Vec<u8>> {
        let host = request.uri().host().unwrap_or_default();
        let role = self.hosts.get(host).copied();
        let path = request.uri().path();
        self.received.fetch_add(1, Ordering::SeqCst);
        let mut log = self.requests.lock();
        if log.len() < MAX_REQUESTS {
            let origin = request
                .headers()
                .get("origin")
                .and_then(|v| v.to_str().ok());
            let referer = request
                .headers()
                .get("referer")
                .and_then(|v| v.to_str().ok());
            let classified = |v: Option<&str>| match v {
                None => "absent".to_string(),
                Some("null") => "null".to_string(),
                Some(v)
                    if self
                        .hosts
                        .keys()
                        .any(|h| v.starts_with(&format!("{SCHEME}://{h}"))) =>
                {
                    v.chars().take(256).collect()
                }
                Some(_) => "other-present".into(),
            };
            log.push(json!({"role":role.unwrap_or("unknown"),"pathClass":match path {"/index.html"=>"page","/foreign.html"=>"foreign","/html2canvas.js"=>"library",_=>"other"},
                "method":request.method().as_str(),"origin":classified(origin),"referer":classified(referer)}));
        }
        drop(log);
        if window != "origin-fixture"
            || request.uri().scheme_str() != Some(SCHEME)
            || request.method() != "GET"
            || role.is_none()
        {
            return response(403, "text/plain", b"Unavailable".to_vec());
        }
        let role = role.unwrap();
        match (role, path) {
            ("parent", "/index.html") => {
                response(200, "text/html; charset=utf-8", self.parent.clone())
            }
            ("a1" | "a2" | "b1", "/html2canvas.js") => {
                response(200, "text/javascript; charset=utf-8", self.library.clone())
            }
            ("a1" | "a2" | "b1", "/index.html") | ("b1", "/foreign.html") => {
                let foreign = path == "/foreign.html";
                let own_index = match role {
                    "a1" => 0,
                    "a2" => 1,
                    _ => 2,
                };
                let peers: Vec<_> = (0..3).filter(|index| *index != own_index).collect();
                let config = json!({"runId":self.run_id,"id":if foreign {"a1"} else {role},
                    "peerIndexes":peers,"foreign":foreign,"claimedId":"a1"});
                response(
                    200,
                    "text/html; charset=utf-8",
                    self.child
                        .replace("__ATOOLS_ORIGIN_CONFIG__", &encode(&config))
                        .into_bytes(),
                )
            }
            _ => response(404, "text/plain", b"Unavailable".to_vec()),
        }
    }
}
fn encode(value: &Value) -> String {
    value.to_string().replace('<', "\\u003c")
}
fn response(status: u16, mime: &str, bytes: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("content-type", mime)
        .header("content-security-policy", CSP)
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .body(bytes)
        .unwrap()
}
