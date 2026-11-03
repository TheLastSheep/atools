import type { InstalledPlugin, ZToolsImportCandidate } from "./types";
import { groupImportCandidates, importCandidateIdentity, isImportCandidateSelectable, safeImportPaths, selectUnambiguousImportSources } from "./ztoolsImportSelection";

export type ImportScanRoot = { kind: "default" } | { kind: "path"; path: string };

type Choice = { identity: string; path: string; candidate: string; group: string[] };
type Snapshot = { choices: Choice[] };

const MAX_ROOTS = 4;
const MAX_CHOICES_PER_ROOT = 64;
// These limits use JavaScript UTF-16 string units, not UTF-8 encoded bytes.
const MAX_SNAPSHOT_UTF16_UNITS = 32_768;
const MAX_CANDIDATE_KEY_UTF16_UNITS = 8192;
const MAX_ROOT_PATH_CHARS = 4096;

function rootKey(root: ImportScanRoot): string | null {
  if (root.kind === "default") return "default";
  if (!root.path || root.path.length > MAX_ROOT_PATH_CHARS || root.path.includes("\0")) return null;
  return `path:${root.path}`;
}

function candidateKey(candidate: ZToolsImportCandidate): string | null {
  const identity = importCandidateIdentity(candidate);
  const bounded = [candidate.path, candidate.package_path ?? "", identity, candidate.installation_id ?? "", candidate.installation_key ?? "", candidate.name, candidate.version];
  if (bounded.some(value => value.length > MAX_ROOT_PATH_CHARS)) return null;
  const key = JSON.stringify([
    candidate.path, candidate.package_path ?? null, identity, candidate.installation_id ?? null,
    candidate.installation_key ?? null, candidate.name, candidate.version, candidate.source_type,
    candidate.entry_readiness ?? null, candidate.headless ?? false, candidate.platform_supported,
    candidate.main_exists, candidate.preload_exists, candidate.logo_exists, candidate.features_count,
  ]);
  return key.length <= MAX_CANDIDATE_KEY_UTF16_UNITS ? key : null;
}

function serializedStringChars(value: string): number {
  let length = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) {
      length += 2;
    } else if (code < 32) {
      length += 6;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      const next = value.charCodeAt(index + 1);
      if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) { length += 2; index += 1; }
      else length += 6;
    } else {
      length += 1;
    }
  }
  return length;
}

function installedMatch(candidate: ZToolsImportCandidate, installed: InstalledPlugin[]): boolean {
  return installed.some(plugin =>
    !!candidate.installation_id && plugin.id === candidate.installation_id
    || !!candidate.installation_key && plugin.id === candidate.installation_key
    || (!candidate.installation_id && !candidate.installation_key && (plugin.id === candidate.name || plugin.name === candidate.name))
  );
}

/** Remembers explicit ambiguous-source choices in bounded process memory only. */
export class ZToolsImportSelectionSession {
  private readonly snapshots = new Map<string, Snapshot>();

  get size() { return this.snapshots.size; }

  has(root: ImportScanRoot) {
    const key = rootKey(root);
    return !!key && this.snapshots.has(key);
  }

  clearRoot(root: ImportScanRoot) {
    const key = rootKey(root);
    if (key) this.snapshots.delete(key);
  }

  /** Protects an existing target snapshot from eviction while another root is saved. */
  touchForRestore(root: ImportScanRoot): boolean {
    const key = rootKey(root);
    const snapshot = key ? this.snapshots.get(key) : undefined;
    if (!key || !snapshot) return false;
    this.touch(key, snapshot);
    return true;
  }

  restore(root: ImportScanRoot, candidates: ZToolsImportCandidate[], installed: InstalledPlugin[]): Set<string> {
    const key = rootKey(root);
    const selected = selectUnambiguousImportSources(candidates);
    if (!key) return selected;
    const snapshot = this.snapshots.get(key);
    if (!snapshot) return selected;
    this.touch(key, snapshot);

    const groups = groupImportCandidates(candidates);
    const suppress = new Set<string>();
    const restored: Choice[] = [];
    for (const choice of snapshot.choices) {
      const group = groups.get(choice.identity) ?? [];
      const candidate = group.find(item => item.path === choice.path && candidateKey(item) === choice.candidate);
      const currentGroup = group.length === choice.group.length && group.length <= MAX_CHOICES_PER_ROOT
        ? group.map(candidateKey).sort() : [];
      const sameGroup = currentGroup.length === group.length && currentGroup.every((item): item is string => item !== null)
        && sameStrings(currentGroup as string[], choice.group);
      if (!candidate || !sameGroup || group.length < 2 || !isImportCandidateSelectable(candidate) || installedMatch(candidate, installed)) {
        suppress.add(choice.identity);
        for (const item of candidates) if (item.path === choice.path) suppress.add(importCandidateIdentity(item));
        continue;
      }
      restored.push(choice);
      for (const peer of group) selected.delete(peer.path);
      selected.add(candidate.path);
    }
    for (const candidate of candidates) if (suppress.has(importCandidateIdentity(candidate))) selected.delete(candidate.path);
    if (restored.length) this.snapshots.set(key, { choices: restored }); else this.snapshots.delete(key);
    return new Set(safeImportPaths(candidates, selected));
  }

  remember(root: ImportScanRoot, candidates: ZToolsImportCandidate[], selected: Iterable<string>) {
    const key = rootKey(root);
    if (!key) return;
    const chosen = new Set(safeImportPaths(candidates, selected));
    const groups = [...groupImportCandidates(candidates)].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    const choices: Choice[] = [];
    let snapshotChars = JSON.stringify({ choices: [] }).length;
    for (const [identity, group] of groups) {
      if (choices.length >= MAX_CHOICES_PER_ROOT) break;
      if (group.length < 2 || group.length > MAX_CHOICES_PER_ROOT) continue;
      const chosenCandidate = group.find(candidate => chosen.has(candidate.path));
      if (!chosenCandidate) continue;
      const candidate = candidateKey(chosenCandidate);
      if (!candidate) continue;
      const groupKeys: string[] = [];
      let groupChars = 0;
      const baseChoiceChars = '{"identity":'.length + serializedStringChars(identity)
        + ',"path":'.length + serializedStringChars(chosenCandidate.path)
        + ',"candidate":'.length + serializedStringChars(candidate) + ',"group":[]}'.length;
      for (const item of group) {
        const groupKey = candidateKey(item);
        if (!groupKey) { groupKeys.length = 0; break; }
        groupChars += serializedStringChars(groupKey) + (groupKeys.length ? 1 : 0);
        if (snapshotChars + baseChoiceChars + groupChars + (choices.length ? 1 : 0) > MAX_SNAPSHOT_UTF16_UNITS) {
          this.snapshots.delete(key);
          return;
        }
        groupKeys.push(groupKey);
      }
      if (groupKeys.length !== group.length) continue;
      groupKeys.sort();
      const choice: Choice = { identity, path: chosenCandidate.path, candidate, group: groupKeys };
      const serializedChoiceChars = baseChoiceChars - ',"group":[]}'.length + ',"group":['.length
        + groupChars + ']}'.length;
      if (snapshotChars + serializedChoiceChars + (choices.length ? 1 : 0) > MAX_SNAPSHOT_UTF16_UNITS) {
        this.snapshots.delete(key);
        return;
      }
      snapshotChars += serializedChoiceChars + (choices.length ? 1 : 0);
      choices.push(choice);
    }
    const boundedChoices = choices;
    const snapshot: Snapshot = { choices: boundedChoices };
    if (!boundedChoices.length || JSON.stringify(snapshot).length > MAX_SNAPSHOT_UTF16_UNITS) {
      this.snapshots.delete(key);
      return;
    }
    this.touch(key, snapshot);
    while (this.snapshots.size > MAX_ROOTS) this.snapshots.delete(this.snapshots.keys().next().value!);
  }

  clear() { this.snapshots.clear(); }

  private touch(key: string, snapshot: Snapshot) {
    this.snapshots.delete(key);
    this.snapshots.set(key, snapshot);
  }
}

export const ztoolsImportSelectionSession = new ZToolsImportSelectionSession();

function sameStrings(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
