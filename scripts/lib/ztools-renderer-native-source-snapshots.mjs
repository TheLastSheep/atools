import { createZtoolsRendererBrowserSourceLock } from "./ztools-renderer-browser-source-lock.mjs";

function sourceError(error) {
  return {
    name: String(error?.name || "Error").slice(0, 100),
    code: error?.code ? String(error.code).slice(0, 100) : null,
    message: String(error?.message || "Native renderer runner failed").slice(0, 500),
  };
}

export async function setupNativeRendererSourceLock({ root, upstreamPath, packageRoot, distRoot, fixtureFiles }) {
  const sourceLock = createZtoolsRendererBrowserSourceLock({
    root,
    upstream: upstreamPath || "",
    packageRoot,
    distRoot,
    fixtureFiles,
  });
  const snapshot = { packageFiles: null, distFiles: null, upstream: null, errors: [] };
  try { snapshot.packageFiles = await sourceLock.sourceHashes(); }
  catch (error) { snapshot.errors.push({ area: "package-sources", ...sourceError(error) }); }
  try { snapshot.distFiles = await sourceLock.distHashes(); }
  catch (error) { snapshot.errors.push({ area: "renderer-dist", ...sourceError(error) }); }
  if (upstreamPath) {
    try { snapshot.upstream = await sourceLock.hashUpstreamTree(); }
    catch (error) { snapshot.errors.push({ area: "upstream", ...sourceError(error) }); }
  } else {
    snapshot.errors.push({ area: "upstream", name: "MissingInput", code: null,
      message: "Set ATOOLS_ZTOOLS_SOURCE to the pinned clean ZTools checkout" });
  }
  return { sourceLock, snapshot };
}

export async function snapshotNativeRendererSources(sourceLock, upstreamPath) {
  const snapshot = { packageFiles: null, distFiles: null, upstream: null, errors: [] };
  for (const [area, read] of [
    ["package-sources", () => sourceLock.sourceHashes()],
    ["renderer-dist", () => sourceLock.distHashes()],
    ...(upstreamPath ? [["upstream", () => sourceLock.hashUpstreamTree()]] : []),
  ]) {
    try {
      const value = await read();
      if (area === "package-sources") snapshot.packageFiles = value;
      else if (area === "renderer-dist") snapshot.distFiles = value;
      else snapshot.upstream = value;
    } catch (error) {
      snapshot.errors.push({ area, ...sourceError(error) });
    }
  }
  return snapshot;
}
