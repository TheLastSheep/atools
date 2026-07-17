import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const VAULT_PREFIX = "/PasteboardPro/v1/";
const MAX_REQUEST_BYTES = 141 * 1_024 * 1_024;

export async function createPasteboardProWebDavFixtureServer(options = {}) {
  const root = options.root ?? await mkdtemp(path.join(tmpdir(), "pasteboardpro-webdav-"));
  const ownsRoot = options.root === undefined;
  const username = options.username ?? "fixture-user";
  const password = options.password ?? "fixture-password";
  const expectedAuthorization = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
  const faults = [];
  const requests = [];
  const counters = {
    conditionalConflicts: 0,
    injectedResponses: 0,
    interruptedUploads: 0,
    corruptedFiles: 0,
  };

  await mkdir(root, { recursive: true });

  const server = createServer(async (request, response) => {
    const startedAt = Date.now();
    const method = request.method ?? "GET";
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const relativePath = fixtureRelativePath(requestUrl.pathname);
    const requestRecord = {
      method,
      path: relativePath,
      status: 500,
      startedAt,
      durationMs: 0,
    };
    requests.push(requestRecord);

    const finish = (status, headers = {}, body = undefined) => {
      requestRecord.status = status;
      requestRecord.durationMs = Date.now() - startedAt;
      response.writeHead(status, {
        "cache-control": "no-store",
        ...headers,
      });
      response.end(body);
    };

    try {
      if (relativePath === undefined) {
        finish(404);
        return;
      }
      if (!safeAuthorization(request.headers.authorization, expectedAuthorization)) {
        finish(401, { "www-authenticate": 'Basic realm="PasteboardPro fixture"' });
        return;
      }

      const fault = takeFault(faults, method, relativePath);
      if (fault?.mode === "response") {
        counters.injectedResponses += 1;
        finish(fault.status, { "x-pasteboardpro-fixture-fault": "response" });
        return;
      }
      if (fault?.mode === "disconnect") {
        counters.interruptedUploads += 1;
        request.once("data", () => request.socket.destroy());
        request.resume();
        return;
      }

      const destination = safeDestination(root, relativePath);
      if (method === "MKCOL") {
        await mkdir(destination, { recursive: false });
        finish(201);
        return;
      }
      if (method === "PROPFIND") {
        const entries = await directoryEntries(destination, relativePath);
        finish(207, { "content-type": "application/xml; charset=utf-8" }, propfindXml(entries));
        return;
      }
      if (method === "GET") {
        let body;
        try {
          body = await readFile(destination);
        } catch (error) {
          if (error?.code === "ENOENT" || error?.code === "EISDIR") {
            finish(404);
            return;
          }
          throw error;
        }
        finish(200, {
          "content-length": String(body.byteLength),
          "content-type": contentType(relativePath),
          etag: etag(body),
        }, body);
        return;
      }
      if (method === "PUT") {
        const current = await optionalFile(destination);
        const currentEtag = current === undefined ? undefined : etag(current);
        const ifNoneMatch = request.headers["if-none-match"];
        const ifMatch = request.headers["if-match"];
        if (
          (ifNoneMatch === "*" && current !== undefined) ||
          (typeof ifMatch === "string" && ifMatch !== currentEtag)
        ) {
          counters.conditionalConflicts += 1;
          finish(412, currentEtag === undefined ? {} : { etag: currentEtag });
          return;
        }
        const body = await requestBody(request);
        await mkdir(path.dirname(destination), { recursive: true });
        const temporary = `${destination}.upload-${process.pid}-${Date.now()}`;
        await writeFile(temporary, body, { flag: "wx" });
        await rename(temporary, destination);
        const nextEtag = etag(body);
        finish(current === undefined ? 201 : 204, { etag: nextEtag });
        return;
      }
      finish(405, { allow: "GET, PUT, MKCOL, PROPFIND" });
    } catch (error) {
      if (error?.code === "EEXIST") {
        finish(405);
        return;
      }
      if (error?.code === "ENOENT") {
        finish(404);
        return;
      }
      if (!response.headersSent && !response.destroyed) {
        finish(500, { "content-type": "text/plain; charset=utf-8" }, String(error?.message ?? error));
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fixture server did not expose a TCP address");
  }

  return {
    root,
    username,
    password,
    url: `http://127.0.0.1:${address.port}${VAULT_PREFIX}`,
    requests,
    counters,
    injectResponse({ method, path: faultPath, status, count = 1 }) {
      faults.push({ mode: "response", method, path: normalizeFixturePath(faultPath), status, count });
    },
    interruptUpload({ path: faultPath, count = 1 }) {
      faults.push({ mode: "disconnect", method: "PUT", path: normalizeFixturePath(faultPath), count });
    },
    async corrupt(relative, transform = defaultCorruption) {
      const normalized = normalizeFixturePath(relative);
      const destination = safeDestination(root, normalized);
      const current = await readFile(destination);
      const corrupted = Buffer.from(transform(Buffer.from(current)));
      await writeFile(destination, corrupted);
      counters.corruptedFiles += 1;
      return { path: normalized, etag: etag(corrupted), bytes: corrupted.byteLength };
    },
    async snapshot() {
      return await snapshotDirectory(root);
    },
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      if (ownsRoot) await rm(root, { recursive: true, force: true });
    },
  };
}

function fixtureRelativePath(pathname) {
  if (!pathname.startsWith(VAULT_PREFIX)) return undefined;
  try {
    return normalizeFixturePath(decodeURIComponent(pathname.slice(VAULT_PREFIX.length)));
  } catch {
    return undefined;
  }
}

function normalizeFixturePath(value) {
  const normalized = value.replace(/^\/+|\/+$/g, "");
  if (normalized.length === 0) return "";
  if (
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    normalized.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new TypeError("Fixture path escaped the vault");
  }
  return normalized;
}

function safeDestination(root, relative) {
  const destination = path.resolve(root, relative);
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  if (destination !== path.resolve(root) && !destination.startsWith(rootPrefix)) {
    throw new TypeError("Fixture path escaped the temporary root");
  }
  return destination;
}

function safeAuthorization(actual, expected) {
  if (typeof actual !== "string") return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes);
}

function takeFault(faults, method, relativePath) {
  const fault = faults.find((candidate) =>
    candidate.count > 0 &&
    candidate.method === method &&
    (candidate.path === relativePath || candidate.path === "*")
  );
  if (fault === undefined) return undefined;
  fault.count -= 1;
  return fault;
}

async function requestBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.byteLength;
    if (bytes > MAX_REQUEST_BYTES) throw new RangeError("Fixture upload exceeds 141 MiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function optionalFile(destination) {
  try {
    return await readFile(destination);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EISDIR") return undefined;
    throw error;
  }
}

function etag(body) {
  return `"sha256-${createHash("sha256").update(body).digest("hex")}"`;
}

function contentType(relative) {
  return relative.endsWith(".json") ? "application/json" : "application/octet-stream";
}

async function directoryEntries(destination, relative) {
  const details = await stat(destination);
  if (!details.isDirectory()) return [{ path: relative, directory: false }];
  const children = await readdir(destination, { withFileTypes: true });
  return [
    { path: relative, directory: true },
    ...children.map((entry) => ({
      path: [relative, entry.name].filter(Boolean).join("/"),
      directory: entry.isDirectory(),
    })),
  ];
}

function propfindXml(entries) {
  const responses = entries.map((entry) => {
    const href = `${VAULT_PREFIX}${entry.path}${entry.directory && entry.path.length > 0 ? "/" : ""}`;
    return `<d:response><d:href>${escapeXml(href)}</d:href><d:propstat><d:prop><d:resourcetype>${entry.directory ? "<d:collection/>" : ""}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  }).join("");
  return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${responses}</d:multistatus>`;
}

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function snapshotDirectory(root, relative = "") {
  const output = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) output.push(...await snapshotDirectory(root, child));
    else {
      const body = await readFile(path.join(root, child));
      output.push({ path: child.split(path.sep).join("/"), bytes: body.byteLength, etag: etag(body) });
    }
  }
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

function defaultCorruption(body) {
  if (body.byteLength === 0) return Buffer.from([0xff]);
  const corrupted = Buffer.from(body);
  corrupted[Math.floor(corrupted.byteLength / 2)] ^= 0xff;
  return corrupted;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const fixture = await createPasteboardProWebDavFixtureServer();
  console.log(JSON.stringify({ url: fixture.url, username: fixture.username, password: fixture.password, root: fixture.root }));
  const stop = async () => {
    await fixture.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
