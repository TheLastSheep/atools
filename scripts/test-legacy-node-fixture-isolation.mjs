#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFixtureEnvironment } from "./lib/legacy-node-environment.mjs";

const previous = process.env.ADMIN_PASSWORD;
process.env.ADMIN_PASSWORD = "synthetic-fixture-secret-must-not-propagate";
const fixture = await createFixtureEnvironment();
let report;
const childSource = `
  const { spawnSync } = require('node:child_process');
  const source = \
    "const fs=require('node:fs'),os=require('node:os'),path=require('node:path');" +
    "fs.writeFileSync(path.join(os.homedir(),'grandchild-marker'),'scratch-only');" +
    "process.stdout.write(JSON.stringify({env:process.env,home:os.homedir(),tmp:os.tmpdir()}));";
  const result=spawnSync(process.execPath,['-e',source],{encoding:'utf8'});
  if(result.status!==0)throw Error(result.stderr);
  process.stdout.write(result.stdout);
`;
try {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", childSource], { env: fixture.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errorOutput = "";
    child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { errorOutput += data; });
    child.once("error", reject); child.once("close", code => code === 0 ? resolve(JSON.parse(output)) : reject(Error(errorOutput)));
  });
  assert.equal(result.home, fixture.env.HOME);
  assert.equal(result.tmp, fixture.env.TMPDIR);
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "XDG_CONFIG_DIRS", "XDG_DATA_DIRS"])
    assert(result.env[key].startsWith(fixture.root + "/"), `${key} must be fixture-owned`);
  assert.equal(await readFile(join(fixture.env.HOME, "grandchild-marker"), "utf8"), "scratch-only");
  assert(!Object.keys(result.env).some(key => /^(ADMIN_|NODE_OPTIONS$|GITHUB_|AWS_|AZURE_|OPENAI_)/.test(key)));
  const platformAddedKeys = Object.keys(result.env).filter(key => !(key in fixture.env));
  // CoreFoundation may add its own text-encoding hint while starting a macOS
  // process; it is not copied from the controller's ambient environment.
  assert(platformAddedKeys.every(key => key === "__CF_USER_TEXT_ENCODING"));
  assert.deepEqual(Object.keys(result.env).filter(key => !platformAddedKeys.includes(key)).sort(), Object.keys(fixture.env).sort());
  report = { generatedAt: new Date().toISOString(), passed: true, nodeVersion: process.version,
    childAndGrandchildHomeIsolated: true, scratchWriteVerified: true,
    ambientEnvironmentExcluded: true, platformAddedKeys, evidence: fixture.evidence };
} finally {
  if (previous === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = previous;
  await fixture.cleanup();
  await assert.rejects(access(fixture.root), { code: "ENOENT" });
}
report.isolatedEnvironmentRemoved = true;
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
