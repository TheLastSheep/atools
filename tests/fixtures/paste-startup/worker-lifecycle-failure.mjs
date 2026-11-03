import { parentPort, workerData } from "node:worker_threads";

if (workerData.mode === "exit-zero") {
  setImmediate(() => parentPort.close());
} else if (workerData.mode === "wait-for-abort") {
  parentPort.on("message", message => {
    if (message?.command !== "abortStartup") return;
    parentPort.postMessage({ type: "abort-observed" });
    parentPort.postMessage({ id: message.id, result: { childExit: { notStarted: true } } });
    parentPort.close();
  });
} else if (workerData.mode === "ready" || workerData.mode === "ready-shutdown-timeout") {
  parentPort.postMessage({
    type: "ready",
    endpoints: { node: "", data: "", history: "", write: "", contentWrite: "", secret: "" },
    initialization: { protocolVersion: 1, nodeVersion: "test-only", pid: 0 },
  });
  parentPort.on("message", message => {
    if (message?.command === "hold") return;
    if (workerData.mode === "ready-shutdown-timeout" && message?.command === "shutdown") return;
    if (message?.command === "abortStartup") {
      parentPort.postMessage({ type: "abort-observed" });
      parentPort.postMessage({ id: message.id, result: { childExit: { notStarted: true } } });
      parentPort.close();
      return;
    }
    if (message?.command !== "shutdown") return;
    parentPort.postMessage({ id: message.id, result: { childExit: { notStarted: true } } });
    parentPort.close();
  });
} else {
  throw new Error(`Unknown test-only Worker mode: ${String(workerData.mode)}`);
}
