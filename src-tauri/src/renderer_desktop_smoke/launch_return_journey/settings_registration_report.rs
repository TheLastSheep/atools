use crate::renderer_desktop_smoke::profile::Profile;
use serde_json::{json, Value};

pub(super) fn initial(profile: &Profile) -> Value {
    let root = &profile.root;
    json!({
        "status":"not_run", "inputSource":"rust-injected-drag-event", "physicalOsDrop":false, "deadlineMs":60000,
        "fixturePaths":{
            "firstApp":root.join("launcher-apps/AToolsOwnedProbeFirst.app"),
            "secondApp":root.join("launcher-apps/AToolsOwnedProbeSecond.app"),
            "file":root.join("settings-registration/owned-file.txt"),
            "folder":root.join("settings-registration/owned-folder")
        },
        "initial":null, "firstChild":null, "drop":null, "alias":null, "firstClose":null,
        "aliasSearch":null, "secondChild":null, "reopen":null, "cleanup":null, "finalClose":null,
        "acl":null, "identity":null, "focus":[], "mainEvents":null, "mainCalls":null
    })
}
