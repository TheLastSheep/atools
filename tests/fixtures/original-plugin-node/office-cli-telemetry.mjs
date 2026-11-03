function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(table, key) {
  Object.defineProperty(table, key, { value: (Object.hasOwn(table, key) ? table[key] : 0) + 1,
    writable: true, enumerable: true, configurable: true });
}

function recordOfficeCliEvent(stats, event) {
  const telemetry = stats.helperProcesses;
  if (!telemetry || !isRecord(event) || event.pluginId !== stats.pluginId) return;
  const names = new Set(["attempt", "spawn", "exit", "close", "error", "kill", "denied", "deadline", "cleanupUnconfirmed"]);
  if (!names.has(event.event) || !["version", "view", "other"].includes(event.operation)) return;
  const entry = { event: event.event, operation: event.operation };
  if (Number.isSafeInteger(event.pid) && event.pid > 0) entry.pid = event.pid;
  if (Number.isInteger(event.code) || event.code === null
    || (event.event === "error" && typeof event.code === "string" && event.code.length <= 64)) entry.code = event.code;
  if (typeof event.signal === "string" && event.signal.length <= 16) entry.signal = event.signal;
  if (typeof event.reason === "string" && event.reason.length <= 32) entry.reason = event.reason;
  if (typeof event.stdioClosed === "boolean") entry.stdioClosed = event.stdioClosed;
  if (typeof event.accepted === "boolean") entry.accepted = event.accepted;

  if (event.event === "attempt") {
    telemetry.attempts++;
    if (event.operation === "version") telemetry.versionCalls++;
    if (event.operation === "view") telemetry.viewCalls++;
  } else if (event.event === "spawn") {
    telemetry.started++;
    if (entry.pid) {
      telemetry.activePids.add(entry.pid);
      if (telemetry.pids.length < 16) telemetry.pids.push(entry.pid);
    }
  } else if (event.event === "exit") {
    telemetry.exited++;
    if (event.code !== 0) telemetry.nonzeroExits++;
  } else if (event.event === "close") {
    telemetry.closed++;
    if (entry.pid) telemetry.activePids.delete(entry.pid);
  } else if (event.event === "error") telemetry.errors++;
  else if (event.event === "kill") {
    telemetry.killRequests++;
    if (event.accepted) telemetry.killed++;
  } else if (event.event === "denied") telemetry.denials++;
  else if (event.event === "deadline") telemetry.deadlines++;
  else if (event.event === "cleanupUnconfirmed") telemetry.cleanupFailures++;
  telemetry.events.push(entry);
  if (telemetry.events.length > 32) telemetry.events.splice(0, telemetry.events.length - 32);
}

/** Parse newline-framed helper-policy diagnostics from the product Node stderr stream. */
export function createOfficeCliTelemetryLineParser(stats, diagnosticPrefix) {
  let remainder = "";
  const helperMarker = `${diagnosticPrefix}_OFFICECLI_EVENT `;
  const denialMarker = `${diagnosticPrefix}_DENIAL `;
  function parseLine(line) {
    if (line.startsWith(helperMarker)) {
      try { recordOfficeCliEvent(stats, JSON.parse(line.slice(helperMarker.length))); }
      catch { /* Diagnostic marker only. */ }
      return;
    }
    if (!line.startsWith(denialMarker)) return;
    try {
      const denial = JSON.parse(line.slice(denialMarker.length));
      if (denial.pluginId === stats.pluginId && ["childProcess", "externalNetwork"].includes(denial.kind)) {
        count(stats.denials, denial.kind);
      }
    } catch { /* Diagnostic marker only. */ }
  }
  return {
    push(chunk) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const lines = (remainder + text).split(/\r?\n/u);
      remainder = lines.pop() ?? "";
      for (const line of lines) parseLine(line);
    },
    flush() {
      if (remainder) parseLine(remainder);
      remainder = "";
    },
  };
}
