import { NOTES_MAX_BYTES, SNAPSHOT_MAX_BYTES } from './safeMarkdown';
export const phases = ['idle', 'checking', 'not-available', 'available', 'downloading', 'downloaded',
    'installing', 'install-unknown', 'restart-pending', 'restarting', 'error'] as const;
export type Phase = typeof phases[number];
export interface Candidate {
    candidateId: string;
    currentVersion: string;
    version: string;
    date: string | null;
    body: string | null;
}
export interface Snapshot {
    version: 1;
    sequence: number;
    phase: Phase;
    candidate: Candidate | null;
    checked: boolean;
    operationId: string | null;
    progress: {
        downloaded: number;
        total: number | null;
    };
    error: {
        code: string;
        message: string;
    } | null;
}
export interface Transport {
    invoke(command: string, args: {
        request: Record<string, unknown>;
    }): Promise<unknown>;
    listen(callback: (payload: unknown) => void): Promise<() => void>;
}
export const validId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
const bytes = (s: string) => new TextEncoder().encode(s).length;
export function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Reflect.ownKeys(descriptors).length === keys.length && keys.every(k => Object.hasOwn(descriptors, k) && Object.hasOwn(descriptors[k], 'value'));
}
const bounded = (v: unknown, max: number): v is string => typeof v === 'string' && bytes(v) <= max;
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
export function parseSnapshot(raw: unknown): Snapshot {
    function reject(): never { throw new Error('更新窗口状态无效。'); }
    if (!exact(raw, ['version', 'sequence', 'phase', 'candidate', 'checked', 'operationId', 'progress', 'error']) || raw.version !== 1 ||
        !integer(raw.sequence) || !phases.includes(raw.phase as Phase) || typeof raw.checked !== 'boolean' ||
        !(raw.operationId === null || validId(raw.operationId)))
        return reject();
    const c = raw.candidate, p = raw.progress, e = raw.error;
    if (c !== null && (!exact(c, ['candidateId', 'currentVersion', 'version', 'date', 'body']) || !validId(c.candidateId) ||
        !bounded(c.currentVersion, 128) || !bounded(c.version, 128) || !(c.date === null || bounded(c.date, 128)) || !(c.body === null || bounded(c.body, NOTES_MAX_BYTES))))
        return reject();
    if (!exact(p, ['downloaded', 'total']) || !integer(p.downloaded) || !(p.total === null || integer(p.total)))
        return reject();
    if (e !== null && (!exact(e, ['code', 'message']) || !bounded(e.code, 128) || !bounded(e.message, 1024)))
        return reject();
    // Only descriptor-validated primitives are copied; no getter or toJSON from input is invoked.
    const snapshot: Snapshot = { version: 1, sequence: raw.sequence, phase: raw.phase as Phase, checked: raw.checked,
        operationId: raw.operationId as string | null, candidate: c === null ? null : { candidateId: c.candidateId as string,
            currentVersion: c.currentVersion as string, version: c.version as string, date: c.date as string | null, body: c.body as string | null },
        progress: { downloaded: p.downloaded, total: p.total as number | null },
        error: e === null ? null : { code: e.code as string, message: e.message as string } };
    if (bytes(JSON.stringify(snapshot)) > SNAPSHOT_MAX_BYTES)
        return reject();
    return snapshot;
}
