export type PluginContextMenuItem = {
  id?: string;
  label?: string;
  type?: "normal" | "separator" | "checkbox" | "submenu";
  enabled?: boolean;
  checked?: boolean;
  submenu?: PluginContextMenuItem[];
};

/** Strict, bounded snapshot of the limited Electron MenuItem shape we render. */
export function normalizePluginContextMenu(value: unknown): PluginContextMenuItem[] {
  const fail = (detail: string): never => { throw new TypeError("ERR_ATOOLS_CONTEXT_MENU: " + detail); };
  const plain = (item: unknown): item is Record<string, unknown> => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const proto = Object.getPrototypeOf(item);
    return proto === Object.prototype || proto === null;
  };
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return fail("items must contain 1 to 32 entries");
  const ids = new Set<string>();
  const encoder = new TextEncoder();
  let total = 0;
  function listValues(input: unknown[]): unknown[] {
    if (Object.getPrototypeOf(input) !== Array.prototype || Object.getOwnPropertySymbols(input).length) fail("menu lists must be plain arrays");
    const names = Object.getOwnPropertyNames(input);
    if (names.length !== input.length + 1 || names.some(name => name !== "length" && !/^(0|[1-9]\d*)$/.test(name))) fail("menu list has extra properties");
    const values: unknown[] = [];
    for (let index = 0; index < input.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor) return fail("menu list entries must be own data values");
      if (!("value" in descriptor)) return fail("menu list entries must be own data values");
      values.push(descriptor.value);
    }
    return values;
  }
  function copyList(input: unknown[], depth: number): PluginContextMenuItem[] {
    if (depth > 3) fail("submenu depth exceeds 3");
    if (input.length > 64 - total) fail("total menu item budget exceeded");
    const out: PluginContextMenuItem[] = [];
    for (const raw of listValues(input)) {
      if (++total > 64 || !plain(raw)) fail("invalid menu item or total item budget exceeded");
      if (Object.getOwnPropertySymbols(raw).length) fail("symbol properties are not allowed");
      const descriptors = Object.getOwnPropertyDescriptors(raw);
      const keys = Object.keys(descriptors);
      if (keys.some(key => !["id", "label", "type", "enabled", "checked", "submenu"].includes(key)
        || !("value" in descriptors[key]))) fail("unsupported menu item property");
      const field = (key: string) => Object.prototype.hasOwnProperty.call(descriptors, key) ? descriptors[key].value : undefined;
      const id = field("id"), label = field("label"), itemType = field("type"), enabled = field("enabled");
      const checked = field("checked"), submenu = field("submenu");
      const item: PluginContextMenuItem = {};
      const type = itemType;
      if (type !== undefined && type !== "normal" && type !== "separator" && type !== "checkbox" && type !== "submenu") fail("unsupported item type");
      if (enabled !== undefined && typeof enabled !== "boolean") fail("enabled must be boolean");
      if (enabled !== undefined) item.enabled = enabled;
      if (type === "separator") {
        if (id !== undefined || label !== undefined || checked !== undefined || submenu !== undefined) fail("separator cannot carry item data");
        item.type = "separator";
        out.push(item);
        continue;
      }
      if (typeof label !== "string" || !label.trim() || label.length > 120
        || encoder.encode(label).byteLength > 256) fail("label must be non-empty and at most 256 UTF-8 bytes");
      item.label = label;
      if (type !== undefined) item.type = type;
      if (submenu !== undefined) {
        if ((type !== undefined && type !== "submenu") || id !== undefined || checked !== undefined
          || !Array.isArray(submenu) || submenu.length < 1) fail("submenu item shape is invalid");
        item.submenu = copyList(submenu, depth + 1);
      } else {
        if (type === "submenu") fail("submenu type requires a submenu array");
        if (typeof id !== "string" || !id.trim() || id.length > 128
          || encoder.encode(id).byteLength > 256 || /[\u0000-\u001f\u007f]/.test(id)) fail("leaf id is invalid");
        if (ids.has(id)) fail("duplicate leaf id");
        ids.add(id);
        item.id = id;
        if (type === "checkbox") {
          if (typeof checked !== "boolean") fail("checkbox requires checked boolean");
          item.checked = checked;
        } else if (checked !== undefined) fail("checked is only valid for checkbox items");
      }
      out.push(item);
    }
    return out;
  }
  const result = copyList(value, 0);
  if (encoder.encode(JSON.stringify(result)).byteLength > 12_288) fail("menu exceeds 12288 UTF-8 bytes");
  return result;
}
