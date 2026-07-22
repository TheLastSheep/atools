import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const EXCLUDED_DIRECTORIES = new Set([".git", "dist", "node_modules", "target"]);
const VALID_KINDS = new Set(["rust", "node", "web"]);
const VALID_TRANSPORTS = new Set(["json_rpc_stdio", "mcp_stdio", "host_bridge"]);

function fail(message) {
  throw new Error(message);
}

function normalizedRelativePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

async function collectFiles(root, current = root, output = []) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const path = join(current, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) fail(`symlinks are not allowed in plugin packages: ${path}`);
    if (info.isDirectory()) await collectFiles(root, path, output);
    else if (info.isFile()) output.push({ path, name: normalizedRelativePath(root, path), mode: info.mode & 0o777 });
    else fail(`unsupported filesystem entry: ${path}`);
  }
  return output;
}

function validateSchema(schema, label) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) fail(`${label} must be a JSON Schema object`);
  if (schema.type && typeof schema.type !== "string" && !Array.isArray(schema.type)) fail(`${label}.type must be a string or array`);
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("plugin.json must contain an object");
  if (!String(manifest.name || "").trim()) fail("plugin.json requires name");
  const runtime = manifest.runtime;
  if (!runtime || typeof runtime !== "object") fail("native templates require runtime");
  if (!VALID_KINDS.has(runtime.kind)) fail(`unsupported runtime.kind: ${runtime.kind}`);
  if (!VALID_TRANSPORTS.has(runtime.transport)) fail(`unsupported runtime.transport: ${runtime.transport}`);
  const entry = String(runtime.entry || manifest.main || manifest.preload || "").trim();
  if (!entry || entry.startsWith("/") || entry.split(/[\\/]/).includes("..")) fail("runtime entry must be a safe relative path");
  if (runtime.kind === "web" && runtime.transport !== "host_bridge") fail("Web plugins must use host_bridge");
  if ((runtime.kind === "rust" || runtime.kind === "node") && runtime.transport === "host_bridge") fail("Rust/Node plugins must use stdio transport");
  if (!Array.isArray(manifest.permissions) || manifest.permissions.some((value) => typeof value !== "string" || !value.trim())) fail("permissions must be an array of non-empty strings");
  const tools = manifest.tools || {};
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) fail("tools must be an object");
  for (const [name, tool] of Object.entries(tools)) {
    if (!name.trim() || !tool || typeof tool !== "object") fail(`invalid tool declaration: ${name}`);
    validateSchema(tool.inputSchema || { type: "object" }, `tools.${name}.inputSchema`);
    if (tool.outputSchema != null) validateSchema(tool.outputSchema, `tools.${name}.outputSchema`);
  }
  return { runtime, entry, tools };
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env || process.env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code: Number(code ?? -1), stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (result.code === 0) resolvePromise(result);
      else reject(new Error(`${command} exited ${result.code}: ${result.stderr.trim()}`));
    });
  });
}

function cargoPackageName(cargoToml) {
  const packageSection = cargoToml.match(/\[package\]([\s\S]*?)(?:\n\[|$)/)?.[1] || "";
  const name = packageSection.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
  if (!name) fail("Cargo.toml [package].name is required");
  return name;
}

async function buildRust(source, entry) {
  const cargoToml = await readFile(join(source, "Cargo.toml"), "utf8");
  const name = cargoPackageName(cargoToml);
  const fingerprint = createHash("sha256").update(source).digest("hex").slice(0, 12);
  const targetDir = `/tmp/atools-plugin-package-${fingerprint}`;
  await run("cargo", ["build", "--release", "--manifest-path", join(source, "Cargo.toml"), "--target-dir", targetDir], { cwd: source });
  const executable = join(targetDir, "release", `${name}${process.platform === "win32" ? ".exe" : ""}`);
  return { name: entry, data: await readFile(executable), mode: 0o755, executable };
}

function sidecarRequest(executable, args, messages, timeoutMs = 10_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const expected = new Map(messages.filter((message) => Object.hasOwn(message, "id")).map((message) => [message.id, null]));
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`sidecar smoke timed out; stderr=${Buffer.concat(stderr).toString("utf8")}`));
    }, timeoutMs);
    lines.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (!expected.has(message.id)) return;
      if (message.error) {
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error(`sidecar JSON-RPC error: ${message.error.message}`));
        return;
      }
      expected.set(message.id, message.result);
      if ([...expected.values()].every((value) => value !== null)) {
        clearTimeout(timer);
        child.kill("SIGTERM");
        resolvePromise(Object.fromEntries(expected));
      }
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

async function smokeRuntime(source, manifest, builtRust) {
  const { runtime } = validateManifest(manifest);
  if (runtime.kind === "web") {
    const html = await readFile(join(source, runtime.entry), "utf8");
    if (!/<html[\s>]/i.test(html)) fail("Web runtime entry is not HTML");
    const preload = manifest.preload ? await readFile(join(source, manifest.preload), "utf8") : "";
    if (Object.keys(manifest.tools || {}).length && !/registerTool\s*\(/.test(preload)) fail("Web tool template must register tools through Host Bridge");
    return { runtime: "web", transport: "host_bridge", tool_count: Object.keys(manifest.tools || {}).length };
  }
  const executable = runtime.kind === "node" ? process.execPath : builtRust.executable;
  const args = runtime.kind === "node" ? [join(source, runtime.entry)] : [];
  const messages = [];
  let id = 1;
  if (runtime.transport === "mcp_stdio") {
    messages.push({ jsonrpc: "2.0", id: id++, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "atools-packager", version: "3.0.0" } } });
    messages.push({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }
  const listId = id++;
  const callId = id++;
  messages.push({ jsonrpc: "2.0", id: listId, method: "tools/list", params: {} });
  messages.push({ jsonrpc: "2.0", id: callId, method: "tools/call", params: { name: "echo", arguments: { message: "ATools smoke" } } });
  const results = await sidecarRequest(executable, args, messages);
  const tools = results[listId]?.tools;
  if (!Array.isArray(tools) || !tools.some((tool) => tool.name === "echo")) fail("sidecar smoke did not discover echo tool");
  const output = results[callId]?.structuredContent;
  if (output?.message !== "ATools smoke" || output?.runtime !== runtime.kind) fail("sidecar echo smoke returned an invalid structured result");
  return { runtime: runtime.kind, transport: runtime.transport, tool_count: tools.length, structured_output: output };
}

let crcTable;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      return value >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function deterministicZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files.sort((left, right) => left.name.localeCompare(right.name))) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.from(file.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(((file.mode || 0o644) & 0xffff) << 16, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export async function packagePlugin(options) {
  const source = resolve(options.source);
  const manifestPath = join(source, "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const { runtime, entry } = validateManifest(manifest);
  let builtRust = null;
  if (runtime.kind === "rust") {
    if (!options.buildRust) fail("Rust plugin packaging requires --build-rust");
    builtRust = await buildRust(source, entry);
  }
  const files = await collectFiles(source);
  const packaged = [];
  for (const file of files) {
    if (file.name === "plugin.json") continue;
    packaged.push({ name: file.name, data: await readFile(file.path), mode: file.mode || 0o644 });
  }
  if (runtime.kind === "rust") packaged.push(builtRust);
  else if (!packaged.some((file) => file.name === entry)) fail(`runtime entry does not exist: ${entry}`);
  packaged.push({ name: "plugin.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), mode: 0o644 });
  const smoke = await smokeRuntime(source, manifest, builtRust);
  const archive = deterministicZip(packaged);
  const checksum = createHash("sha256").update(archive).digest("hex");
  const output = resolve(options.output || join(source, "dist", `${manifest.name}-${manifest.version || "0.0.0"}.zip`));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, archive);
  await writeFile(`${output}.sha256`, `${checksum}  ${output.split(sep).pop()}\n`);
  return { source, output, checksum: `sha256:${checksum}`, bytes: archive.length, files: packaged.length, smoke };
}

function parseArgs(args) {
  const options = { source: ".", output: "", buildRust: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--source") options.source = args[++index] || options.source;
    else if (args[index] === "--output") options.output = args[++index] || "";
    else if (args[index] === "--build-rust") options.buildRust = true;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await packagePlugin(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}
