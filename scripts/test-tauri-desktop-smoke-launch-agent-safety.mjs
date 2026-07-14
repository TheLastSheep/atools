import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const desktopSmokeSource = await readFile(
  new URL("../src-tauri/src/desktop_smoke.rs", import.meta.url),
  "utf8"
);

assert.doesNotMatch(desktopSmokeSource, /run_launch_agent_system_file_smoke/);
assert.doesNotMatch(desktopSmokeSource, /restore_launch_agent_backup/);
assert.doesNotMatch(desktopSmokeSource, /launch_agent_path\s*\(\s*\)/);
assert.match(desktopSmokeSource, /fn run_launch_agent_file_smoke\s*\(/);
assert.match(desktopSmokeSource, /std::env::temp_dir\s*\(\s*\)/);
