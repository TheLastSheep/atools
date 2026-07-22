import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

const appPath = "/Applications/ZTools.app";
const executablePath = `${appPath}/Contents/MacOS/ZTools`;
const iterations = Number(optionValue("--iterations") ?? 5);
const outputPath = optionValue("--output");
const runs = [];

for (let index = 0; index < iterations; index += 1) {
  terminateZTools();
  const port = 9240 + index;
  const startedAt = performance.now();
  const opened = spawnSync("open", ["-n", appPath, "--args", `--inspect=${port}`], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (opened.status !== 0) throw new Error(opened.stderr || "Failed to launch ZTools");

  const inspectorUrl = await waitForInspector(port, 10_000);
  const inspector = await openInspector(inspectorUrl);
  try {
    const ready = await waitForValue(async () => inspector.evaluate(`(async () => {
      try {
        const electron = process.mainModule?.require('electron');
        const window = electron?.BrowserWindow.getAllWindows()[0];
        if (!window || window.webContents.isLoading()) return null;
        const domReady = await window.webContents.executeJavaScript(
          "document.readyState === 'complete' && Boolean(document.querySelector('.search-input'))",
        );
        return domReady ? { url: window.webContents.getURL(), bounds: window.getBounds() } : null;
      } catch {
        return null;
      }
    })()`), 10_000);
    const launchToReadyMs = performance.now() - startedAt;

    const windowShowMs = await inspector.evaluate(`(() => {
      const electron = process.mainModule.require('electron');
      const window = electron.BrowserWindow.getAllWindows()[0];
      window.hide();
      const startedAt = performance.now();
      window.show();
      const elapsed = performance.now() - startedAt;
      window.hide();
      return elapsed;
    })()`);

    const search = await inspector.evaluate(`(async () => {
      const electron = process.mainModule.require('electron');
      const window = electron.BrowserWindow.getAllWindows()[0];
      await window.webContents.executeJavaScript(\`(async () => {
        document.querySelector('.plugin-tag-close')?.click();
        await new Promise(resolve => setTimeout(resolve, 250));
        const input = document.querySelector('.search-input');
        input.focus();
        input.select();
      })()\`);
      const startedAt = performance.now();
      window.webContents.insertText('color');
      let text = '';
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
        text = await window.webContents.executeJavaScript('document.body.innerText');
        if (text.includes('最佳搜索结果') && text.toLowerCase().includes('color')) {
          return { latency_ms: performance.now() - startedAt, matched: true };
        }
      }
      return { latency_ms: performance.now() - startedAt, matched: false };
    })()`);

    await new Promise(resolve => setTimeout(resolve, 500));
    runs.push({
      iteration: index + 1,
      launch_to_ready_ms: round(launchToReadyMs),
      window_show_ms: round(windowShowMs),
      search_latency_ms: round(search.latency_ms),
      search_matched: search.matched,
      rss_mib: round(ztoolsRssKiB() / 1024),
      ready,
    });
  } finally {
    inspector.close();
    terminateZTools();
  }
}

const report = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  app: {
    path: appPath,
    bundle_mib: round(pathBytes(appPath) / 1024 / 1024),
  },
  config: { iterations, query: "color" },
  metrics: {
    launch_to_ready_ms: distribution(runs.map(run => run.launch_to_ready_ms)),
    window_show_ms: distribution(runs.map(run => run.window_show_ms)),
    search_latency_ms: distribution(runs.map(run => run.search_latency_ms)),
    rss_mib: distribution(runs.map(run => run.rss_mib)),
  },
  runs,
};

if (outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(`ZTOOLS_RUNTIME_BENCHMARK ${JSON.stringify(report)}`);

async function openInspector(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.result?.exceptionDetails) {
      const details = message.result.exceptionDetails;
      request.reject(new Error(details.exception?.description ?? details.text));
    } else {
      request.resolve(message.result?.result?.value);
    }
  });
  return {
    evaluate(expression) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }));
      });
    },
    close() {
      socket.close();
    },
  };
}

async function waitForInspector(port, timeoutMs) {
  return waitForValue(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      return targets[0]?.webSocketDebuggerUrl ?? null;
    } catch {
      return null;
    }
  }, timeoutMs);
}

async function waitForValue(read, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function terminateZTools() {
  try {
    execFileSync("pkill", ["-9", "-f", `^${executablePath.replaceAll(" ", "\\ ")}`]);
  } catch {
    // No running process is the expected state between iterations.
  }
}

function ztoolsRssKiB() {
  const output = execFileSync("ps", ["-axo", "rss=,command="], { encoding: "utf8" });
  return output.split("\n").reduce((total, line) => {
    if (!line.includes(`${appPath}/Contents/`)) return total;
    const rss = Number(line.trim().split(/\s+/, 1)[0]);
    return total + (Number.isFinite(rss) ? rss : 0);
  }, 0);
}

function pathBytes(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return stat.size;
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((total, entry) => total + pathBytes(join(path, entry)), 0);
}

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0],
    max: sorted.at(-1),
  };
}

function percentile(sorted, percent) {
  return sorted[Math.ceil((percent / 100) * (sorted.length - 1))];
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}
