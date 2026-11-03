import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { createServer } from "node:http";

const CONTENT_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
});

export const RETIRED_TARGET_PATH = "/setting/__atools_retired_target__.html";
const RETIRED_TARGET_HTML = "<!doctype html><html><head><meta charset=\"utf-8\"></head><body><main data-atools-retired-target=\"true\"></main></body></html>";

export function isBrowserGeneratedFaviconRequest({ method, requestTarget, url, hostHeader, expectedHost, expectedOrigin }) {
  return method === "GET" && requestTarget === "/favicon.ico" && url instanceof URL &&
    hostHeader === expectedHost && url.origin === expectedOrigin &&
    url.href === `${expectedOrigin}/favicon.ico`;
}

export function isRetiredTargetRequest({ method, requestTarget, url, hostHeader, expectedHost, expectedOrigin }) {
  return method === "GET" && requestTarget === RETIRED_TARGET_PATH && url instanceof URL &&
    hostHeader === expectedHost && url.origin === expectedOrigin &&
    url.href === `${expectedOrigin}${RETIRED_TARGET_PATH}`;
}

function mainQueryAllowed(url) {
  if (!url.search) return true;
  if (!new Set(["/main", "/main/", "/main/index.html"]).has(url.pathname)) return false;
  const params = [...url.searchParams.entries()];
  const values = Object.fromEntries(params);
  return params.length === 3 && new Set(params.map(([key]) => key)).size === 3 &&
    Object.keys(values).every((key) => ["color", "scheme", "autoClear"].includes(key)) &&
    ["green", "blue"].includes(values.color) && ["light", "dark"].includes(values.scheme) &&
    ["immediately", "never"].includes(values.autoClear);
}

function safeRelativePath(rawPath) {
  let decoded;
  try { decoded = decodeURIComponent(rawPath); }
  catch { return null; }
  if (!decoded || decoded.includes("\0") || decoded.includes("\\") || decoded.startsWith("/")) return null;
  const segments = decoded.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return segments.join("/");
}

export async function startZtoolsSettingsInputStaticServer({ distRoots, servedPaths, host = "127.0.0.1" }) {
  assert.deepEqual(Object.keys(distRoots).sort(), ["main", "setting"]);
  assert.deepEqual(Object.keys(servedPaths).sort(), ["main", "setting"]);
  const roots = {};
  const allowed = {};
  for (const prefix of ["main", "setting"]) {
    roots[prefix] = await realpath(distRoots[prefix]);
    allowed[prefix] = new Set(servedPaths[prefix]);
    assert.ok(allowed[prefix].has("index.html"), `${prefix} dist whitelist must include index.html`);
  }

  const state = {
    requests: [], rejected: 0, bytesServed: 0, closed: false,
    browserGeneratedFavicon: { requestCount: 0, responseStatus: 204 },
    retiredTargetRequests: 0,
  };
  const server = createServer(async (request, response) => {
    const hostHeader = request.headers.host || "";
    let url;
    try { url = new URL(request.url || "/", `http://${hostHeader}`); }
    catch { reject(400, "invalid request URL"); return; }
    const expectedHost = `${host}:${server.address()?.port}`;
    const expectedOrigin = `http://${expectedHost}`;
    if (isRetiredTargetRequest({
      method: request.method,
      requestTarget: request.url,
      url,
      hostHeader,
      expectedHost,
      expectedOrigin,
    })) {
      state.retiredTargetRequests += 1;
      state.requests.push({ prefix: "setting", path: RETIRED_TARGET_PATH.slice("/setting/".length),
        status: 200, harnessDocument: "retired-target" });
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(Buffer.byteLength(RETIRED_TARGET_HTML)),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(RETIRED_TARGET_HTML);
      return;
    }
    if (isBrowserGeneratedFaviconRequest({
      method: request.method,
      requestTarget: request.url,
      url,
      hostHeader,
      expectedHost,
      expectedOrigin,
    })) {
      state.browserGeneratedFavicon.requestCount += 1;
      state.requests.push({ prefix: null, path: "/favicon.ico", status: 204, browserGeneratedFavicon: true });
      response.writeHead(204, { "cache-control": "no-store", "x-content-type-options": "nosniff" });
      response.end();
      return;
    }
    const prefix = url.pathname.startsWith("/main/") || url.pathname === "/main" ? "main"
      : url.pathname.startsWith("/setting/") || url.pathname === "/setting" ? "setting" : null;
    if (request.method !== "GET" || !prefix || request.headers.host !== expectedHost) {
      reject(404, "request is outside the owned dist server");
      return;
    }
    if ((prefix === "main" && !mainQueryAllowed(url)) || (prefix === "setting" && url.search)) {
      reject(404, "request query is not allowed");
      return;
    }
    const rawPath = url.pathname === `/${prefix}` || url.pathname === `/${prefix}/`
      ? "index.html" : url.pathname.slice(prefix.length + 2);
    const relativePath = safeRelativePath(rawPath);
    if (!relativePath || !allowed[prefix].has(relativePath)) {
      reject(404, "dist path is not in the runtime whitelist");
      return;
    }
    const absolute = resolve(roots[prefix], relativePath);
    const rel = relative(roots[prefix], absolute);
    if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      reject(404, "dist path escaped its root");
      return;
    }
    try {
      const bytes = await readFile(absolute);
      if (bytes.byteLength > 16 * 1024 * 1024) {
        reject(413, "dist file exceeds the runner cap");
        return;
      }
      state.requests.push({ prefix, path: relativePath, status: 200, bytes: bytes.byteLength });
      state.bytesServed += bytes.byteLength;
      response.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(relativePath).toLowerCase()] || "application/octet-stream",
        "content-length": String(bytes.byteLength),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(bytes);
    } catch {
      reject(404, "dist file is unavailable");
    }

    function reject(statusCode, reason) {
      state.rejected += 1;
      state.requests.push({ prefix, path: url?.pathname || "<invalid>", status: statusCode, reason });
      response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("not found");
    }
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, host, () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  assert.equal(address.address, host);
  const port = address.port;
  const origin = `http://${host}:${port}`;
  let closed = false;
  return {
    origin,
    retiredUrl: `${origin}${RETIRED_TARGET_PATH}`,
    port,
    state,
    async close() {
      if (closed) return state;
      server.closeAllConnections?.();
      await new Promise((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
      state.closed = true;
      closed = true;
      return state;
    },
  };
}

