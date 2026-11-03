import frame_permissions from "./pluginUtoolsBridgeSource/frame-permissions";
import child_window_rpc from "./pluginUtoolsBridgeSource/child-window-rpc";
import native_call_and_node_shims from "./pluginUtoolsBridgeSource/native-call-and-node-shims";
import browser_window_state_and_events from "./pluginUtoolsBridgeSource/browser-window-state-and-events";
import browser_window_state_api from "./pluginUtoolsBridgeSource/browser-window-state-api";
import web_contents_navigation_and_state from "./pluginUtoolsBridgeSource/web-contents-navigation-and-state";
import web_contents_page_and_binary_api from "./pluginUtoolsBridgeSource/web-contents-page-and-binary-api";
import runtime_resource_url_and_css_rewrite from "./pluginUtoolsBridgeSource/runtime-resource-url-and-css-rewrite";
import runtime_resource_dom_installation from "./pluginUtoolsBridgeSource/runtime-resource-dom-installation";
import attachments_and_db_storage from "./pluginUtoolsBridgeSource/attachments-and-db-storage";
import utools_api_and_dynamic_features from "./pluginUtoolsBridgeSource/utools-api-and-dynamic-features";
import providers_and_entry_lifecycle from "./pluginUtoolsBridgeSource/providers-and-entry-lifecycle";

export const UTOOLS_BRIDGE = [
  frame_permissions,
  child_window_rpc,
  native_call_and_node_shims,
  browser_window_state_and_events,
  browser_window_state_api,
  web_contents_navigation_and_state,
  web_contents_page_and_binary_api,
  runtime_resource_url_and_css_rewrite,
  runtime_resource_dom_installation,
  attachments_and_db_storage,
  utools_api_and_dynamic_features,
  providers_and_entry_lifecycle
].join("");
