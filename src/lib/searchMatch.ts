export type SearchMatchType = "exact" | "prefix" | "contains" | "alias" | "pinyin" | "fuzzy";

export type SearchMatch = {
  type: SearchMatchType;
  score: number;
};

export type SearchMatchCandidate = {
  text: string;
  extraText?: string;
  aliases?: string[];
};

export type PreparedSearchMatchCandidate = {
  text: string;
  extraText: string;
  haystack: string;
  aliases: string[];
  pinyinValues: string[];
  letterMask: number;
  digitMask: number;
};

export type SearchPinyinTokens = {
  full: string;
  spaced: string;
  initials: string;
};

export type SearchPinyinResolver = (value: string) => SearchPinyinTokens | null;

const MATCH_SCORE: Record<SearchMatchType, number> = {
  exact: 100,
  prefix: 92,
  alias: 88,
  pinyin: 82,
  contains: 72,
  fuzzy: 58,
};
export const MAX_SEARCH_MATCH_SCORE = 112;

let searchPinyinResolver: SearchPinyinResolver | null = null;

export function setSearchPinyinResolver(resolver: SearchPinyinResolver) {
  searchPinyinResolver = resolver;
}

export function clearSearchPinyinResolver() {
  searchPinyinResolver = null;
}

export function searchMatchForQuery(query: string, candidate: SearchMatchCandidate): SearchMatch | null {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return null;

  return searchMatchForPreparedQuery(normalizedQuery, prepareSearchMatchCandidate(candidate));
}

export function prepareSearchMatchCandidate(candidate: SearchMatchCandidate): PreparedSearchMatchCandidate {
  const aliases = (candidate.aliases ?? []).map(normalizeSearchText).filter(Boolean);
  const haystack = normalizeSearchText(`${candidate.text} ${candidate.extraText ?? ""}`);
  const masks = asciiCharacterMasks(haystack);
  return {
    text: normalizeSearchText(candidate.text),
    extraText: normalizeSearchText(candidate.extraText ?? ""),
    haystack,
    aliases,
    pinyinValues: [candidate.text, candidate.extraText ?? "", ...(candidate.aliases ?? [])],
    letterMask: masks.letterMask,
    digitMask: masks.digitMask,
  };
}

export function searchMatchForPreparedQuery(
  normalizedQuery: string,
  candidate: PreparedSearchMatchCandidate,
): SearchMatch | null {
  if (!normalizedQuery) return null;

  if (candidate.text === normalizedQuery || candidate.aliases.some((alias) => alias === normalizedQuery)) {
    return match("exact", normalizedQuery.length);
  }

  if (candidate.text.startsWith(normalizedQuery)) {
    return match("prefix", normalizedQuery.length);
  }

  const aliasMatch = matchNormalizedAlias(normalizedQuery, candidate.aliases);
  if (aliasMatch) return aliasMatch;

  if (candidate.haystack.includes(normalizedQuery)) {
    return match("contains", normalizedQuery.length);
  }

  if (candidate.extraText.includes(normalizedQuery)) {
    return match("contains", normalizedQuery.length - 1);
  }

  const pinyinMatch = matchPinyin(normalizedQuery, candidate.pinyinValues);
  if (pinyinMatch) return pinyinMatch;

  if (
    normalizedQuery.length <= 8
    && !normalizedQuery.includes(" ")
    && candidateContainsQueryCharacters(normalizedQuery, candidate)
    && isSubsequence(normalizedQuery, candidate.haystack)
  ) {
    return match("fuzzy", normalizedQuery.length);
  }

  return null;
}

export function insertBoundedSearchResult<T extends { score: number }>(
  results: T[],
  item: T,
  limit: number,
) {
  if (limit <= 0) return;
  if (results.length === limit && item.score <= results[results.length - 1].score) return;

  let low = 0;
  let high = results.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (results[middle].score >= item.score) low = middle + 1;
    else high = middle;
  }
  results.splice(low, 0, item);
  if (results.length > limit) results.pop();
}

export function buildPreparedSearchTrigramSet(
  candidates: PreparedSearchMatchCandidate[],
): Set<string> {
  const trigrams = new Set<string>();
  for (const candidate of candidates) {
    addTrigrams(trigrams, candidate.haystack);
    for (const alias of candidate.aliases) addTrigrams(trigrams, alias);
  }
  return trigrams;
}

export function buildPreparedSearchTrigramIndex(
  candidates: PreparedSearchMatchCandidate[],
): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (let position = 0; position < candidates.length; position += 1) {
    const candidate = candidates[position];
    const candidateTrigrams = new Set<string>();
    addTrigrams(candidateTrigrams, candidate.haystack);
    for (const alias of candidate.aliases) addTrigrams(candidateTrigrams, alias);
    for (const trigram of candidateTrigrams) {
      const positions = index.get(trigram);
      if (positions) positions.push(position);
      else index.set(trigram, [position]);
    }
  }
  return index;
}

export function preparedSearchCandidateIndexes(
  normalizedQuery: string,
  trigramIndex: Map<string, number[]>,
): number[] | null {
  if (!canUseLexicalTrigrams(normalizedQuery)) return null;
  let smallest: number[] | null = null;
  for (const trigram of trigramsFor(normalizedQuery)) {
    const positions = trigramIndex.get(trigram);
    if (!positions) return [];
    if (!smallest || positions.length < smallest.length) smallest = positions;
  }
  return smallest;
}

export function canSkipPreparedSearch(
  normalizedQuery: string,
  availableTrigrams: Set<string>,
): boolean {
  if (!canUseLexicalTrigrams(normalizedQuery)) return false;
  return trigramsFor(normalizedQuery).some((trigram) => !availableTrigrams.has(trigram));
}

export function sortSearchMatches<T extends { match: SearchMatch | null }>(items: T[]): Array<T & { match: SearchMatch }> {
  return items
    .filter((item): item is T & { match: SearchMatch } => item.match !== null)
    .sort((a, b) => b.match.score - a.match.score);
}

export function normalizeSearchText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_\-./]+/g, " ")
    .replace(/\s+/g, " ");
}

function matchNormalizedAlias(query: string, aliases: string[]): SearchMatch | null {
  for (const alias of aliases) {
    if (alias === query || alias.startsWith(query) || alias.includes(query)) {
      return match("alias", query.length);
    }
  }
  return null;
}

function matchPinyin(query: string, values: string[]): SearchMatch | null {
  if (!searchPinyinResolver) return null;
  if (!/^[a-z0-9]+$/.test(query)) return null;
  for (const value of values) {
    const source = value.trim();
    if (!source) continue;
    const tokens = searchPinyinResolver(source);
    if (!tokens) continue;
    const full = normalizePinyinToken(tokens.full);
    const spaced = normalizePinyinToken(tokens.spaced);
    const firstLetters = normalizePinyinToken(tokens.initials);
    if (firstLetters === query || firstLetters.startsWith(query) || full.startsWith(query) || spaced.includes(query)) {
      return match("pinyin", query.length);
    }
  }
  return null;
}

function normalizePinyinToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function addTrigrams(target: Set<string>, value: string) {
  for (const trigram of trigramsFor(value)) target.add(trigram);
}

function canUseLexicalTrigrams(normalizedQuery: string): boolean {
  if (normalizedQuery.length < 3) return false;
  if (normalizedQuery.length <= 8 && !normalizedQuery.includes(" ")) return false;
  if (searchPinyinResolver && /^[a-z0-9]+$/.test(normalizedQuery)) return false;
  return true;
}

function candidateContainsQueryCharacters(
  query: string,
  candidate: PreparedSearchMatchCandidate,
): boolean {
  const masks = asciiCharacterMasks(query);
  return (candidate.letterMask & masks.letterMask) === masks.letterMask
    && (candidate.digitMask & masks.digitMask) === masks.digitMask;
}

function asciiCharacterMasks(value: string) {
  let letterMask = 0;
  let digitMask = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 97 && code <= 122) letterMask |= 1 << (code - 97);
    else if (code >= 48 && code <= 57) digitMask |= 1 << (code - 48);
  }
  return { letterMask, digitMask };
}

function trigramsFor(value: string): string[] {
  const trigrams = [];
  for (let index = 0; index <= value.length - 3; index += 1) {
    trigrams.push(value.slice(index, index + 3));
  }
  return trigrams;
}

function isSubsequence(query: string, haystack: string): boolean {
  if (query.length < 2) return false;
  let index = 0;
  for (const char of haystack) {
    if (char === query[index]) index += 1;
    if (index === query.length) return true;
  }
  return false;
}

function match(type: SearchMatchType, length: number): SearchMatch {
  return {
    type,
    score: MATCH_SCORE[type] + Math.min(12, Math.max(0, length)),
  };
}
