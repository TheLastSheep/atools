import type { FeatureAction, SearchResult } from "./types";

export const MAIN_PUSH_LIMITS = Object.freeze({ debounceMs: 150, runners: 2, startupMs: 5000,
  queryMs: 1200, selectMs: 3000, idleMs: 30000, rows: 20, totalRows: 40,
  envelopeBytes: 262144, optionBytes: 16384, depth: 16, nodes: 2048, textLength: 4096 });
export type MainPushCandidate = { pluginId: string; featureCode: string; commandType: "text" | "regex" | "over";
  codeRevision: string; result: SearchResult };
export type MainPushOperation = "prepare" | "query" | "select";
export type MainPushOutcome = "ready" | "handled" | "enter" | "empty" | "failed" | "superseded";
export type MainPushDisplayRow = { handle: string; text: string; description: string; icon: string; highlight: boolean };
export type MainPushEntry = { code: string; type: string; payload: string; from: "main"; queryId: string; handle?: string };
export type MainPushReply = { requestId: string; outcome: MainPushOutcome; rows?: MainPushDisplayRow[]; error?: string };
export type MainPushDispatch = { requestId: string; ticket: string; runnerId: string; operation: MainPushOperation;
  candidate: MainPushCandidate; action: FeatureAction };
export type MainPushPanel = { mainPushQuery: (requestId: string, generation: number, payload: string, type: string) => Promise<MainPushReply>;
  mainPushReady: () => Promise<void>; mainPushResolveIcon: (value: string) => Promise<string>;
  mainPushSelect: (requestId: string, queryId: string, generation: number, handle: string) => Promise<MainPushReply>;
  mainPushPromote: (entry: MainPushEntry) => void; mainPushCancel: () => void; requestEscape: () => Promise<unknown>;
  closePersistentStrict: (options?: { retry?: boolean }) => Promise<void> };
export type MainPushInvoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
export const mainPushCandidateKey = (candidate: MainPushCandidate) => JSON.stringify([candidate.pluginId, candidate.featureCode, candidate.codeRevision]);
export const mainPushGroupKey = (runnerId: string) => `main-push:${runnerId}`;
export const mainPushRowCode = (runnerId: string, handle: string) => `${mainPushGroupKey(runnerId)}:${handle}`;
