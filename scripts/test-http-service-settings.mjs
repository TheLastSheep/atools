import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/components/SettingsPanel.svelte", import.meta.url), "utf8");

assert.ok(source.includes('activeMenu === "http"') && source.includes("refreshMcpPage"), "HTTP page should refresh MCP status when opened");
assert.ok(source.includes("copyHttpMcpUrl"), "HTTP page should provide a copy-MCP-URL action");
assert.ok(source.includes("copyHttpMcpConfig"), "HTTP page should provide a copy-MCP-config action");
assert.ok(source.includes("复制 MCP 地址"), "HTTP page should render copy MCP address button");
assert.ok(source.includes("复制 MCP 配置"), "HTTP page should render copy MCP config button");
assert.ok(source.includes("disabled={!mcpConnection().tokenAvailable}"), "Copy MCP address should be disabled until HTTP MCP has a token");
assert.ok(source.includes("mcpConnection().statusLabel"), "HTTP page should show the current MCP status");
assert.ok(source.includes("mcpConnection().securityHint"), "HTTP page should explain token/security behavior");
assert.ok(source.includes("传统 HTTP API"), "HTTP page should keep legacy HTTP API visibly disabled");
assert.ok(source.includes("mcpPageStatus"), "HTTP page should show copy/refresh feedback");
