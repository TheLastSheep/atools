import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".wasm", "application/wasm"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".eot", "application/vnd.ms-fontobject"],
]);

const BAD_REQUEST = Symbol("badRequest");

function corsHeaders(request) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": request.headers["access-control-request-headers"] || "Content-Type, Range, Accept, Origin, X-Requested-With",
    "Access-Control-Max-Age": "600",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Cache-Control": "no-cache",
  };
}

function resolveRequestPath(root, requestUrl) {
  let pathname;
  try {
    const parsed = new URL(requestUrl || "/", "http://atools-fixture.local");
    pathname = decodeURIComponent(parsed.pathname || "/");
  } catch {
    return BAD_REQUEST;
  }
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = resolve(root, relativePath);
  const normalizedRoot = resolve(root);
  if (candidate !== normalizedRoot && !candidate.startsWith(`${normalizedRoot}${sep}`)) {
    return null;
  }
  return candidate;
}

function contentType(path) {
  return MIME_TYPES.get(extname(path).toLowerCase()) || "application/octet-stream";
}

export async function createZToolsUiHostFixtureServer(options = {}) {
  const root = resolve(options.root || "output/ztools-ui-host-real-entry-fixtures");
  const host = options.host || "127.0.0.1";
  const port = Number(options.port ?? 1434);
  const server = createServer(async (request, response) => {
    const headers = corsHeaders(request);
    if (request.method === "OPTIONS") {
      response.writeHead(204, headers);
      response.end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, headers);
      response.end("Method Not Allowed");
      return;
    }

    const path = resolveRequestPath(root, request.url);
    if (path === BAD_REQUEST) {
      response.writeHead(400, headers);
      response.end("Bad Request");
      return;
    }
    if (!path) {
      response.writeHead(403, headers);
      response.end("Forbidden");
      return;
    }

    let filePath = path;
    let fileStat = null;
    try {
      fileStat = await stat(filePath);
      if (fileStat.isDirectory()) {
        filePath = join(filePath, "index.html");
        fileStat = await stat(filePath);
      }
    } catch {
      response.writeHead(404, headers);
      response.end("Not Found");
      return;
    }
    if (!fileStat.isFile()) {
      response.writeHead(404, headers);
      response.end("Not Found");
      return;
    }

    response.writeHead(200, {
      ...headers,
      "Content-Type": contentType(filePath),
      "Content-Length": String(fileStat.size),
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(filePath).pipe(response);
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    root,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}/`,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    }),
  };
}

function parseArgs(args) {
  const options = {
    root: "output/ztools-ui-host-real-entry-fixtures",
    host: "127.0.0.1",
    port: 1434,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--root") {
      options.root = args[index + 1] || options.root;
      index += 1;
    } else if (arg === "--host") {
      options.host = args[index + 1] || options.host;
      index += 1;
    } else if (arg === "--port") {
      options.port = Number(args[index + 1] || options.port);
      index += 1;
    }
  }
  return options;
}

async function main() {
  const server = await createZToolsUiHostFixtureServer(parseArgs(process.argv.slice(2)));
  console.log(`Serving ZTools UI host fixtures from ${server.root}`);
  console.log(`Fixture URL: ${server.url}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).toString()) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
