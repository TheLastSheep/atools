export type PluginFileIdentityLease = { id: string; expiresAt: number; active: boolean };
type Binding = { path: string; lease: PluginFileIdentityLease };

/** Per-document, metadata-only identity table for exact native-approved File objects. */
export function createPluginFileIdentityRegistry(now: () => number = Date.now, maxLeases = 4) {
  let files = new WeakMap<object, Binding>();
  const leases = new Map<string, PluginFileIdentityLease>();
  function revoke(leaseId: string) {
    const lease = leases.get(leaseId);
    if (!lease) return false;
    lease.active = false;
    leases.delete(leaseId);
    return true;
  }
  function revokeAll() {
    for (const lease of leases.values()) lease.active = false;
    leases.clear();
    files = new WeakMap<object, Binding>();
  }
  function register(leaseId: string, expiresAt: number, values: Array<{ file: object; path: string }>) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(leaseId)
      || !Number.isSafeInteger(expiresAt) || expiresAt <= now() || expiresAt > now() + 120_000
      || leases.has(leaseId) || !Array.isArray(values) || values.length < 1 || values.length > 16) {
      throw new Error("ERR_ATOOLS_FILE_IDENTITY_LEASE");
    }
    for (const value of values) {
      if (!value || !value.file || (typeof value.file !== "object" && typeof value.file !== "function")
        || typeof value.path !== "string" || value.path.length < 2 || value.path.length > 8192 || value.path.includes("\0")) {
        throw new Error("ERR_ATOOLS_FILE_IDENTITY_BINDING");
      }
    }
    while (leases.size >= maxLeases) revoke(leases.keys().next().value as string);
    const lease: PluginFileIdentityLease = { id: leaseId, expiresAt, active: true };
    leases.set(leaseId, lease);
    for (const value of values) files.set(value.file, { path: value.path, lease });
    return lease;
  }
  function getPathForFile(file: unknown): string {
    if (!file || (typeof file !== "object" && typeof file !== "function")) throw new Error("ERR_ATOOLS_FILE_PATH_UNAVAILABLE");
    const binding = files.get(file as object), lease = binding?.lease;
    if (!binding || !lease || !lease.active || leases.get(lease.id) !== lease || lease.expiresAt <= now()) {
      throw new Error("ERR_ATOOLS_FILE_PATH_UNAVAILABLE");
    }
    return binding.path;
  }
  return { register, getPathForFile, revoke, revokeAll, liveLeaseCount: () => leases.size };
}
