import assert from "node:assert/strict";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { PersistentPluginData } from "../paste-startup/persistent-data.mjs";

const initialSeedIds = [
  "pasteboard-pro:record:sha256:text-old:v1",
  "pasteboard-pro:record:sha256:files-item:v1",
  "pasteboard-pro:paste-stack",
];

/** Removes only Task14's fixed seed rows so its real Worker can seed a fresh session into the same DB. */
export function clearPasteStartupSeedRowsForSecondSession(databasePath, businessRecordId) {
  const database = new PersistentPluginData(databasePath);
  try {
    const before = database.snapshot(businessRecordId);
    assert.ok(before, "New editor document must exist before preparing a fresh Node session");
    const removed = [];
    for (const id of initialSeedIds) {
      const existing = database.snapshot(id);
      if (existing) {
        const result = database.dispatch("db.remove", [id]);
        assert.equal(result.ok, true, `Could not clear fixed startup seed row ${id}`);
        removed.push(id);
      }
    }
    const preserved = database.snapshot(businessRecordId);
    assert.deepEqual(preserved, before, "Fresh Worker seed preparation must preserve the saved business record byte-for-byte");
    return { removed, preserved };
  } finally {
    database.close();
  }
}

if (!isMainThread) {
  try {
    parentPort?.postMessage({ result: clearPasteStartupSeedRowsForSecondSession(workerData.databasePath, workerData.businessRecordId) });
  } catch (error) {
    parentPort?.postMessage({ error: String(error?.stack ?? error) });
    process.exitCode = 1;
  } finally {
    parentPort?.close();
  }
}
