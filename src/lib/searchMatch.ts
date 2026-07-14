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

  const text = normalizeSearchText(candidate.text);
  const extraText = normalizeSearchText(candidate.extraText ?? "");
  const haystack = normalizeSearchText(`${candidate.text} ${candidate.extraText ?? ""}`);
  const aliasText = normalizeSearchText((candidate.aliases ?? []).join(" "));

  if (text === normalizedQuery || aliasText.split(" ").some((alias) => alias === normalizedQuery)) {
    return match("exact", normalizedQuery.length);
  }

  if (text.startsWith(normalizedQuery)) {
    return match("prefix", normalizedQuery.length);
  }

  const aliasMatch = matchAlias(normalizedQuery, candidate.aliases ?? []);
  if (aliasMatch) return aliasMatch;

  if (haystack.includes(normalizedQuery)) {
    return match("contains", normalizedQuery.length);
  }

  if (extraText.includes(normalizedQuery)) {
    return match("contains", normalizedQuery.length - 1);
  }

  const pinyinMatch = matchPinyin(normalizedQuery, [candidate.text, candidate.extraText ?? "", ...(candidate.aliases ?? [])]);
  if (pinyinMatch) return pinyinMatch;

  if (isSubsequence(normalizedQuery, haystack)) {
    return match("fuzzy", normalizedQuery.length);
  }

  return null;
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

function matchAlias(query: string, aliases: string[]): SearchMatch | null {
  for (const alias of aliases) {
    const normalizedAlias = normalizeSearchText(alias);
    if (!normalizedAlias) continue;
    if (normalizedAlias === query || normalizedAlias.startsWith(query) || normalizedAlias.includes(query)) {
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
