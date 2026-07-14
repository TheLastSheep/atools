import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workspaceConfig = readFileSync("pnpm-workspace.yaml", "utf8");

assert.match(
  workspaceConfig,
  /^allowBuilds:\n(?:  .+\n)*  esbuild: true(?:\n|$)/m,
  "pnpm-workspace.yaml must approve esbuild build scripts with allowBuilds.esbuild=true"
);
