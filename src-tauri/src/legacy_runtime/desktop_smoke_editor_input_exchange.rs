//! Private, bounded post-click handshake for the two opt-in fixed editor fixtures.
//! This is not a production command or an input/focus implementation.
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    time::Instant,
};
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    pid: u32,
    case_id: String,
    phase: String,
    action_ordinal: u8,
    document_nonce: String,
    arm_nonce: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    #[serde(flatten)]
    binding: Binding,
    request_nonce: String,
}
struct Armed {
    binding: Binding,
    started: Instant,
    handled: bool,
}
pub(super) struct Exchange {
    root: Option<PathBuf>,
    case_id: String,
    armed: Mutex<Option<Armed>>,
}

fn nonce(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn ordinal(case_id: &str, phase: &str) -> Option<u8> {
    match (case_id, phase) {
        ("local-plain-text", "alpha") | ("local-json-editor", "valid") => Some(1),
        ("local-plain-text", "beta") | ("local-json-editor", "format") => Some(2),
        ("local-json-editor", "malformed") => Some(3),
        ("local-json-editor", "recovery") => Some(4),
        _ => None,
    }
}
fn read_regular(path: &Path) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|_| "Editor exchange file unavailable")?;
    let meta = file
        .metadata()
        .map_err(|_| "Editor exchange metadata unavailable")?;
    if !meta.is_file() || meta.len() > 4096 {
        return Err("Invalid bounded editor exchange file".into());
    }
    let mut bytes = Vec::new();
    file.take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| "Editor exchange read failed")?;
    if bytes.len() > 4096 {
        return Err("Editor exchange exceeded budget".into());
    }
    Ok(bytes)
}
impl Exchange {
    pub(super) fn from_environment(enabled: bool, case_id: &str) -> Result<Self, String> {
        let root = std::env::var_os("ATOOLS_NATIVE_EDITOR_INPUT_EXCHANGE").map(PathBuf::from);
        if root.is_some()
            && (!enabled
                || ordinal(
                    case_id,
                    if case_id == "local-plain-text" {
                        "alpha"
                    } else {
                        "valid"
                    },
                )
                .is_none())
        {
            return Err("Editor exchange requires an opted-in original editor fixture".into());
        }
        if let Some(root) = &root {
            #[cfg(not(unix))]
            return Err("Native editor exchange is currently Unix fixture-only".into());
            #[cfg(unix)]
            {
                use std::os::unix::fs::{MetadataExt, PermissionsExt};
                let meta = std::fs::symlink_metadata(root)
                    .map_err(|_| "Missing private editor exchange directory")?;
                if !root.is_absolute()
                    || !root.starts_with("/private/tmp")
                    || !meta.is_dir()
                    || meta.file_type().is_symlink()
                    || meta.permissions().mode() & 0o777 != 0o700
                    || meta.uid() != unsafe { libc::geteuid() }
                    || std::fs::canonicalize(root).ok().as_ref() != Some(root)
                    || std::fs::read_dir(root)
                        .map_err(|_| "Editor exchange inspection failed")?
                        .next()
                        .is_some()
                {
                    return Err(
                        "An empty owned private editor exchange directory is required".into(),
                    );
                }
            }
        }
        Ok(Self {
            root,
            case_id: case_id.into(),
            armed: Mutex::new(None),
        })
    }
    fn write(&self, name: &str, value: &Value) -> Result<(), String> {
        use std::io::Write;
        let root = self.root.as_ref().ok_or("Editor exchange not configured")?;
        let bytes = serde_json::to_vec(value).map_err(|_| "Editor exchange encoding failed")?;
        if bytes.len() > 4096 {
            return Err("Editor exchange output exceeded budget".into());
        }
        let pending = root.join(format!("{name}.pending"));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&pending)
            .map_err(|_| "Editor exchange private write failed")?;
        file.write_all(&bytes)
            .map_err(|_| "Editor exchange write failed")?;
        std::fs::rename(pending, root.join(name))
            .map_err(|_| "Editor exchange publish failed".into())
    }
    fn arm(&self, phase: &str, document: &str) -> Result<Value, String> {
        let action = ordinal(&self.case_id, phase).ok_or("Unknown fixed editor phase")?;
        if !nonce(document) {
            return Err("Authenticated frame document required".into());
        }
        if self.root.is_none() {
            return Ok(json!({"configured":false}));
        }
        let binding = Binding {
            pid: std::process::id(),
            case_id: self.case_id.clone(),
            phase: phase.into(),
            action_ordinal: action,
            document_nonce: document.into(),
            arm_nonce: uuid::Uuid::new_v4().simple().to_string(),
        };
        let mut state = self.armed.lock();
        if let Some(previous) = state.as_ref() {
            if action <= previous.binding.action_ordinal {
                return Err("Editor phase cannot be replayed".into());
            }
        }
        self.write("ready.json", &json!(binding))?;
        *state = Some(Armed {
            binding,
            started: Instant::now(),
            handled: false,
        });
        Ok(json!({"configured":true,"armed":true}))
    }
    fn request(&self) -> Result<Option<Request>, String> {
        let Some(root) = self.root.as_ref() else {
            return Ok(None);
        };
        let state = self.armed.lock();
        let Some(armed) = state.as_ref() else {
            return Ok(None);
        };
        if armed.handled || armed.started.elapsed().as_secs() >= 60 {
            return Ok(None);
        }
        let path = root.join("request.json");
        if !path.exists() {
            return Ok(None);
        }
        let request: Request = serde_json::from_slice(&read_regular(&path)?)
            .map_err(|_| "Invalid editor handshake request")?;
        // Previous phase's request may still exist until the next click. It never authorizes this phase.
        if request.binding != armed.binding {
            return Ok(None);
        }
        if !nonce(&request.request_nonce) {
            return Err("Invalid handshake nonce".into());
        }
        Ok(Some(request))
    }
    fn acknowledge(&self, value: Request, passed: bool) -> Result<Value, String> {
        let current = self
            .request()?
            .ok_or("Missing or stale editor handshake request")?;
        if current.binding != value.binding || current.request_nonce != value.request_nonce {
            return Err("Editor handshake request changed".into());
        }
        let mut state = self.armed.lock();
        let armed = state.as_mut().ok_or("Editor phase unavailable")?;
        if armed.handled
            || armed.binding != value.binding
            || armed.started.elapsed().as_secs() >= 60
        {
            return Err("Editor handshake no longer current".into());
        }
        self.write(
            "ack.json",
            &json!({"binding":value.binding,"requestNonce":value.request_nonce,"passed":passed}),
        )?;
        armed.handled = true;
        Ok(json!({"acknowledged":true,"passed":passed}))
    }
}

#[tauri::command]
pub(super) fn native_editor_input_exchange(
    app: AppHandle,
    operation: String,
    phase: Option<String>,
    document_nonce: Option<String>,
    request: Option<Value>,
    passed: Option<bool>,
) -> Result<Value, String> {
    let state = app.state::<Exchange>();
    match operation.as_str() {
        "arm" if request.is_none() && passed.is_none() => state.arm(
            phase.as_deref().ok_or("Missing editor phase")?,
            document_nonce.as_deref().ok_or("Missing frame document")?,
        ),
        "poll"
            if phase.is_none()
                && document_nonce.is_none()
                && request.is_none()
                && passed.is_none() =>
        {
            Ok(json!(state.request()?))
        }
        "ack" if phase.is_none() && document_nonce.is_none() => state.acknowledge(
            serde_json::from_value(request.ok_or("Missing editor request")?)
                .map_err(|_| "Invalid editor request")?,
            passed.ok_or("Missing handshake decision")?,
        ),
        "stop"
            if phase.is_none()
                && document_nonce.is_none()
                && request.is_none()
                && passed.is_none() =>
        {
            *state.armed.lock() = None;
            Ok(json!({"stopped":true}))
        }
        _ => Err("Unknown editor exchange operation or arguments".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn phases_and_nonces_are_closed() {
        assert_eq!(ordinal("local-plain-text", "alpha"), Some(1));
        assert_eq!(ordinal("local-json-editor", "recovery"), Some(4));
        assert_eq!(ordinal("local-plain-text", "recovery"), None);
        assert!(!nonce(&"A".repeat(32)));
        assert!(!nonce(&"a".repeat(33)));
        assert!(nonce(&"f".repeat(32)));
    }
    #[test]
    fn requests_are_document_bound_single_use_and_ordered() {
        let temp = tempfile::tempdir().unwrap();
        let exchange = Exchange {
            root: Some(temp.path().into()),
            case_id: "local-plain-text".into(),
            armed: Mutex::new(None),
        };
        exchange.arm("alpha", &"a".repeat(32)).unwrap();
        let binding = exchange.armed.lock().as_ref().unwrap().binding.clone();
        let request = Request {
            binding,
            request_nonce: "b".repeat(32),
        };
        exchange.write("request.json", &json!(request)).unwrap();
        assert!(exchange.request().unwrap().is_some());
        let mut wrong = request.clone();
        wrong.binding.document_nonce = "c".repeat(32);
        assert!(exchange.acknowledge(wrong, true).is_err());
        exchange.acknowledge(request.clone(), false).unwrap();
        assert!(exchange.request().unwrap().is_none());
        assert!(exchange.acknowledge(request, true).is_err());
        assert!(exchange.arm("alpha", &"a".repeat(32)).is_err());
        exchange.arm("beta", &"a".repeat(32)).unwrap();
        assert!(exchange.request().unwrap().is_none());
    }
}
