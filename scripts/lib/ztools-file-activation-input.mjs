import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { Buffer } from "node:buffer";

export const MAX_FILE_ACTIVATION_INPUTS = 20;
export const MAX_FILE_ACTIVATION_PATH_BYTES = 8192;

function containsControlCharacters(value) {
  return /\p{Cc}/u.test(value);
}

export async function resolveFileActivationInputs(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("--input-file requires at least one absolute file path");
  }
  if (paths.length > MAX_FILE_ACTIVATION_INPUTS) {
    throw new Error(`--input-file accepts at most ${MAX_FILE_ACTIVATION_INPUTS} paths`);
  }

  const canonicalPaths = [];
  const seen = new Set();
  for (const path of paths) {
    if (typeof path !== "string" || path.length === 0) {
      throw new Error("--input-file requires a non-empty absolute path");
    }
    if (containsControlCharacters(path)) {
      throw new Error("--input-file path must not contain control characters");
    }
    if (!isAbsolute(path)) {
      throw new Error(`--input-file path must be absolute: ${JSON.stringify(path)}`);
    }
    if (Buffer.byteLength(path, "utf8") > MAX_FILE_ACTIVATION_PATH_BYTES) {
      throw new Error(`--input-file path exceeds ${MAX_FILE_ACTIVATION_PATH_BYTES} UTF-8 bytes`);
    }

    let canonicalPath;
    try {
      canonicalPath = await realpath(path);
    } catch {
      throw new Error(`--input-file path cannot be resolved: ${path}`);
    }
    if (Buffer.byteLength(canonicalPath, "utf8") > MAX_FILE_ACTIVATION_PATH_BYTES) {
      throw new Error(`canonical --input-file path exceeds ${MAX_FILE_ACTIVATION_PATH_BYTES} UTF-8 bytes`);
    }
    if (seen.has(canonicalPath)) {
      throw new Error(`duplicate --input-file path resolves to the same file: ${canonicalPath}`);
    }

    let info;
    try {
      info = await stat(canonicalPath);
    } catch {
      throw new Error(`--input-file path cannot be inspected: ${canonicalPath}`);
    }
    if (!info.isFile()) {
      throw new Error(`--input-file path must be a regular file: ${canonicalPath}`);
    }

    seen.add(canonicalPath);
    canonicalPaths.push(canonicalPath);
  }

  return canonicalPaths;
}

function normalizedExtensions(command) {
  if (!Array.isArray(command.extensions)) return [];
  return command.extensions
    .filter((extension) => typeof extension === "string")
    .map((extension) => extension.trim().replace(/^\.+/, "").toLowerCase())
    .filter(Boolean);
}

function commandAcceptsFiles(command, paths) {
  if (!command || typeof command !== "object" || Array.isArray(command)) return false;
  if (command.type !== "files" || command.fileType !== "file") return false;

  const extensions = normalizedExtensions(command);
  if (extensions.length === 0) return false;
  const minLength = command.minLength === undefined ? 1 : command.minLength;
  const maxLength = command.maxLength === undefined ? Number.POSITIVE_INFINITY : command.maxLength;
  if (!Number.isInteger(minLength) || minLength < 0) return false;
  if (!(maxLength === Number.POSITIVE_INFINITY || Number.isInteger(maxLength)) || maxLength < minLength) return false;
  if (paths.length < minLength || paths.length > maxLength) return false;

  return paths.every((path) => {
    const extension = extname(path).slice(1).toLowerCase();
    return extension !== "" && extensions.includes(extension);
  });
}

export function selectFileActivationFeature(manifest, paths) {
  const features = Array.isArray(manifest?.features) ? manifest.features : [];
  for (const feature of features) {
    if (!feature || typeof feature !== "object" || Array.isArray(feature)) continue;
    const commands = Array.isArray(feature.cmds) ? feature.cmds : [];
    if (commands.some((command) => commandAcceptsFiles(command, paths))) return feature;
  }

  const suffixes = [...new Set(paths.map((path) => extname(path).slice(1).toLowerCase()).filter(Boolean))];
  throw new Error(`No single plugin feature accepts all --input-file paths as file commands (suffixes: ${suffixes.join(", ") || "none"}, count: ${paths.length})`);
}
