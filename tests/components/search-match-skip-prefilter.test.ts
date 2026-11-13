import { afterEach, describe, expect, it } from "vitest";
import {
  buildPreparedSearchTrigramSet,
  canSkipPreparedSearch,
  clearSearchPinyinResolver,
  normalizeSearchText,
  prepareSearchMatchCandidate,
  searchMatchForPreparedQuery,
  setSearchPinyinResolver,
} from "../../src/lib/searchMatch";

const prepare = (text: string, aliases: string[] = []) => prepareSearchMatchCandidate({ text, aliases });

afterEach(() => clearSearchPinyinResolver());

describe("canSkipPreparedSearch character-mask prefilter", () => {
  it("skips when a query letter or digit is absent from every candidate", () => {
    const trigrams = buildPreparedSearchTrigramSet([prepare("Visual Studio Code"), prepare("Terminal")]);
    expect(canSkipPreparedSearch("zzz", trigrams)).toBe(true);
    expect(canSkipPreparedSearch("code9", trigrams)).toBe(true);
  });

  it("never skips a query that a short (<3 char) name would match", () => {
    const candidates = [prepare("qq"), prepare("Terminal", ["ps"])];
    const trigrams = buildPreparedSearchTrigramSet(candidates);
    for (const query of ["q", "qq", "p", "ps"]) {
      expect(canSkipPreparedSearch(query, trigrams)).toBe(false);
      expect(candidates.some((candidate) => searchMatchForPreparedQuery(query, candidate))).toBe(true);
    }
  });

  it("keeps fuzzy subsequence matches reachable", () => {
    const candidates = [prepare("Visual Studio Code")];
    const trigrams = buildPreparedSearchTrigramSet(candidates);
    const query = normalizeSearchText("vsc");
    expect(canSkipPreparedSearch(query, trigrams)).toBe(false);
    expect(searchMatchForPreparedQuery(query, candidates[0])?.type).toBe("fuzzy");
  });

  it("does not trust masks for sets it did not build", () => {
    const foreign = new Set<string>(["abc"]);
    // "q" yields no trigram, so only an (untrusted) mask could justify skipping it.
    expect(canSkipPreparedSearch("q", foreign)).toBe(false);
  });

  it("disables the mask prefilter while a pinyin resolver is active", () => {
    const trigrams = buildPreparedSearchTrigramSet([prepare("微信")]);
    setSearchPinyinResolver(() => [["wei"], ["xin"]]);
    expect(canSkipPreparedSearch("wx", trigrams)).toBe(false);
  });
});
