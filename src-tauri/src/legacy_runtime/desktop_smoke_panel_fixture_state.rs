//! Data exposed to the isolated production PluginPanel scenarios.
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::Manager;

pub(super) struct PanelFixture {
    pub(super) root: PathBuf,
    pub(super) token: String,
    pub(super) document_probe: String,
    pub(super) dataset: super::super::catalog_fixture::CatalogDataset,
    pub(super) db: std::sync::Arc<atools_core::Database>,
    pub(super) head_file_tree_acceptance: bool,
    pub(super) head_developer_codec_tools_acceptance: bool,
}

#[tauri::command]
pub(super) fn native_panel_fixture(app: tauri::AppHandle) -> Value {
    let fixture = app.state::<PanelFixture>();
    let node_page_acceptance =
        std::env::var("ATOOLS_NODE_PAGE_ACCEPTANCE").as_deref() == Ok("true");
    let mut value = json!({"token":fixture.token,"treePath":fixture.root.join("tree-data").to_string_lossy(),"dataset":fixture.dataset,
        "pageDocumentMode":crate::plugin_page_runtime::enabled(&app),
        "pageNavigationDataTool":crate::plugin_data_runtime::registry::tool_name("file-tree"),
        "webStorageDataTools":{"fileTree":crate::plugin_data_runtime::registry::tool_name("file-tree"),
            "charTransform":crate::plugin_data_runtime::registry::tool_name("char-transform")},
        "windowMode":app.state::<super::super::panel_foreground::PanelForeground>().mode(),
        "childNodeAcceptance":std::env::var("ATOOLS_CHILD_NODE_ACCEPTANCE").as_deref()==Ok("true"),
        "headFileTreeAcceptance":fixture.head_file_tree_acceptance,
        "headDeveloperCodecToolsAcceptance":fixture.head_developer_codec_tools_acceptance,
        "capabilities":{"char-transform":{"node":crate::legacy_runtime::registry::tool_name("char-transform")},
            "file-tree":{"node":crate::legacy_runtime::registry::tool_name("file-tree"),"data":crate::plugin_data_runtime::registry::tool_name("file-tree"),
                "dialogOpen":crate::plugin_dialog_runtime::registry::tool_name("file-tree",crate::plugin_dialog_runtime::registry::Access::Open),
                "dialogSave":crate::plugin_dialog_runtime::registry::tool_name("file-tree",crate::plugin_dialog_runtime::registry::Access::Save)}}});
    if node_page_acceptance {
        value["nodePageOutputPath"] = json!(fixture
            .root
            .join("node-page-output.png")
            .to_string_lossy()
            .to_string());
    }
    value
}
