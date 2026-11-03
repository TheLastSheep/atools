import {
  adapterDisposedError,
  invalidRendererArgument,
  invalidRendererResponse,
} from "./errors";
import { exactEventRecord } from "./safeEventRecord";
import { snapshotPlainJson } from "./startupReadModel";
import { utf8ByteLength } from "./utf8";

const MAX_PIN_ROWS = 4096;
const MAX_PIN_JSON_BYTES = 128 * 1024;
const MAX_PIN_QUEUE = 32;
const PIN_STRING_LIMITS = {
  path: 16 * 1024,
  name: 4 * 1024,
  type: 64,
  featureCode: 1024,
  pluginName: 1024,
} as const;
const MENU_PIN_TYPES = new Set(["direct", "plugin", "builtin"]);

export type RendererRecommendationPin = Record<string, unknown> & {
  path: string;
  name: string;
  type: string;
};
type Pins = RendererRecommendationPin[];

export type RendererRecommendationPinMutation =
  | { kind: "append"; pin: RendererRecommendationPin }
  | { kind: "remove"; index: number }
  | { kind: "moveToFront"; index: number }
  | { kind: "noop" };

export interface RendererRecommendationPinBaseline {
  raw: string | null;
  value: unknown;
}

export interface RendererRecommendationPinWriter {
  save(value: unknown): Promise<void>;
  dispose(): void;
}

export interface RendererRecommendationPinWriterOptions {
  readBaseline(): Promise<RendererRecommendationPinBaseline>;
  saveNative(expected: string | null, value: RendererRecommendationPinMutation): Promise<unknown>;
  accept(raw: string | null, value: unknown): void;
  isDisposed(): boolean;
}

interface SaveJob {
  value: Pins;
  resolve(): void;
  reject(error: unknown): void;
}

export function serializeRecommendationPins(value: unknown): { serialized: string; value: Pins } {
  const cloned = snapshotPlainJson(value, "recommendation-pinned", MAX_PIN_JSON_BYTES);
  let serialized: string;
  try {
    serialized = JSON.stringify(cloned) as string;
  } catch {
    throw invalidRendererArgument("Invalid recommendation-pinned JSON value");
  }
  if (!Array.isArray(cloned) || cloned.length > MAX_PIN_ROWS
    || utf8ByteLength(serialized) > MAX_PIN_JSON_BYTES) {
    throw invalidRendererArgument("Invalid recommendation-pinned size");
  }

  let wireValue: unknown;
  try {
    wireValue = JSON.parse(serialized) as unknown;
  } catch {
    throw invalidRendererArgument("Invalid recommendation-pinned JSON value");
  }
  const rows = wireValue as unknown[];
  for (const item of rows) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw invalidRendererArgument("Invalid recommendation-pinned row");
    }
    const row = item as Record<string, unknown>;
    for (const field of ["path", "name", "type"] as const) {
      if (typeof row[field] !== "string" || !withinUtf8Limit(row[field], PIN_STRING_LIMITS[field])) {
        throw invalidRendererArgument(`Invalid recommendation-pinned ${field}`);
      }
    }
    for (const field of ["featureCode", "pluginName"] as const) {
      if (Object.hasOwn(row, field)
        && (typeof row[field] !== "string" || !withinUtf8Limit(row[field], PIN_STRING_LIMITS[field]))) {
        throw invalidRendererArgument(`Invalid recommendation-pinned ${field}`);
      }
    }
    assertWellFormedJsonStrings(row);
  }
  return { serialized, value: rows as Pins };
}

export function isRecommendationPinMenuAction(id: string): boolean {
  const separator = id.indexOf(":");
  if (separator <= 0) return false;
  const action = id.slice(0, separator);
  if (action !== "pin-recommendation" && action !== "unpin-recommendation"
    && action !== "move-recommendation-to-front") return false;
  try {
    const payload = JSON.parse(id.slice(separator + 1)) as unknown;
    const row = serializeRecommendationPins([payload]).value[0];
    return Boolean(row && MENU_PIN_TYPES.has(row.type) && row.path.length > 0 && !row.path.includes("\0"));
  } catch {
    return false;
  }
}

export function inferRecommendationPinMutation(
  baseline: readonly RendererRecommendationPin[] | null,
  desired: readonly RendererRecommendationPin[],
): RendererRecommendationPinMutation {
  const before = (baseline ?? []).map(recommendationPinIdentity);
  const after = desired.map(recommendationPinIdentity);
  if (sameIdentitySequence(before, after)) return { kind: "noop" };

  if (after.length === before.length + 1
    && before.every((identity, index) => identity === after[index])) {
    return { kind: "append", pin: desired[desired.length - 1] };
  }

  if (before.length === after.length + 1) {
    let firstDifference = 0;
    while (firstDifference < after.length && before[firstDifference] === after[firstDifference]) {
      firstDifference += 1;
    }
    const index = before.indexOf(before[firstDifference]);
    if (after.every((identity, currentIndex) =>
      identity === before[currentIndex + (currentIndex >= index ? 1 : 0)])) {
      return { kind: "remove", index };
    }
  }

  if (before.length === after.length && after.length > 0) {
    const index = before.indexOf(after[0]);
    if (index > 0 && after.every((identity, currentIndex) => {
      const sourceIndex = currentIndex === 0 ? index : currentIndex <= index ? currentIndex - 1 : currentIndex;
      return identity === before[sourceIndex];
    })) return { kind: "moveToFront", index };
  }

  throw invalidRendererArgument("Unsupported recommendation-pinned transition");
}

function recommendationPinIdentity(pin: RendererRecommendationPin): string {
  if (pin.type === "plugin") {
    return JSON.stringify(["plugin", pin.pluginName || pin.path, pin.featureCode || pin.name]);
  }
  return JSON.stringify([pin.type, pin.path, pin.name]);
}

function sameIdentitySequence(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((identity, index) => identity === right[index]);
}

export function createRendererRecommendationPinWriter(
  options: RendererRecommendationPinWriterOptions,
): RendererRecommendationPinWriter {
  const queue: SaveJob[] = [];
  let pending = 0;
  let running = false;
  let disposed = false;

  function isInactive(): boolean {
    return disposed || options.isDisposed();
  }

  function settle(job: SaveJob, failed = false, error?: unknown): void {
    pending -= 1;
    if (failed) job.reject(error);
    else job.resolve();
  }

  async function execute(job: SaveJob): Promise<void> {
    if (isInactive()) throw adapterDisposedError();
    const baseline = await options.readBaseline();
    if (isInactive()) throw adapterDisposedError();
    if (!baseline || (baseline.raw !== null && typeof baseline.raw !== "string")) {
      throw invalidRendererResponse("Invalid stored recommendation pin baseline.");
    }
    if (baseline.raw === null && baseline.value !== null) {
      throw invalidRendererResponse("Invalid stored recommendation pin baseline.");
    }
    let currentPins: Pins = [];
    if (baseline.raw !== null) {
      if (utf8ByteLength(baseline.raw) > MAX_PIN_JSON_BYTES) {
        throw invalidRendererResponse("Invalid stored recommendation pins.");
      }
      try {
        currentPins = serializeRecommendationPins(baseline.value).value;
      } catch {
        throw invalidRendererResponse("Invalid stored recommendation pins.");
      }
    }
    const mutation = inferRecommendationPinMutation(currentPins, job.value);
    const receipt = validateReceipt(await options.saveNative(baseline.raw, mutation));
    if (isInactive()) throw adapterDisposedError();
    options.accept(receipt.raw, receipt.value);
  }

  async function drain(): Promise<void> {
    if (running || isInactive()) return;
    running = true;
    try {
      while (queue.length > 0) {
        const job = queue.shift();
        if (!job) continue;
        try {
          await execute(job);
          settle(job);
        } catch (error) {
          settle(job, true, error);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    save(value) {
      if (isInactive()) throw adapterDisposedError();
      const snapshot = serializeRecommendationPins(value).value;
      if (pending >= MAX_PIN_QUEUE) throw invalidRendererArgument("recommendation-pinned queue limit");
      pending += 1;
      const promise = new Promise<void>((resolve, reject) => {
        queue.push({ value: snapshot, resolve, reject });
      });
      void drain();
      return promise;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      while (queue.length > 0) {
        const job = queue.shift();
        if (job) settle(job, true, adapterDisposedError());
      }
    },
  };
}

function validateReceipt(value: unknown): { raw: string | null; value: unknown } {
  let record: Record<string, unknown>;
  try {
    record = exactEventRecord(value, ["version", "changed", "raw"]);
  } catch {
    throw invalidRendererResponse("Invalid recommendation pin save receipt.");
  }
  if (record.version !== 1 || typeof record.changed !== "boolean") {
    throw invalidRendererResponse("Invalid recommendation pin save receipt.");
  }
  if (record.raw === null) return { raw: null, value: null };
  if (typeof record.raw !== "string" || utf8ByteLength(record.raw) > MAX_PIN_JSON_BYTES) {
    throw invalidRendererResponse("Invalid recommendation pin save receipt.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.raw) as unknown;
    return { raw: record.raw, value: serializeRecommendationPins(parsed).value };
  } catch {
    throw invalidRendererResponse("Invalid recommendation pin save receipt.");
  }
}

function withinUtf8Limit(value: string, limit: number): boolean {
  return isWellFormedString(value) && utf8ByteLength(value) <= limit;
}

function assertWellFormedJsonStrings(value: unknown): void {
  if (typeof value === "string") {
    if (!isWellFormedString(value)) throw invalidRendererArgument("Invalid recommendation-pinned Unicode");
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertWellFormedJsonStrings(item);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (!isWellFormedString(key)) throw invalidRendererArgument("Invalid recommendation-pinned Unicode");
    assertWellFormedJsonStrings(item);
  }
}

function isWellFormedString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
