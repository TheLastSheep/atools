import type { AuditFilters } from "./auditView";

export type SavedAuditFilterView = {
  id: string;
  label: string;
  filters: AuditFilters;
  updatedAt: string;
};

export type AuditFilterViewDraft = {
  id?: string;
  label?: string;
  filters?: AuditFilters;
  updatedAt?: string;
};

export const AUDIT_FILTER_VIEWS_STORAGE_KEY = "atools:audit-filter-views";

const MAX_AUDIT_FILTER_VIEWS = 12;

export function normalizeAuditFilterViewFilters(filters: AuditFilters = {}): AuditFilters {
  return compactFilters({
    query: normalizeOptionalText(filters.query),
    status: normalizeOptionalText(filters.status),
    toolName: normalizeOptionalText(filters.toolName),
    clientId: normalizeOptionalText(filters.clientId),
  });
}

export function auditFilterViewLabel(filters: AuditFilters = {}): string {
  const normalized = normalizeAuditFilterViewFilters(filters);
  const parts = [
    normalized.query ? `搜索: ${normalized.query}` : "",
    normalized.status ? `状态: ${normalized.status}` : "",
    normalized.toolName ? `工具: ${normalized.toolName}` : "",
    normalized.clientId ? `客户端: ${normalized.clientId}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "全部审计";
}

export function normalizeAuditFilterViews(value: unknown): SavedAuditFilterView[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const views: SavedAuditFilterView[] = [];
  for (const item of value) {
    const view = normalizeAuditFilterView(item);
    if (!view || seen.has(view.id)) continue;
    seen.add(view.id);
    views.push(view);
  }
  return views;
}

export function loadAuditFilterViews(): SavedAuditFilterView[] {
  try {
    const value = localStorage.getItem(AUDIT_FILTER_VIEWS_STORAGE_KEY);
    return normalizeAuditFilterViews(value ? JSON.parse(value) : []);
  } catch {
    return [];
  }
}

export function saveAuditFilterViews(views: SavedAuditFilterView[]) {
  try {
    localStorage.setItem(AUDIT_FILTER_VIEWS_STORAGE_KEY, JSON.stringify(normalizeAuditFilterViews(views)));
  } catch {
    // Saved audit views are optional UI state; restricted storage should not break audit review.
  }
}

export function upsertAuditFilterView(
  views: SavedAuditFilterView[],
  draft: AuditFilterViewDraft,
): SavedAuditFilterView[] {
  const normalizedViews = normalizeAuditFilterViews(views);
  const filters = normalizeAuditFilterViewFilters(draft.filters ?? {});
  const label = normalizeOptionalText(draft.label) ?? auditFilterViewLabel(filters);
  const existing = normalizedViews.find((view) => {
    if (draft.id && view.id === draft.id.trim()) return true;
    return view.label.toLowerCase() === label.toLowerCase();
  });
  const view: SavedAuditFilterView = {
    id: existing?.id ?? normalizeOptionalText(draft.id) ?? auditFilterViewId(label),
    label,
    filters,
    updatedAt: normalizeOptionalText(draft.updatedAt) ?? new Date().toISOString(),
  };
  const remaining = normalizedViews.filter((item) => item.id !== view.id && item.label.toLowerCase() !== label.toLowerCase());
  return [view, ...remaining].slice(0, MAX_AUDIT_FILTER_VIEWS);
}

export function removeAuditFilterView(views: SavedAuditFilterView[], id: string): SavedAuditFilterView[] {
  const targetId = id.trim();
  if (!targetId) return normalizeAuditFilterViews(views);
  return normalizeAuditFilterViews(views).filter((view) => view.id !== targetId);
}

function normalizeAuditFilterView(value: unknown): SavedAuditFilterView | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const label = normalizeOptionalText(item.label);
  if (!label) return null;
  const filters = normalizeAuditFilterViewFilters(item.filters as AuditFilters | undefined);
  return {
    id: normalizeOptionalText(item.id) ?? auditFilterViewId(label),
    label,
    filters,
    updatedAt: normalizeOptionalText(item.updatedAt) ?? new Date().toISOString(),
  };
}

function compactFilters(filters: AuditFilters): AuditFilters {
  const result: AuditFilters = {};
  if (filters.query) result.query = filters.query;
  if (filters.status) result.status = filters.status;
  if (filters.toolName) result.toolName = filters.toolName;
  if (filters.clientId) result.clientId = filters.clientId;
  return result;
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized !== "all" ? normalized : undefined;
}

function auditFilterViewId(label: string): string {
  let hash = 0;
  for (const char of label) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return `audit-view-${Math.abs(hash).toString(36)}`;
}
