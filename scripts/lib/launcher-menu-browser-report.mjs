import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";

function errorDetails(failure) {
  return { name: failure?.name || "Error", message: String(failure?.message || failure),
    stack: failure?.stack || null, ...(failure?.code ? { code: failure.code } : {}),
    ...(failure instanceof AggregateError ? { errors: failure.errors.map(errorDetails) } : {}) };
}

/** Persists an immutable report; fallback delivery is itself a failed run. */
export async function writeLauncherBrowserReport(report, outputPath, { openImpl = open, randomUUIDImpl = randomUUID } = {}) {
  async function write(path) {
    const handle = await openImpl(path, "wx", 0o600);
    let failure;
    try { await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8"); }
    catch (error) { failure = error; }
    try { await handle.close(); }
    catch (error) { failure = failure ? new AggregateError([failure, error], "Report write and close both failed") : error; }
    if (failure) throw failure;
  }
  try {
    await write(outputPath);
    return { path: outputPath, usedFallback: false };
  } catch (failure) {
    const details = errorDetails(failure);
    report.outputWriteErrors ||= [];
    report.outputWriteErrors.push({ path: outputPath, error: details });
    report.error ||= details;
    report.status = "failed";
    const fallback = `${outputPath}.failed-${randomUUIDImpl()}.json`;
    report.outputFallbackPath = fallback;
    try {
      await write(fallback);
      return { path: fallback, usedFallback: true };
    } catch (fallbackFailure) {
      report.outputWriteErrors.push({ path: fallback, error: errorDetails(fallbackFailure) });
      throw new AggregateError([failure, fallbackFailure], "Neither primary nor fallback browser report could be persisted");
    }
  }
}
