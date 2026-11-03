// @vitest-environment node
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createPluginRuntimePreload } from "../../src/lib/pluginRuntimePreload";

function setup(source: string, files: Record<string, string> = {}, pluginDir = "/plugins/path-only") {
  const invoke = vi.fn(async (command: string) => command === "prepare_legacy_node"
    ? { sessionId: "session" } : { endpoint: `http://127.0.0.1:43121/node/${"a".repeat(64)}` });
  const loader = createPluginRuntimePreload(invoke as any, "path-only", () => true);
  const options = {
    pluginDir, preloadPath: `${pluginDir}/preload.cjs`,
    readTextFile: async (path: string) => {
      if (path.endsWith("/preload.cjs")) return source;
      if (path in files) return files[path];
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    },
  };
  return { loader, invoke, options };
}

function execute(html: string) {
  const sandbox: any = { utools: {}, addEventListener() {}, removeEventListener() {} };
  sandbox.window = sandbox;
  const scripts = [...html.matchAll(/<script[^>]*>\n([\s\S]*?)\n<\/script>/g)];
  expect(scripts).toHaveLength(1);
  vm.runInNewContext(scripts[0][1], sandbox, { timeout: 1000 });
  return sandbox;
}

describe("production native-only path preload", () => {
  it.each([
    `module.exports = { destination: () => require('path').join('/tmp', '文档.md') };`,
    `const p = require('node:path'); module.exports = { destination: () => p.posix.resolve('/tmp', '文档.md') };`,
    `const { join: joinPath } = require('node:path/posix'); module.exports = { destination: () => joinPath('/tmp', '文档.md') };`,
  ])("executes safe path calls without preparing Node %#", async source => {
    const { loader, invoke, options } = setup(`window.executions=(window.executions||0)+1; ${source}`);
    try {
      const html = await loader.prepare(options);
      expect(invoke).not.toHaveBeenCalled();
      const sandbox = execute(html);
      expect(sandbox.executions).toBe(1);
      expect(sandbox.services.destination()).toBe("/tmp/文档.md");
      expect(sandbox.executions).toBe(1);
    } finally { await loader.close(); }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("examines the whole local dependency graph without replaying module initialization", async () => {
    const { loader, invoke, options } = setup(`
      const child = require('./child.cjs'); module.exports = { destination: child.destination };
    `, { "/plugins/path-only/child.cjs": `
      const p = require('path/posix'); window.childExecutions=(window.childExecutions||0)+1;
      module.exports = { destination: () => p.join('/tmp', 'child.md') };
    ` });
    try {
      const sandbox = execute(await loader.prepare(options));
      expect(sandbox.services.destination()).toBe("/tmp/child.md");
      expect(sandbox.childExecutions).toBe(1);
      expect(invoke).not.toHaveBeenCalled();
    } finally { await loader.close(); }
  });

  it.each([
    `const p=require('path'); module.exports=p;`,
    `const p=require('path'); module.exports={dest:()=>p['join']('/tmp','a')};`,
    `const p=require('path'); module.exports={dest:()=>p.win32.join('C:', 'a')};`,
    `const p=require('path'); module.exports={dest:()=>p.matchesGlob('a','*')};`,
    `const p=require('path'); function nested(p) {return p.join('a')};`,
    `const p=require('path'); delete p.sep;`,
    `const p=require('path'); module.exports={dest:()=>p.join(process.cwd(),'a')};`,
    `const p=require('path'); module.exports={dest:()=>p.join('/tmp',Buffer.from('a').toString())};`,
    `const p=require('path'); const fs=require('fs'); module.exports={dest:()=>p.join('/tmp','a')};`,
  ])("retains Node preparation for unsupported or unproven source %#", async source => {
    const { loader, invoke, options } = setup(source);
    try {
      expect(await loader.prepare(options)).toContain("data-atools-node-modules");
      expect(invoke.mock.calls.map(([command]) => command)).toEqual(["prepare_legacy_node", "get_legacy_node_session"]);
    } finally { await loader.close(); }
  });

  it("retains Node when a dependency requires it", async () => {
    const { loader, invoke, options } = setup(`const p=require('path'); const child=require('./child.cjs'); p.join('/tmp','a');`, {
      "/plugins/path-only/child.cjs": `module.exports=require('fs');`,
    });
    try {
      expect(await loader.prepare(options)).toContain("data-atools-node-modules");
      expect(invoke).toHaveBeenCalledTimes(2);
    } finally { await loader.close(); }
  });

  it.each([
    `module.exports=()=>process.cwd();`,
    `const indirect=require; module.exports=()=>indirect('fs');`,
  ])("retains the Node environment needed only by a sibling module %#", async child => {
    const { loader, invoke, options } = setup(`const p=require('path'); const child=require('./child.cjs'); p.join('/tmp','a');`, {
      "/plugins/path-only/child.cjs": child,
    });
    try {
      expect(await loader.prepare(options)).toContain("data-atools-node-modules");
      expect(invoke).toHaveBeenCalledTimes(2);
    } finally { await loader.close(); }
  });

  it("retains Node on Windows roots where the POSIX adapter is inactive", async () => {
    const { loader, invoke, options } = setup(`require('path').join('a','b');`, {}, "C:/plugins/path-only");
    try {
      expect(await loader.prepare(options)).toContain("data-atools-node-modules");
      expect(invoke).toHaveBeenCalledTimes(2);
    } finally { await loader.close(); }
  });
});
