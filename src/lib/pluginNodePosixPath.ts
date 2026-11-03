/*!
 * POSIX basename/parse behavior adapted from Node.js v22.23.3, lib/path.js:
 * https://github.com/nodejs/node/blob/v22.23.3/lib/path.js
 * Copyright Joyent, Inc. and other Node contributors.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit
 * persons to whom the Software is furnished to do so, subject to the
 * following conditions:
 *
 * The above copyright notice and this permission notice shall be included
 * in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 * OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
 * NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
 * USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

export interface PluginNodePosixPathObject {
  root?: string;
  dir?: string;
  base?: string;
  name?: string;
  ext?: string;
}

export interface PluginNodePosixPath {
  resolve(...paths: string[]): string;
  normalize(path: string): string;
  isAbsolute(path: string): boolean;
  join(...paths: string[]): string;
  relative(from: string, to: string): string;
  dirname(path: string): string;
  basename(path: string, suffix?: string): string;
  extname(path: string): string;
  parse(path: string): { root: string; dir: string; base: string; ext: string; name: string };
  format(pathObject: PluginNodePosixPathObject): string;
  toNamespacedPath(path: unknown): unknown;
  sep: "/";
  delimiter: ":";
  posix: PluginNodePosixPath;
}

/**
 * Creates a self-contained POSIX path implementation for plugin iframes.
 * Keep helpers inside this function because hosts serialize it with toString().
 */
export function createPluginNodePosixPath(cwd: string): PluginNodePosixPath {
  const MAX_ARGUMENTS = 256;
  const MAX_STRING_BYTES = 1024 * 1024;
  let cwdForResolve = cwd;

  function budgetError(): never {
    const error = new Error("Path values exceed the ATools Node module value budget") as Error & { code: string };
    error.name = "PluginNodePathBudgetError";
    error.code = "ERR_ATOOLS_MODULE_VALUE_BUDGET";
    throw error;
  }

  function invalidArgType(name: string, expected: string, value: unknown): never {
    const actual = value === null ? "null" : Array.isArray(value) ? "an array" : typeof value;
    const error = new TypeError(`The "${name}" argument must be of type ${expected}. Received ${actual}`) as TypeError & { code: string };
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }

  function utf8Length(value: string): number {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code <= 0x7f) bytes += 1;
      else if (code <= 0x7ff) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff
        && index + 1 < value.length
        && value.charCodeAt(index + 1) >= 0xdc00
        && value.charCodeAt(index + 1) <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
      if (bytes > MAX_STRING_BYTES) return bytes;
    }
    return bytes;
  }

  function checkArgumentCount(args: ArrayLike<unknown>): void {
    if (args.length > MAX_ARGUMENTS) budgetError();
  }

  function checkStringBudget(values: ArrayLike<unknown>): void {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (typeof value !== "string") continue;
      total += utf8Length(value);
      if (total > MAX_STRING_BYTES) budgetError();
    }
  }

  function checkCall(args: ArrayLike<unknown>): void {
    checkArgumentCount(args);
    checkStringBudget(args);
  }

  function requireString(value: unknown, name: string): string {
    if (typeof value !== "string") invalidArgType(name, "string", value);
    return value;
  }

  function isAbsoluteValue(path: string): boolean {
    return path.length > 0 && path.charCodeAt(0) === 47;
  }

  function normalizeString(path: string, allowAboveRoot: boolean): string {
    const segmentStack: number[] = [];
    const rangeBase = path.length + 1;
    let segmentStart = 0;

    for (let end = 0; end <= path.length; end += 1) {
      if (end < path.length && path.charCodeAt(end) !== 47) continue;
      const length = end - segmentStart;
      if (length === 2 && path.charCodeAt(segmentStart) === 46 && path.charCodeAt(segmentStart + 1) === 46) {
        if (segmentStack.length > 0 && segmentStack[segmentStack.length - 1] !== -1) segmentStack.pop();
        else if (allowAboveRoot) segmentStack.push(-1);
      } else if (length > 0 && !(length === 1 && path.charCodeAt(segmentStart) === 46)) {
        segmentStack.push(segmentStart * rangeBase + end);
      }
      segmentStart = end + 1;
    }

    let result = "";
    for (const range of segmentStack) {
      if (result.length > 0) result += "/";
      if (range === -1) result += "..";
      else {
        const start = Math.floor(range / rangeBase);
        result += path.slice(start, range % rangeBase);
      }
    }
    return result;
  }

  function normalizeValue(path: string): string {
    if (path.length === 0) return ".";
    const absolute = isAbsoluteValue(path);
    const trailingSeparator = path.charCodeAt(path.length - 1) === 47;
    let normalized = normalizeString(path, !absolute);
    if (normalized.length === 0 && !absolute) normalized = ".";
    if (normalized.length > 0 && trailingSeparator) normalized += "/";
    return absolute ? `/${normalized}` : normalized;
  }

  function resolveValues(paths: ArrayLike<string>): string {
    let resolved = "";
    let absolute = false;
    for (let index = paths.length - 1; index >= 0 && !absolute; index -= 1) {
      const value = paths[index];
      if (value.length === 0) continue;
      resolved = `${value}/${resolved}`;
      absolute = isAbsoluteValue(value);
    }
    if (!absolute) resolved = `${cwdForResolve}/${resolved}`;
    const normalized = normalizeString(resolved, false);
    return normalized.length === 0 ? "/" : `/${normalized}`;
  }

  function basenameValue(path: string, suffix?: string): string {
    let start = 0;
    let end = -1;
    let matchedSlash = true;

    if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
      if (suffix === path) return "";
      let suffixIndex = suffix.length - 1;
      let firstNonSlashEnd = -1;
      for (let index = path.length - 1; index >= 0; index -= 1) {
        const code = path.charCodeAt(index);
        if (code === 47) {
          if (!matchedSlash) {
            start = index + 1;
            break;
          }
        } else {
          if (firstNonSlashEnd === -1) {
            matchedSlash = false;
            firstNonSlashEnd = index + 1;
          }
          if (suffixIndex >= 0) {
            if (code === suffix.charCodeAt(suffixIndex)) {
              suffixIndex -= 1;
              if (suffixIndex === -1) end = index;
            } else {
              suffixIndex = -1;
              end = firstNonSlashEnd;
            }
          }
        }
      }

      if (start === end) end = firstNonSlashEnd;
      else if (end === -1) end = path.length;
      return path.slice(start, end);
    }

    for (let index = path.length - 1; index >= 0; index -= 1) {
      if (path.charCodeAt(index) === 47) {
        if (!matchedSlash) {
          start = index + 1;
          break;
        }
      } else if (end === -1) {
        matchedSlash = false;
        end = index + 1;
      }
    }
    return end === -1 ? "" : path.slice(start, end);
  }

  function extnameValue(base: string): string {
    if (base.length === 0 || base === "." || base === "..") return "";
    const dot = base.lastIndexOf(".");
    return dot <= 0 ? "" : base.slice(dot);
  }

  function parseValue(path: string): { root: string; dir: string; base: string; ext: string; name: string } {
    const root = isAbsoluteValue(path) ? "/" : "";
    const scanStart = root === "/" ? 1 : 0;
    let startDot = -1;
    let startPart = 0;
    let end = -1;
    let matchedSlash = true;
    let preDotState = 0;

    for (let index = path.length - 1; index >= scanStart; index -= 1) {
      const code = path.charCodeAt(index);
      if (code === 47) {
        if (!matchedSlash) {
          startPart = index + 1;
          break;
        }
        continue;
      }
      if (end === -1) {
        matchedSlash = false;
        end = index + 1;
      }
      if (code === 46) {
        if (startDot === -1) startDot = index;
        else if (preDotState !== 1) preDotState = 1;
      } else if (startDot !== -1) {
        preDotState = -1;
      }
    }

    const parsed = { root, dir: "", base: "", ext: "", name: "" };
    if (end !== -1) {
      const partStart = startPart === 0 && root !== "" ? 1 : startPart;
      if (startDot === -1 || preDotState === 0 || (
        preDotState === 1 && startDot === end - 1 && startDot === startPart + 1
      )) {
        parsed.base = parsed.name = path.slice(partStart, end);
      } else {
        parsed.name = path.slice(partStart, startDot);
        parsed.base = path.slice(partStart, end);
        parsed.ext = path.slice(startDot, end);
      }
    }

    if (startPart > 0) parsed.dir = path.slice(0, startPart - 1);
    else if (root !== "") parsed.dir = "/";
    return parsed;
  }

  if (typeof cwd !== "string") invalidArgType("cwd", "string", cwd);
  checkArgumentCount(arguments);
  checkStringBudget([cwd]);
  if (!isAbsoluteValue(cwd)) {
    const error = new TypeError('The "cwd" argument must be an absolute POSIX path') as TypeError & { code: string };
    error.code = "ERR_INVALID_ARG_VALUE";
    throw error;
  }
  const normalizedCwd = normalizeValue(cwd);
  cwdForResolve = normalizedCwd;

  const api: PluginNodePosixPath = {
    resolve(...paths: string[]): string {
      checkCall(arguments);
      // Resolve against the configured cwd, with Node's right-to-left root override.
      let resolved = "";
      let absolute = false;
      for (let index = paths.length - 1; index >= 0 && !absolute; index -= 1) {
        const value = requireString(paths[index], `paths[${index}]`);
        if (value.length === 0) continue;
        resolved = `${value}/${resolved}`;
        absolute = isAbsoluteValue(value);
      }
      if (!absolute) resolved = `${normalizedCwd}/${resolved}`;
      return `/${normalizeString(resolved, false)}`;
    },
    normalize(path: string): string {
      checkCall(arguments);
      return normalizeValue(requireString(path, "path"));
    },
    isAbsolute(path: string): boolean {
      checkCall(arguments);
      return isAbsoluteValue(requireString(path, "path"));
    },
    join(...paths: string[]): string {
      checkCall(arguments);
      let joined = "";
      for (let index = 0; index < paths.length; index += 1) {
        const value = requireString(paths[index], `paths[${index}]`);
        if (value.length === 0) continue;
        joined = joined.length === 0 ? value : `${joined}/${value}`;
      }
      return joined.length === 0 ? "." : normalizeValue(joined);
    },
    relative(from: string, to: string): string {
      checkCall(arguments);
      const fromValue = requireString(from, "from");
      const toValue = requireString(to, "to");
      const fromResolved = resolveValues([fromValue]);
      const toResolved = resolveValues([toValue]);
      if (fromResolved === toResolved) return "";
      let fromIndex = 1;
      let toIndex = 1;
      while (fromIndex < fromResolved.length && toIndex < toResolved.length) {
        let fromEnd = fromIndex;
        let toEnd = toIndex;
        while (fromEnd < fromResolved.length && fromResolved.charCodeAt(fromEnd) !== 47) fromEnd += 1;
        while (toEnd < toResolved.length && toResolved.charCodeAt(toEnd) !== 47) toEnd += 1;
        const segmentLength = fromEnd - fromIndex;
        if (segmentLength !== toEnd - toIndex) break;
        let segmentsMatch = true;
        for (let offset = 0; offset < segmentLength; offset += 1) {
          if (fromResolved.charCodeAt(fromIndex + offset) !== toResolved.charCodeAt(toIndex + offset)) {
            segmentsMatch = false;
            break;
          }
        }
        if (!segmentsMatch) break;
        fromIndex = fromEnd < fromResolved.length ? fromEnd + 1 : fromResolved.length + 1;
        toIndex = toEnd < toResolved.length ? toEnd + 1 : toResolved.length + 1;
      }
      let upCount = 0;
      if (fromIndex <= fromResolved.length && fromIndex < fromResolved.length) {
        upCount = 1;
        for (let index = fromIndex; index < fromResolved.length; index += 1) {
          if (fromResolved.charCodeAt(index) === 47) upCount += 1;
        }
      }
      const remainder = toIndex <= toResolved.length && toIndex < toResolved.length ? toResolved.slice(toIndex) : "";
      return `${"../".repeat(upCount)}${remainder}`.replace(/\/$/, "");
    },
    dirname(path: string): string {
      checkCall(arguments);
      const value = requireString(path, "path");
      if (value.length === 0) return ".";
      const hasRoot = value.charCodeAt(0) === 47;
      let end = -1;
      let matchedSlash = true;
      for (let index = value.length - 1; index >= 1; index -= 1) {
        if (value.charCodeAt(index) === 47) {
          if (!matchedSlash) { end = index; break; }
        } else matchedSlash = false;
      }
      if (end === -1) return hasRoot ? "/" : ".";
      if (hasRoot && end === 1) return "//";
      return value.slice(0, end);
    },
    basename(path: string, suffix?: string): string {
      checkCall(arguments);
      const value = requireString(path, "path");
      if (suffix !== undefined) requireString(suffix, "suffix");
      return basenameValue(value, suffix);
    },
    extname(path: string): string {
      checkCall(arguments);
      const value = requireString(path, "path");
      return extnameValue(basenameValue(value));
    },
    parse(path: string): { root: string; dir: string; base: string; ext: string; name: string } {
      checkCall(arguments);
      return parseValue(requireString(path, "path"));
    },
    format(pathObject: PluginNodePosixPathObject): string {
      checkArgumentCount(arguments);
      if (pathObject === null || typeof pathObject !== "object" || Array.isArray(pathObject)) {
        invalidArgType("pathObject", "object", pathObject);
      }
      const rootField = pathObject.root;
      const dirField = pathObject.dir;
      const baseField = pathObject.base;
      const nameField = pathObject.name;
      const extField = pathObject.ext;
      const fields: unknown[] = [rootField, dirField, baseField, nameField, extField];
      const budgetValues: unknown[] = [];
      for (let index = 0; index < arguments.length; index += 1) budgetValues.push(arguments[index]);
      budgetValues.push(...fields);
      checkStringBudget(budgetValues);
      for (const [index, value] of fields.entries()) {
        if (value !== undefined && typeof value !== "string") {
          const names = ["root", "dir", "base", "name", "ext"];
          invalidArgType(`pathObject.${names[index]}`, "string", value);
        }
      }
      const root = rootField || "";
      const dir = dirField || root;
      const ext = extField ? (extField.startsWith(".") ? extField : `.${extField}`) : "";
      const base = baseField || `${nameField || ""}${ext}`;
      if (!dir) return base;
      if (dir === root) return `${dir}${base}`;
      return `${dir}/${base}`;
    },
    toNamespacedPath(path: unknown): unknown {
      checkCall(arguments);
      return path;
    },
    sep: "/",
    delimiter: ":",
    posix: null as unknown as PluginNodePosixPath,
  };
  api.posix = api;
  return api;
}
