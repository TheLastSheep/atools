/** Bounded, redacted startup observations for the isolated paintbrush Chromium fixture. */
export class PaintbrushCdpStartupObserver {
  constructor(page) {
    this.page = page;
    this.stage = "browser-startup";
    this.events = [];
    this.utf8Bytes = 0;
    this.dropped = 0;
    this.navigation = null;
    this.networkEvents = [];
    this.networkEventBytes = 0;
    this.networkDropped = 0;
    this.networkCounts = { requestWillBeSent: 0, responseReceived: 0, loadingFailed: 0 };
    this.requestMeta = new Map();
    page.on("Runtime.exceptionThrown", (params) => {
      const details = params.exceptionDetails || {};
      const exception = details.exception || {};
      this.#record("exceptionThrown", exception.description || details.text || "Runtime exception",
        details.lineNumber ?? 0, exception.className || "Error");
    });
    page.on("Log.entryAdded", ({ entry = {} } = {}) => {
      if (entry.level === "error" || entry.level === "warning") {
        this.#record(`log-${entry.level}`, entry.text || "Browser log entry", entry.location?.lineNumber ?? 0, "Error");
      }
    });
    page.on("Network.requestWillBeSent", (params) => {
      const route = routeKind(params.request?.url);
      const method = safeMethod(params.request?.method);
      this.requestMeta.set(params.requestId, { route, method });
      if (this.requestMeta.size > 64) this.requestMeta.delete(this.requestMeta.keys().next().value);
      this.#networkRecord("requestWillBeSent", { route, method });
    });
    page.on("Network.responseReceived", (params) => {
      const meta = this.requestMeta.get(params.requestId) || { route: "other", method: "other" };
      this.#networkRecord("responseReceived", { ...meta, status: Number.isFinite(params.response?.status) ? params.response.status : null });
    });
    page.on("Network.loadingFailed", (params) => {
      const meta = this.requestMeta.get(params.requestId) || { route: "other", method: "other" };
      this.requestMeta.delete(params.requestId);
      this.#networkRecord("loadingFailed", { ...meta, error: safeMessage(params.errorText || "Network request failed") });
    });
  }

  async enable() {
    await this.page.send("Page.enable");
    await this.page.send("Runtime.enable");
    await this.page.send("Log.enable");
    await this.page.send("Network.enable");
  }

  setStage(stage) { this.stage = stage; }

  #record(kind, message, line, code) {
    const event = { kind, stage: this.stage,
      code: typeof code === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/.test(code) ? code : "Error",
      line: Number.isSafeInteger(line) && line >= 0 ? line : 0,
      message: String(message || "").replace(/data:[^,\s]+;base64,[A-Za-z0-9+/=]+/gi, "data:[redacted]")
        .replace(/\/(host|node)\/[a-f0-9]{64}/gi, "/$1/[redacted]")
        .replace(/https?:\/\/[^\s]+/gi, "[url]").split("\n", 1)[0].slice(0, 160) };
    const size = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    if (this.events.length >= 12 || this.utf8Bytes + size > 2048) { this.dropped++; return; }
    this.events.push(event);
    this.utf8Bytes += size;
  }

  snapshot() { return { events: [...this.events], utf8Bytes: this.utf8Bytes, dropped: this.dropped }; }

  networkSnapshot() { return { events: [...this.networkEvents], utf8Bytes: this.networkEventBytes, dropped: this.networkDropped,
    counts: { ...this.networkCounts } }; }

  #networkRecord(kind, details) {
    this.networkCounts[kind]++;
    const event = { kind, stage: this.stage, ...details };
    const size = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    if (this.networkEvents.length >= 12 || this.networkEventBytes + size > 2048) { this.networkDropped++; return; }
    this.networkEvents.push(event);
    this.networkEventBytes += size;
  }

  async navigateAndAwaitLoad(url, timeoutMs = 12000) {
    this.navigation = { navigateCommand: "pending", loadEvent: "pending" };
    const loadOutcome = this.page.waitForEvent("Page.loadEventFired", timeoutMs).then(
      (value) => { this.navigation.loadEvent = "observed"; return { kind: "load", value }; },
      (error) => { this.navigation.loadEvent = "failed"; this.navigation.loadError = safeMessage(error); return { kind: "load-error", error }; });
    const navigationOutcome = this.page.send("Page.navigate", { url }, { timeoutMs }).then(
      (value) => { this.navigation.navigateCommand = "returned"; return { kind: "navigation", value }; },
      (error) => { this.navigation.navigateCommand = "failed"; this.navigation.navigateError = safeMessage(error); return { kind: "navigation-error", error }; });
    // Rejections are converted to values immediately, including for the peer that may settle after failure.
    const first = await Promise.race([loadOutcome, navigationOutcome]);
    if (first.error) {
      this.navigation.pendingAtFailure = first.kind === "load-error" ? "navigateCommand" : "loadEvent";
      throw first.error;
    }
    const second = await (first.kind === "load" ? navigationOutcome : loadOutcome);
    if (second.error) throw second.error;
    const navigation = first.kind === "navigation" ? first : second;
    if (navigation.value.errorText) throw new Error(`Page.navigate: ${safeMessage(navigation.value.errorText)}`);
  }
}

function routeKind(value) {
  try {
    const path = new URL(value).pathname;
    if (/^\/fixture\/[a-f0-9]{64}$/.test(path)) return "parent";
    if (/^\/host\/[a-f0-9]{64}$/.test(path)) return "host";
    if (/^\/node\/[a-f0-9]{64}$/.test(path)) return "node";
  } catch { /* Do not retain malformed request URLs. */ }
  return "other";
}

function safeMethod(value) { return ["GET", "POST", "OPTIONS"].includes(value) ? value : "other"; }

function safeMessage(error) {
  return String(error?.message || error || "unknown").replace(/data:[^,\s]+;base64,[A-Za-z0-9+/=]+/gi, "data:[redacted]")
    .replace(/\/(host|node)\/[a-f0-9]{64}/gi, "/$1/[redacted]")
    .replace(/https?:\/\/[^\s]+/gi, "[url]").split("\n", 1)[0].slice(0, 160);
}
