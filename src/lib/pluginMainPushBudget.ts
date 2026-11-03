/** Self-contained, injected before third-party page code. Does not invoke accessors or toJSON. */
export function createPluginMainPushBudget() {
  function assert(value: unknown, maxBytes = 262144) {
    let bytes = 0, nodes = 0;
    const ancestors = new Set<object>();
    function visit(item: unknown, depth: number) {
      if (++nodes > 2048 || depth > 16) throw Error("ERR_MAIN_PUSH_COMPLEXITY");
      if (typeof item === "string") {
        if (item.length > maxBytes) throw Error("ERR_MAIN_PUSH_BYTES");
        // JSON escaped byte count without constructing an unbounded serialization.
        bytes += new TextEncoder().encode(item).byteLength + 2;
        for (let index = 0; index < item.length; index++) {
          const unit = item.charCodeAt(index);
          if (unit < 32) bytes += [8, 9, 10, 12, 13].includes(unit) ? 1 : 5;
          else if (unit === 34 || unit === 92) bytes++;
          else if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = item.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) index++; else bytes += 3;
          } else if (unit >= 0xdc00 && unit <= 0xdfff) bytes += 3;
        }
      } else if (item === null || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) bytes += String(item).length;
      else if (item && typeof item === "object") {
        if (ancestors.has(item)) throw Error("ERR_MAIN_PUSH_JSON");
        ancestors.add(item);
        const array = Array.isArray(item), ownPrototype = Object.getPrototypeOf(item);
        if (array ? ownPrototype !== Array.prototype : ownPrototype !== null && ownPrototype !== Object.prototype) throw Error("ERR_MAIN_PUSH_JSON");
        let prototype: object | null = item;
        for (let level = 0; prototype; level++, prototype = Object.getPrototypeOf(prototype)) {
          if (level > 16 || Object.getOwnPropertyDescriptor(prototype, "toJSON")) throw Error("ERR_MAIN_PUSH_JSON");
        }
        const keys = Reflect.ownKeys(item);
        if (keys.some(key => typeof key !== "string")) throw Error("ERR_MAIN_PUSH_JSON");
        if (keys.length > 2048 || nodes + keys.length > 2048) throw Error("ERR_MAIN_PUSH_COMPLEXITY");
        bytes += 2 + Math.max(0, (array ? item.length : keys.length) - 1);
        if (array) {
          if (item.length > 2048) throw Error("ERR_MAIN_PUSH_COMPLEXITY");
          if (keys.length !== item.length + 1 || !keys.includes("length")) throw Error("ERR_MAIN_PUSH_JSON");
          for (let index = 0; index < item.length; index++) {
            const own = Object.getOwnPropertyDescriptor(item, String(index));
            if (!own?.enumerable || !("value" in own)) throw Error("ERR_MAIN_PUSH_JSON");
            visit(own.value, depth + 1);
          }
        } else for (const key of keys) {
          visit(key, depth + 1); bytes++;
          const own = Object.getOwnPropertyDescriptor(item, key);
          if (!own?.enumerable || !("value" in own)) throw Error("ERR_MAIN_PUSH_JSON");
          visit(own.value, depth + 1);
        }
        ancestors.delete(item);
      } else throw Error("ERR_MAIN_PUSH_JSON");
      if (bytes > maxBytes) throw Error("ERR_MAIN_PUSH_BYTES");
    }
    visit(value, 0);
    return bytes;
  }
  return { assert };
}
