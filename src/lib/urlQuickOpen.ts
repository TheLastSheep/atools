import type { SearchResult } from "./types";

const LOCAL_HOST_PATTERN = /^(localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#].*)?$/i;
const DOMAIN_PATTERN = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i;

export function normalizeUrlInput(value: string): string | null {
  const raw = value.trim();
  if (!raw || /\s/.test(raw)) return null;

  if (/^https?:\/\//i.test(raw)) {
    return validUrl(raw);
  }

  if (LOCAL_HOST_PATTERN.test(raw)) {
    return validUrl(`http://${raw}`);
  }

  if (DOMAIN_PATTERN.test(raw)) {
    return validUrl(`https://${raw}`);
  }

  return null;
}

export function urlQuickOpenResultsForQuery(value: string): SearchResult[] {
  const url = normalizeUrlInput(value);
  if (!url) return [];
  return [
    {
      code: `url:${encodeURIComponent(url)}`,
      plugin_id: "url-quick-open",
      plugin_name: "链接快开",
      label: `打开链接 ${value.trim()}`,
      icon: null,
      explain: url,
      score: 99,
      match_type: "exact",
    },
  ];
}

export function urlFromQuickOpenCode(code: string): string | null {
  if (!code.startsWith("url:")) return null;
  try {
    return decodeURIComponent(code.slice("url:".length));
  } catch {
    return null;
  }
}

function validUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}
