// @vitest-environment node
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { expect, it } from "vitest";
import { nodeModuleBridgeScript } from "../../src/lib/nodeModuleBridge";
import { preparePluginPreload } from "../../src/lib/pluginPreload";

const sourceRoot = process.env.ATOOLS_HARRIS_PLUGIN_SOURCE;
const releaseDir = sourceRoot ? resolve(sourceRoot, "format-converter") : "";
const releaseDist = join(releaseDir, "dist");
const productionLegacyNodeDir = resolve("crates/atools-plugin/src/legacy_node");
const endpoint = `http://127.0.0.1:43121/node/${"a".repeat(64)}`;

type JsonResult = { ok: boolean; data?: any; error?: { code?: string; message?: string } };

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function snapshotRelease(): Promise<string> {
  const files = [join(releaseDist, "plugin.json")];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(join(releaseDist, "preload"));
  const records = await Promise.all([...new Set(files)].sort().map(async path => [
    path.slice(releaseDist.length + 1), digest(await readFile(path)),
  ] as const));
  return digest(JSON.stringify(records));
}

function makeNodeSidecar(pluginEntry: string) {
  const nodeRequire = createRequire(pluginEntry);
  const sourceNames = ["codec.cjs", "bounded_png_path.cjs", "bounded_native_image_path.cjs", "bootstrap.cjs"];
  const source = sourceNames.map(name => readFileSync(join(productionLegacyNodeDir, name), "utf8")).join("\n");
  const output: string[] = [];
  const processStub = {
    env: { ...process.env, ATOOLS_PRELOAD_ENTRY: pluginEntry },
    pid: process.pid,
    versions: process.versions,
    platform: process.platform,
    arch: process.arch,
    stdin: {},
    stdout: { write(value: string) { output.push(value); return true; } },
    stderr: { write(value: string) { output.push(value); return true; } },
    exit(code?: number) { throw new Error(`Unexpected legacy Node protocol exit: ${code}`); },
  };
  const sandbox = {
    require(specifier: string) {
      if (specifier === "node:readline") return { createInterface: () => ({ on() { return this; } }) };
      return nodeRequire(specifier);
    },
    process: processStub,
    console: {},
    Buffer,
    setTimeout,
    clearTimeout,
    setImmediate,
    clearImmediate,
    URL,
  };
  const dispatch = new Function("require", "process", "console", `${source}\n;return dispatch;`)(sandbox.require, processStub, sandbox.console) as
    (method: string, params: Record<string, unknown>) => unknown;
  return { dispatch, output, sourceNames };
}

function makePreloadFrame(html: string, dispatch: (method: string, params: Record<string, unknown>) => unknown, userDataPath: string) {
  const listeners = new Map<string, Set<() => void>>();
  function response(body: string) {
    const request = JSON.parse(body) as { method: string; params: Record<string, unknown> };
    try {
      const result = JSON.parse(JSON.stringify(dispatch(request.method, request.params)));
      return JSON.stringify({ ok: true, result });
    } catch (error) {
      const caught = error as Error & { code?: string };
      return JSON.stringify({ ok: false, error: { message: caught.message, code: caught.code } });
    }
  }
  class LocalXmlHttpRequest {
    status = 0;
    responseText = "";
    open() {}
    setRequestHeader() {}
    send(body: string) { this.status = 200; this.responseText = response(body); }
  }
  const ztools = { getPath: (name: string) => name === "userData" ? userDataPath : userDataPath };
  const sandbox: Record<string, any> = {
    ztools,
    utools: ztools,
    XMLHttpRequest: LocalXmlHttpRequest,
    fetch: async (_url: string, options: { body: string }) => {
      await new Promise(resolve => setTimeout(resolve, 0));
      const text = response(options.body);
      return { ok: true, status: 200, json: async () => JSON.parse(text) };
    },
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    DataView,
    atob,
    btoa,
    setTimeout,
    clearTimeout,
    setImmediate,
    clearImmediate,
    queueMicrotask,
    AbortController,
    WeakRef,
    FinalizationRegistry,
    console,
    addEventListener(type: string, listener: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: () => void) { listeners.get(type)?.delete(listener); },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`window.__atoolsNodeModuleRequire = ${nodeModuleBridgeScript({ endpoint })};
window.require = window.__atoolsNodeModuleRequire;
window.process = window.require('process');
window.Buffer = window.require('buffer').Buffer;`, sandbox, { timeout: 5000 });
  const script = html.replace(/^<script[^>]*>\n/, "").replace(/\n<\/script>$/, "");
  vm.runInContext(script, sandbox, { timeout: 5000 });
  return {
    sandbox,
    services: sandbox.services,
    close() {
      for (const type of ["pagehide", "atools-plugin-out"]) {
        for (const listener of [...(listeners.get(type) ?? [])]) listener();
      }
    },
  };
}

function makeExactSizeJson(bytes: number): string {
  const overhead = Buffer.byteLength('{"payload":""}');
  const text = `{"payload":"${"x".repeat(bytes - overhead)}"}`;
  if (Buffer.byteLength(text) !== bytes) throw new Error(`Invalid JSON fixture length: ${Buffer.byteLength(text)} != ${bytes}`);
  return text;
}

async function pollJob(services: any, jobId: string): Promise<any> {
  const deadline = Date.now() + 15_000;
  let last: JsonResult | undefined;
  while (Date.now() < deadline) {
    last = await services.getJob(jobId);
    if (!last?.ok) throw new Error(`Could not read conversion job: ${JSON.stringify(last)}`);
    if (["succeeded", "partial", "failed", "cancelled"].includes(last.data.status)) return last.data;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Conversion job did not finish: ${JSON.stringify(last)}`);
}

it.skipIf(!sourceRoot)("reproduces large JSON read/convert/write through the original Format Converter and production Node codec", async () => {
  const manifest = JSON.parse(await readFile(join(releaseDist, "plugin.json"), "utf8"));
  expect(manifest.version).toBe("0.1.0");
  const releaseBefore = await snapshotRelease();
  const scratch = await mkdtemp(join(tmpdir(), "atools-harris-format-large-"));
  const inputDir = join(scratch, "input");
  const outputDir = join(scratch, "output");
  await Promise.all([mkdir(inputDir), mkdir(outputDir)]);
  const smallPath = join(inputDir, "small.json");
  const largePath = join(inputDir, "large.json");
  const pngPath = join(inputDir, "pixel.png");
  const smallText = makeExactSizeJson(512 * 1024);
  const largeText = makeExactSizeJson(800 * 1024);
  const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/S4kAAAAASUVORK5CYII=", "base64");
  expect(pngBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
  expect([pngBytes.readUInt32BE(16), pngBytes.readUInt32BE(20)]).toEqual([1, 1]);
  const expectedSmall = JSON.stringify(JSON.parse(smallText), null, 2);
  const expectedLarge = JSON.stringify(JSON.parse(largeText), null, 2);
  await Promise.all([writeFile(smallPath, smallText), writeFile(largePath, largeText), writeFile(pngPath, pngBytes)]);

  const preloadPath = join(releaseDist, "preload/services.cjs");
  const sidecar = makeNodeSidecar(preloadPath);
  let frame: ReturnType<typeof makePreloadFrame> | undefined;
  let textFrame: ReturnType<typeof makePreloadFrame> | undefined;
  let finalDiagnostic: Record<string, unknown> = {};
  try {
    const html = await preparePluginPreload({
      pluginDir: join(releaseDist, "preload"),
      preloadPath,
      maxDurationMs: 5000,
      readTextFile: path => readFile(path, "utf8"),
    });
    frame = makePreloadFrame(html, sidecar.dispatch, join(scratch, "user-data"));
    const textHtml = await preparePluginPreload({
      pluginDir: join(releaseDist, "preload"),
      preloadPath: join(releaseDist, "preload/text-converter.cjs"),
      maxDurationMs: 5000,
      readTextFile: path => readFile(path, "utf8"),
    });
    textFrame = makePreloadFrame(textHtml, sidecar.dispatch, join(scratch, "user-data"));
    const bundle = frame.services.createFormatConverterServices(frame.sandbox, {
      // The text route needs no runtime. A non-empty inert snapshot avoids probing or installing host runtimes.
      runtimes: [{ id: "officecli", available: false }],
    });
    const policyInputs = [["512KiB", smallPath], ["800KiB", largePath], ["1x1PNG", pngPath]] as const;
    const policy = await Promise.all(policyInputs.map(([, path]) => bundle.services.acceptInputs([path]) as Promise<JsonResult>));
    const jsonPolicy = policy.slice(0, 2);
    const policyObservations = policy.map((result, index) => ({
      file: policyInputs[index][0],
      ok: result.ok,
      code: result.error?.code,
      message: result.error?.message,
    }));

    const textConverter = textFrame.services;
    const moduleResults: Record<string, unknown>[] = [];
    for (const [size, path, expected] of [["512KiB", smallPath, expectedSmall], ["800KiB", largePath, expectedLarge]] as const) {
      try {
        const source = await textConverter.readSource(path, "json");
        const converted = textConverter.convertStructured(source, "json", "txt");
        moduleResults.push({ size, status: "converted", byteLength: Buffer.byteLength(converted), sha256: digest(converted), exact: converted === expected });
      } catch (error) {
        moduleResults.push({
          size,
          status: "failed",
          code: (error as Error & { code?: string }).code,
          message: (error as Error).message,
        });
      }
    }

    const fullJobs: Record<string, unknown>[] = [];
    if (jsonPolicy.every(result => result.ok)) {
      const outputGrant = await bundle.internals.pathPolicy.createOutputGrant(outputDir, false);
      for (let index = 0; index < jsonPolicy.length; index++) {
        const result = jsonPolicy[index];
        const start = await bundle.services.startConversion({
          inputGrantId: result.data.id,
          outputGrantId: outputGrant.id,
          target: "txt",
          profile: "extract",
          collision: "rename",
          options: {},
        }) as JsonResult;
        if (!start.ok) {
          fullJobs.push({ size: index === 0 ? "512KiB" : "800KiB", status: "start-failed", code: start.error?.code, message: start.error?.message });
          continue;
        }
        const job = await pollJob(bundle.services, start.data.id);
        const item = job.items[0];
        let exact = false;
        let outputBytes = 0;
        if (item?.outputs?.[0]) {
          const actual = await readFile(item.outputs[0], "utf8");
          const expected = index === 0 ? expectedSmall : expectedLarge;
          exact = actual === expected;
          outputBytes = Buffer.byteLength(actual);
        }
        fullJobs.push({
          size: index === 0 ? "512KiB" : "800KiB",
          status: item?.status,
          code: item?.error?.code,
          message: item?.error?.message,
          exact,
          outputBytes,
        });
      }
    }

    finalDiagnostic = {
      pluginVersion: manifest.version,
      inputBytes: [Buffer.byteLength(smallText), Buffer.byteLength(largeText), pngBytes.length],
      policy: policyObservations,
      originalTextConverter: moduleResults,
      originalServicesJobs: jsonPolicy.every(result => result.ok) ? fullJobs : "not-run: actual JSON path policy rejected an input",
      releaseSnapshotBefore: releaseBefore,
    };
    console.info(`[harris-format-large-repro] ${JSON.stringify(finalDiagnostic)}`);

    // Record policy results before conversion so a future earlier validation failure stays visible.
    expect(policyObservations.slice(0, 2).map(item => item.ok), "real path policy must accept both valid JSON inputs").toEqual([true, true]);
    expect(moduleResults[0].status, "the original text converter must read and convert the 512 KiB control").toBe("converted");
    expect(moduleResults[0].exact, "the 512 KiB module output must match exact pretty JSON").toBe(true);
    expect(fullJobs[0].status, "the original job manager and engine must write the 512 KiB control").toBe("succeeded");
    expect(fullJobs[0].exact, "the 512 KiB written txt must match exact pretty JSON").toBe(true);
    expect(moduleResults[1].status, "the original text converter must read and convert the 800 KiB case").toBe("converted");
    expect(moduleResults[1].exact, "the 800 KiB module output must match exact pretty JSON").toBe(true);
    expect(fullJobs[1].status, "the original job manager and engine must write the 800 KiB txt").toBe("succeeded");
    expect(fullJobs[1].exact, "the 800 KiB written txt must match exact pretty JSON").toBe(true);
    expect(policyObservations[2].ok, "the actual policy must accept a valid 1x1 PNG after buffer reads are fixed").toBe(true);
  } finally {
    textFrame?.close();
    frame?.close();
    await rm(scratch, { recursive: true, force: true });
    const releaseAfter = await snapshotRelease();
    expect(releaseAfter, "the original release manifest and preload tree must remain unchanged").toBe(releaseBefore);
    if (Object.keys(finalDiagnostic).length) console.info(`[harris-format-large-repro-final] ${JSON.stringify({ releaseAfter, scratchRemoved: true })}`);
  }
});
