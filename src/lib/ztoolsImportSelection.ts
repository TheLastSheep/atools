import type { ZToolsImportCandidate } from "./types";

/** Installation identity belongs to the host. Older DTOs fall back to the unchanged manifest name. */
export function importCandidateIdentity(candidate: ZToolsImportCandidate): string {
  return candidate.installation_key || candidate.installation_id || candidate.name;
}

export function isImportCandidateSelectable(candidate: ZToolsImportCandidate): boolean {
  return candidate.entry_readiness !== "requires_build" && candidate.entry_readiness !== "incomplete"
    && candidate.platform_supported && candidate.errors.length === 0;
}

export function groupImportCandidates(candidates: ZToolsImportCandidate[]): Map<string, ZToolsImportCandidate[]> {
  const groups = new Map<string, ZToolsImportCandidate[]>();
  for (const candidate of candidates) {
    const identity = importCandidateIdentity(candidate);
    const group = groups.get(identity);
    if (group) group.push(candidate); else groups.set(identity, [candidate]);
  }
  return groups;
}

/** Drop conflicting groups rather than silently choosing an arbitrary version at the request boundary. */
export function safeImportPaths(candidates: ZToolsImportCandidate[], requested: Iterable<string>): string[] {
  const paths = new Set(requested);
  const eligible = candidates.filter(candidate => paths.has(candidate.path) && isImportCandidateSelectable(candidate));
  const groups = groupImportCandidates(eligible);
  return [...new Set(eligible.filter(candidate => groups.get(importCandidateIdentity(candidate))?.length === 1).map(candidate => candidate.path))];
}

/** A blocked source still makes a group ambiguous: choosing its release is a user decision. */
export function selectUnambiguousImportSources(candidates: ZToolsImportCandidate[], selected: Iterable<string> = []): Set<string> {
  const next = new Set(safeImportPaths(candidates, selected));
  for (const group of groupImportCandidates(candidates).values()) {
    if (group.length === 1 && isImportCandidateSelectable(group[0])) next.add(group[0].path);
  }
  return next;
}

export function toggleImportSource(candidates: ZToolsImportCandidate[], selected: Iterable<string>, path: string, checked: boolean): Set<string> {
  const next = new Set(safeImportPaths(candidates, selected));
  const candidate = candidates.find(item => item.path === path && isImportCandidateSelectable(item));
  if (!candidate) return next;
  if (checked) {
    const identity = importCandidateIdentity(candidate);
    for (const item of candidates) if (importCandidateIdentity(item) === identity) next.delete(item.path);
    next.add(path);
  } else next.delete(path);
  return next;
}

/** A retry must respect a newer source choice and must never revive two failed sources for one install. */
export function retryImportPaths(candidates: ZToolsImportCandidate[], failed: Iterable<string>, selected: Iterable<string>): string[] {
  const failedPaths = new Set(failed);
  const candidatesByPath = new Map(candidates.map(candidate => [candidate.path, candidate]));
  const chosen = new Map(safeImportPaths(candidates, selected).map(path => {
    const candidate = candidatesByPath.get(path)!;
    return [importCandidateIdentity(candidate), path];
  }));
  const requested = candidates.filter(candidate => {
    if (!failedPaths.has(candidate.path)) return false;
    const currentChoice = chosen.get(importCandidateIdentity(candidate));
    return !currentChoice || currentChoice === candidate.path;
  }).map(candidate => candidate.path);
  return safeImportPaths(candidates, requested);
}
