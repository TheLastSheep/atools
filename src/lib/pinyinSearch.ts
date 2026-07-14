import { setSearchPinyinResolver, type SearchPinyinTokens } from "./searchMatch";

let loadPromise: Promise<boolean> | null = null;

export function loadSearchPinyinEngine(): Promise<boolean> {
  if (!loadPromise) {
    loadPromise = import("pinyin-pro")
      .then(({ pinyin }) => {
        setSearchPinyinResolver((value) => pinyinTokens(value, pinyin));
        return true;
      })
      .catch((error) => {
        console.warn("Failed to load pinyin search engine:", error);
        loadPromise = null;
        return false;
      });
  }
  return loadPromise;
}

type PinyinFunction = typeof import("pinyin-pro").pinyin;

function pinyinTokens(value: string, pinyin: PinyinFunction): SearchPinyinTokens | null {
  const source = value.trim();
  if (!source) return null;
  const syllables = pinyin(source, {
    toneType: "none",
    type: "array",
    nonZh: "consecutive",
    v: true,
  }) as string[];
  const initials = pinyin(source, {
    toneType: "none",
    pattern: "first",
    type: "array",
    nonZh: "consecutive",
    v: true,
  }) as string[];
  return {
    full: syllables.join(""),
    spaced: syllables.join(" "),
    initials: initials.join(""),
  };
}
