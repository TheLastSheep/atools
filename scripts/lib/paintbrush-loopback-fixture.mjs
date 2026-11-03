import { createHash, randomBytes } from "node:crypto";
import { createServer, get } from "node:http";

const MAX_HEALTH_BYTES = 512 * 1024;

/** Owns the loopback-only parent and image routes plus bounded transport counters. */
export function createPaintbrushLoopbackFixture() {
  const token = randomBytes(32).toString("hex");
  const parentPath = `/fixture/${randomBytes(32).toString("hex")}`;
  const imagePath = `/host/${token}`;
  const sockets = new Set();
  const metrics = { tcpConnections: 0, requests: 0, rejectedRequests: 0, serverErrors: 0,
    healthRequests: 0, browserParentRequests: 0, healthResponseBytes: 0, browserParentResponseBytes: 0,
    imageRequests: 0, imagePreflights: 0, imageRequestBodyBytes: 0, imageResponseBytes: 0 };
  let currentImage = null, parentHtml = null, host = null;
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      metrics.serverErrors++;
      if (!response.headersSent) reject(response, 500);
      else response.destroy();
    });
  });

  async function handleRequest(request, response) {
    metrics.requests++;
    request.once("error", () => { metrics.serverErrors++; });
    response.once("error", () => { metrics.serverErrors++; });
    if (request.headers.host !== host) return reject(response, 401);
    if (request.method === "GET" && request.url === parentPath && parentHtml !== null) {
      const health = request.headers["x-atools-fixture-parent-health"] === "1";
      if (health) metrics.healthRequests++; else metrics.browserParentRequests++;
      const bytes = Buffer.from(parentHtml);
      if (health) metrics.healthResponseBytes += bytes.length; else metrics.browserParentResponseBytes += bytes.length;
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Connection: "close" });
      response.end(bytes);
      return;
    }
    if (request.url !== imagePath || request.headers.origin !== "null") return reject(response, 401);
    if (request.method === "OPTIONS") {
      metrics.imagePreflights++;
      return send(response, 200, null, true);
    }
    if (request.method !== "POST") return reject(response, 405);
    const chunks = []; let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { metrics.rejectedRequests++; metrics.serverErrors++; request.destroy(); return; }
      chunks.push(chunk);
    }
    metrics.imageRequestBodyBytes += bytes;
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return reject(response, 400); }
    if (payload?.format !== "image" || !currentImage) return reject(response, 400);
    metrics.imageRequests++;
    const dataUrl = `data:image/png;base64,${currentImage.toString("base64")}`;
    const body = Buffer.from(JSON.stringify({ ok: true, result: { dataUrl, width: 1, height: 1 } }));
    metrics.imageResponseBytes += body.length;
    send(response, 200, body, true);
  }

  function reject(response, status) {
    metrics.rejectedRequests++;
    send(response, status, { ok: false, error: { message: "fixture route rejected" } }, false);
  }
  function send(response, status, body, cors) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", Connection: "close",
      ...(cors ? { "Access-Control-Allow-Origin": "null", "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Private-Network": "true" } : {}) });
    response.end(bytes);
  }

  server.on("connection", (socket) => {
    metrics.tcpConnections++;
    sockets.add(socket);
    socket.once("error", () => { metrics.serverErrors++; });
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("error", () => { metrics.serverErrors++; });
  server.on("clientError", () => { metrics.serverErrors++; });

  return {
    server, sockets, metrics,
    setImage(bytes) { currentImage = bytes; },
    setParentHtml(html) { parentHtml = html; },
    async listen() {
      await new Promise((resolve, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      host = `127.0.0.1:${address.port}`;
      const endpoint = `http://${host}${imagePath}`;
      const parentUrl = `http://${host}${parentPath}`;
      return { endpoint, parentUrl, port: address.port, readParentHealth: () => readParentHealth(parentUrl) };
    },
  };
}

function readParentHealth(parentUrl, timeoutMs = 2500) {
  const url = new URL(parentUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash
      || !/^\/fixture\/[a-f0-9]{64}$/.test(url.pathname)) {
    throw new Error("Parent health URL is outside the fixture loopback route");
  }
  return new Promise((resolve) => {
    let finished = false, responseBytes = 0;
    const chunks = [];
    const finish = (result) => {
      if (finished) return;
      finished = true;
      resolve({ transport: "direct-node-http-loopback", route: "parent", ...result });
    };
    const request = get({ hostname: "127.0.0.1", port: Number(url.port), path: url.pathname,
      method: "GET", headers: { "x-atools-fixture-parent-health": "1", connection: "close" } }, (response) => {
      response.on("data", (chunk) => {
        responseBytes += chunk.length;
        if (responseBytes > MAX_HEALTH_BYTES) {
          finish({ complete: false, statusCode: response.statusCode ?? null, bodyBytes: responseBytes, errorCode: "BODY_LIMIT" });
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.once("aborted", () => finish({ complete: false, statusCode: response.statusCode ?? null, bodyBytes: responseBytes, errorCode: "RESPONSE_ABORTED" }));
      response.once("error", (error) => finish({ complete: false, statusCode: response.statusCode ?? null, bodyBytes: responseBytes, errorCode: safeCode(error) }));
      response.once("end", () => {
        if (finished) return;
        const bytes = Buffer.concat(chunks);
        finish({ complete: true, statusCode: response.statusCode ?? null, bodyBytes: bytes.length,
          bodySha256: createHash("sha256").update(bytes).digest("hex") });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(Object.assign(new Error("health timeout"), { code: "ETIMEDOUT" })));
    request.once("error", (error) => finish({ complete: false, statusCode: null, bodyBytes: responseBytes, errorCode: safeCode(error) }));
  });
}

function safeCode(error) {
  const value = typeof error?.code === "string" ? error.code : "HTTP_ERROR";
  return /^[A-Z0-9_]{1,32}$/.test(value) ? value : "HTTP_ERROR";
}
