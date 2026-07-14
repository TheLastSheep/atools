import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [model, database, mcp, server, commands, appLib, types, panel, docs] = await Promise.all([
  readFile(new URL("crates/atools-core/src/skill.rs", root), "utf8"),
  readFile(new URL("crates/atools-core/src/db.rs", root), "utf8"),
  readFile(new URL("crates/atools-core/src/mcp.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/mcp_server.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/commands.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/lib.rs", root), "utf8"),
  readFile(new URL("src/lib/types.ts", root), "utf8"),
  readFile(new URL("src/components/AgentPanel.svelte", root), "utf8"),
  readFile(new URL("docs/skills.md", root), "utf8"),
]);

for (const field of ["triggers", "capability_ids", "steps", "permission_scopes", "failure_modes", "validation", "result_suggestions"]) {
  assert.match(model, new RegExp(`pub ${field}:`), `SkillDefinition must declare ${field}`);
}
assert.match(model, /Skill step .* references undeclared capability/);
assert.match(model, /must declare at least one validation rule/);
assert.match(model, /must declare at least one result suggestion/);
assert.match(database, /CREATE TABLE IF NOT EXISTS skills/);
assert.match(database, /pub fn upsert_skill/);
assert.match(database, /pub fn list_skills/);
assert.match(database, /pub fn set_skill_enabled/);
assert.match(mcp, /atools:\/\/skills/);
assert.match(mcp, /atools_skill_/);
assert.match(mcp, /Do not treat the skill as permission to bypass confirmation/);
assert.match(server, /handle_mcp_message_with_skills/);
for (const command of ["list_skills", "create_skill", "update_skill", "set_skill_enabled", "delete_skill", "export_skills_json"]) {
  assert.match(commands, new RegExp(`pub fn ${command}`));
  assert.ok(appLib.includes(`commands::${command}`));
}
assert.match(types, /export type SkillDefinition =/);
assert.match(panel, /<h3>Skills<\/h3>/);
assert.match(panel, /invoke<SkillDefinition\[]>\("list_skills"/);
assert.match(panel, /invoke<SkillDefinition>\("create_skill"/);
assert.match(panel, /invoke\("set_skill_enabled"/);
assert.match(panel, /invoke\("delete_skill"/);
assert.match(docs, /atools:\/\/skills/);
assert.match(docs, /重新检查权限/);
