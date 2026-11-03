//! One-use synthetic bootstrap documents. GET headers never grant capabilities.
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tauri::http::{Request, Response};

pub const SCHEME: &str = "atools-origin";
const MAX_REQUESTS: usize = 96;
struct Page {
    id: &'static str,
    host: String,
    path: String,
    body: Vec<u8>,
    consumed: bool,
}
pub struct Pages {
    pub frames: Vec<Value>,
    parent_host: String,
    parent_path: String,
    parent: Mutex<Option<Vec<u8>>>,
    bootstraps: Mutex<Vec<Page>>,
    opaque: Vec<u8>,
    csp: String,
    requests: Mutex<Vec<Value>>,
    received: AtomicUsize,
}
fn encode(value: &Value) -> String {
    value
        .to_string()
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
}
fn render(template: &str, config: &Value) -> Result<Vec<u8>, String> {
    if template.matches("__ATOOLS_BOOTSTRAP_CONFIG__").count() != 1 {
        return Err("Each synthetic template requires exactly one config slot".into());
    }
    let result = template.replace("__ATOOLS_BOOTSTRAP_CONFIG__", &encode(config));
    if result.len() > 192 * 1024 {
        return Err("Rendered synthetic HTML exceeded budget".into());
    }
    Ok(result.into_bytes())
}
impl Pages {
    pub fn new(
        run_id: &str,
        nonce: &str,
        parent: String,
        bootstrap: String,
        payload: String,
        opaque: String,
        endpoints: [String; 2],
    ) -> Result<Arc<Self>, String> {
        let suffix = run_id.replace('-', "");
        let parent_host = format!("parent-{suffix}.localhost");
        let parent_origin = format!("{SCHEME}://{parent_host}");
        let parent_path = format!("/{}/index.html", uuid::Uuid::new_v4().simple());
        let mut frames = Vec::new();
        let mut bootstraps = Vec::new();
        for (index, id) in ["a", "b"].iter().enumerate() {
            let host = format!("{id}-{suffix}.localhost");
            let expected_origin = format!("{SCHEME}://{host}");
            let path = format!("/{}/bootstrap.html", uuid::Uuid::new_v4().simple());
            let config = json!({"runId":run_id,"id":id,"parentOrigin":parent_origin});
            let body = render(&bootstrap, &config)?;
            let payload_config = json!({"runId":run_id,"id":id,"parentOrigin":parent_origin,"expectedOrigin":expected_origin,
                "endpoint":endpoints[index],"foreignEndpoint":endpoints[1-index],"marker":format!("synthetic-marker-{id}-{}",uuid::Uuid::new_v4().simple())});
            let payload_html = String::from_utf8(render(&payload, &payload_config)?)
                .map_err(|_| "Invalid synthetic payload UTF-8")?;
            frames.push(json!({"id":id,"url":format!("{expected_origin}{path}"),"expectedOrigin":expected_origin,"payloadHtml":payload_html}));
            bootstraps.push(Page {
                id,
                host,
                path,
                body,
                consumed: false,
            });
        }
        let opaque_url = format!("{SCHEME}://b-{suffix}.localhost/opaque.html");
        let opaque = render(
            &opaque,
            &json!({"runId":run_id,"parentOrigin":parent_origin,"endpoint":endpoints[0]}),
        )?;
        let parent = render(
            &parent,
            &json!({"runId":run_id,"reportNonce":nonce,"parentOrigin":parent_origin,"frames":frames,"opaqueUrl":opaque_url}),
        )?;
        // Only the selected ephemeral loopback origin is reachable; no network
        // libraries, original plugins, worker or filesystem assets are exposed.
        let endpoint: tauri::Url = endpoints[0]
            .parse()
            .map_err(|_| "Invalid synthetic endpoint")?;
        if endpoint.scheme() != "http"
            || endpoint.host_str() != Some("127.0.0.1")
            || endpoint.port().is_none()
        {
            return Err("Synthetic endpoint must be loopback".into());
        }
        let loopback = format!("http://127.0.0.1:{}", endpoint.port().unwrap());
        let csp=format!("default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src {SCHEME}: about:; connect-src {loopback} ipc: http://ipc.localhost; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
        Ok(Arc::new(Self {
            frames,
            parent_host,
            parent_path,
            parent: Mutex::new(Some(parent)),
            bootstraps: Mutex::new(bootstraps),
            opaque,
            csp,
            requests: Mutex::new(Vec::new()),
            received: AtomicUsize::new(0),
        }))
    }
    pub fn parent_url(&self) -> String {
        format!("{SCHEME}://{}{}", self.parent_host, self.parent_path)
    }
    pub fn evidence(&self) -> Value {
        let received = self.received.load(Ordering::SeqCst);
        json!({"capacity":MAX_REQUESTS,"received":received,"truncated":received>MAX_REQUESTS,"entries":self.requests.lock().clone()})
    }
    fn response(&self, status: u16, body: Vec<u8>, opaque: bool) -> Response<Vec<u8>> {
        let csp = if opaque {
            format!("{}; sandbox allow-scripts", self.csp)
        } else {
            self.csp.clone()
        };
        Response::builder()
            .status(status)
            .header("Content-Type", "text/html; charset=utf-8")
            .header(
                "Content-Security-Policy",
                if status == 200 {
                    csp.as_str()
                } else {
                    "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'"
                },
            )
            .header("Cache-Control", "no-store")
            .header("X-Content-Type-Options", "nosniff")
            .header("Referrer-Policy", "no-referrer")
            .body(body)
            .unwrap()
    }
    pub fn serve(&self, request: Request<Vec<u8>>, window: &str) -> Response<Vec<u8>> {
        let host = request.uri().host().unwrap_or("");
        let path = request.uri().path();
        let mut status = 403;
        let mut id = "unknown";
        let mut kind = "rejected";
        let mut body = b"Unavailable".to_vec();
        let mut opaque = false;
        if window == "bootstrap-fixture"
            && request.method() == "GET"
            && request.uri().scheme_str() == Some(SCHEME)
            && request.uri().query().is_none()
            && request.body().is_empty()
            && request
                .uri()
                .authority()
                .is_some_and(|authority| authority.as_str() == host)
        {
            if host == self.parent_host && path == self.parent_path {
                id = "parent";
                kind = "parent";
                if let Some(page) = self.parent.lock().take() {
                    status = 200;
                    body = page;
                } else {
                    status = 410;
                }
            } else {
                let mut pages = self.bootstraps.lock();
                if let Some(page) = pages.iter_mut().find(|page| page.host == host) {
                    id = page.id;
                    if path == page.path {
                        kind = "bootstrap";
                        if page.consumed {
                            status = 410;
                        } else {
                            page.consumed = true;
                            status = 200;
                            body = page.body.clone();
                        }
                    } else if page.id == "b" && path == "/opaque.html" {
                        kind = "opaque";
                        status = 200;
                        opaque = true;
                        body = self.opaque.clone();
                    } else {
                        status = 404;
                    }
                }
            }
        }
        self.received.fetch_add(1, Ordering::SeqCst);
        let mut evidence = self.requests.lock();
        if evidence.len() < MAX_REQUESTS {
            let header_kind = |name: &str| {
                request
                    .headers()
                    .get(name)
                    .map(|value| if value == "null" { "null" } else { "present" })
                    .unwrap_or("absent")
            };
            evidence.push(json!({"id":id,"kind":kind,"status":status,"scriptlessError":status!=200,
                "opaqueSandbox":opaque,"originHeader":header_kind("origin"),"refererHeader":header_kind("referer")}));
        }
        self.response(status, body, opaque)
    }
}
