import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

export async function launchChrome() {
  const chromePath = await findChromePath();
  const userDataDir = await mkdtemp(join(tmpdir(), "atools-chrome-"));
  const chromeProcess = spawn(chromePath, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-features=MediaRouter,Translate",
    "--disable-gpu",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-default-browser-check",
    "--no-first-run",
    "about:blank",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const webSocketUrl = await waitForChromeWebSocketUrl(chromeProcess);
  return {
    webSocketUrl,
    close: async () => {
      if (chromeProcess.exitCode === null && chromeProcess.signalCode === null) {
        chromeProcess.kill("SIGTERM");
      }
      const exited = await waitForProcessExit(chromeProcess, 3000);
      if (!exited && chromeProcess.exitCode === null && chromeProcess.signalCode === null) {
        chromeProcess.kill("SIGKILL");
        await waitForProcessExit(chromeProcess, 1000);
      }
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

export async function launchViteServer(options = {}) {
  const host = options.host || "127.0.0.1";
  const port = Number(options.port ?? 1420);
  const cwd = options.cwd || new URL("..", import.meta.url).pathname;
  const probeUrl = options.probeUrl || `http://localhost:${port}/?parity=1`;
  const viteEntry = join(cwd, "node_modules", "vite", "bin", "vite.js");
  const child = spawn(process.execPath, [viteEntry, "--host", host, "--port", String(port), "--strictPort"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  try {
    await waitForViteReady(child, () => output, { host, port, probeUrl, timeoutMs: options.timeoutMs ?? 20000 });
  } catch (error) {
    child.kill("SIGTERM");
    await waitForProcessExit(child, 3000);
    throw new Error(`${error.message}\nVite output:\n${output}`);
  }
  return {
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      const exited = await waitForProcessExit(child, 3000);
      if (!exited && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForProcessExit(child, 1000);
      }
    },
  };
}

export async function createPageWebSocketUrl(browserWebSocketUrl) {
  const browserUrl = new URL(browserWebSocketUrl);
  const endpoint = `http://${browserUrl.hostname}:${browserUrl.port}/json/new?about:blank`;
  let response = await fetch(endpoint, { method: "PUT" });
  if (!response.ok) {
    response = await fetch(endpoint);
  }
  assert.equal(response.ok, true, `Chrome /json/new failed with ${response.status}`);
  const page = await response.json();
  assert.ok(page.webSocketDebuggerUrl, "Chrome /json/new should return a page WebSocket URL");
  return page.webSocketDebuggerUrl;
}

export class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
    ws.onMessage((message) => this.handleMessage(message));
  }

  static async connect(url) {
    return new CdpClient(await WebSocketConnection.connect(url));
  }

  on(method, handler) {
    const handlers = this.eventHandlers.get(method) || [];
    handlers.push(handler);
    this.eventHandlers.set(method, handlers);
  }

  send(method, params = {}, options = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer;
      const timeoutMs = Number(options.timeoutMs ?? 0);
      const settle = (callback, value) => {
        if (timer) clearTimeout(timer);
        callback(value);
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Timed out running CDP command ${method}`));
        }, timeoutMs);
      }
      this.pending.set(id, {
        resolve: (value) => settle(resolve, value),
        reject: (error) => settle(reject, error),
      });
      try {
        this.ws.sendJson({ id, method, params });
      } catch (error) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  waitForEvent(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for CDP event ${method}`)), timeoutMs);
      const handler = (params) => {
        clearTimeout(timer);
        const handlers = this.eventHandlers.get(method) || [];
        this.eventHandlers.set(method, handlers.filter((candidate) => candidate !== handler));
        resolve(params);
      };
      this.on(method, handler);
    });
  }

  handleMessage(message) {
    const data = JSON.parse(message);
    if (data.id) {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (data.error) {
        pending.reject(new Error(`${data.error.message || "CDP error"} (${data.error.code})`));
      } else {
        pending.resolve(data.result || {});
      }
      return;
    }
    if (data.method) {
      for (const handler of this.eventHandlers.get(data.method) || []) {
        handler(data.params || {});
      }
    }
  }

  async close() {
    await this.ws.close();
  }
}

export function formatConsoleArgs(args = []) {
  return args.map((arg) => arg.value ?? arg.description ?? arg.type).join(" ");
}

export function assertCheckedChecklistRow(checklist, row) {
  const checkedRowPattern = new RegExp(`^- \\[x\\] ${escapeRegExp(row)}`, "m");
  assert.ok(
    checkedRowPattern.test(checklist),
    `Expected checked macOS smoke checklist row containing: ${row}`,
  );
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findChromePath() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next common local browser path.
    }
  }
  assert.fail("Google Chrome or Chromium is required for Browser smoke");
}

function waitForChromeWebSocketUrl(chromeProcess) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    const timer = setTimeout(() => finish(reject, new Error(`Timed out waiting for Chrome DevTools URL: ${output}`)), 10000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        finish(resolve, match[1]);
      }
    };
    const onExit = (code, signal) => finish(reject, new Error(`Chrome exited before DevTools was ready: code=${code} signal=${signal} ${output}`));
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chromeProcess.stdout.off("data", onData);
      chromeProcess.stderr.off("data", onData);
      chromeProcess.off("exit", onExit);
      callback(value);
    };
    chromeProcess.stdout.on("data", onData);
    chromeProcess.stderr.on("data", onData);
    chromeProcess.once("exit", onExit);
  });
}

class WebSocketConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.messageHandlers = [];
    socket.on("data", (chunk) => this.handleData(chunk));
  }

  static async connect(url) {
    const parsed = new URL(url);
    assert.equal(parsed.protocol, "ws:", "Only ws:// DevTools URLs are supported");
    const socket = createConnection({
      host: parsed.hostname,
      port: Number(parsed.port),
    });
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const key = randomBytes(16).toString("base64");
    socket.write([
      `GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
      `Host: ${parsed.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"));
    const rest = await readHandshake(socket, key);
    const connection = new WebSocketConnection(socket);
    if (rest.length > 0) {
      connection.handleData(rest);
    }
    return connection;
  }

  onMessage(handler) {
    this.messageHandlers.push(handler);
  }

  sendJson(data) {
    this.socket.write(encodeClientFrame(1, Buffer.from(JSON.stringify(data))));
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const frame = decodeServerFrame(this.buffer);
      if (!frame) return;
      this.buffer = this.buffer.subarray(frame.bytes);
      if (frame.opcode === 1) {
        const message = frame.payload.toString("utf8");
        for (const handler of this.messageHandlers) handler(message);
      } else if (frame.opcode === 8) {
        this.socket.end();
      } else if (frame.opcode === 9) {
        this.socket.write(encodeClientFrame(10, frame.payload));
      }
    }
  }

  close() {
    return new Promise((resolve) => {
      if (this.socket.destroyed) {
        resolve();
        return;
      }
      this.socket.once("close", resolve);
      this.socket.end(encodeClientFrame(8, Buffer.alloc(0)));
    });
  }
}

function waitForViteReady(child, readOutput, options) {
  const { host, port, probeUrl, timeoutMs } = options;
  const readyPattern = new RegExp(`Local:\\s+http://${escapeRegExp(host)}:${port}/`);
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastError;
    const timer = setTimeout(() => {
      finish(reject, new Error(`Timed out waiting for Vite server: ${lastError?.message || "ready URL not printed"}`));
    }, timeoutMs);
    const interval = setInterval(() => {
      void checkReady();
    }, 250);
    const onData = () => {
      void checkReady();
    };
    const onError = (error) => finish(reject, error);
    const onExit = (code, signal) => finish(reject, new Error(`Vite exited before ready: code=${code} signal=${signal}`));
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(interval);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      callback(value);
    };
    const checkReady = async () => {
      if (!readyPattern.test(readOutput())) return;
      try {
        const response = await fetch(probeUrl);
        await response.body?.cancel();
        if (response.ok) {
          finish(resolve);
          return;
        }
        lastError = new Error(`HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    void checkReady();
  });
}

function readHandshake(socket, key) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      socket.off("data", onData);
      socket.off("error", onError);
      try {
        const header = buffer.subarray(0, headerEnd).toString("utf8");
        assert.match(header, /^HTTP\/1\.1 101 /, `Unexpected WebSocket handshake response: ${header}`);
        const expectedAccept = createHash("sha1")
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        assert.match(header, new RegExp(`Sec-WebSocket-Accept: ${escapeRegExp(expectedAccept)}`, "i"));
        resolve(buffer.subarray(headerEnd + 4));
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error) => {
      socket.off("data", onData);
      reject(error);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

function encodeClientFrame(opcode, payload) {
  const length = payload.length;
  const extended = length < 126 ? 0 : length <= 0xffff ? 2 : 8;
  const header = Buffer.alloc(2 + extended + 4);
  header[0] = 0x80 | opcode;
  if (length < 126) {
    header[1] = 0x80 | length;
  } else if (length <= 0xffff) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const maskOffset = 2 + extended;
  const mask = randomBytes(4);
  mask.copy(header, maskOffset);
  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, masked]);
}

function decodeServerFrame(buffer) {
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  const maskOffset = masked ? 4 : 0;
  if (buffer.length < offset + maskOffset + length) return null;
  let payload = buffer.subarray(offset + maskOffset, offset + maskOffset + length);
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
  }
  return {
    opcode,
    payload,
    bytes: offset + maskOffset + length,
  };
}

function waitForProcessExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
