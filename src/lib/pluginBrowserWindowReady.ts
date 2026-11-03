import type { PluginFrameIdentity } from "./pluginFrameDocumentIdentity";

export type PluginBrowserWindowCreator = {
  source: unknown;
  identity: PluginFrameIdentity;
};

type CurrentFrameRegistry = {
  isCurrent: (source: unknown, identity: PluginFrameIdentity) => boolean;
};

type OwnedBrowserWindow = {
  id: string;
};

function sameIdentity(left: PluginFrameIdentity, right: PluginFrameIdentity) {
  if (left.kind !== right.kind || left.generation !== right.generation) return false;
  if (left.kind === "child" && right.kind === "child" && left.windowId !== right.windowId) return false;
  if ("mode" in left || "mode" in right) {
    if (!("mode" in left) || !("mode" in right)) return false;
    return left.mode === right.mode && left.pageDocumentId === right.pageDocumentId
      && left.docNonce === right.docNonce && left.expectedOrigin === right.expectedOrigin
      && left.parentOrigin === right.parentOrigin;
  }
  return true;
}

/** Deliver readiness only to the exact frame document that requested the child. */
export function postPluginBrowserWindowReadiness(options: {
  creator: PluginBrowserWindowCreator | undefined;
  sources: CurrentFrameRegistry;
  message: unknown;
  post: (source: unknown, message: unknown, identity: PluginFrameIdentity) => boolean;
}) {
  const { creator } = options;
  if (!creator || !options.sources.isCurrent(creator.source, creator.identity)) return false;
  return options.post(creator.source, options.message, creator.identity);
}

/** A child may control itself and direct children it created from this live frame. */
export function isPluginBrowserWindowTargetOwned(options: {
  targetId: string;
  source: unknown;
  identity: PluginFrameIdentity;
  sources: CurrentFrameRegistry;
  windows: readonly OwnedBrowserWindow[];
  creatorFor: (windowId: string) => PluginBrowserWindowCreator | undefined;
}) {
  if (!options.sources.isCurrent(options.source, options.identity)) return false;
  if (options.identity.kind === "child" && options.targetId === options.identity.windowId) return true;
  return options.windows.some((candidate) => {
    const creator = options.creatorFor(candidate.id);
    if (!creator || candidate.id !== options.targetId || creator.source !== options.source) return false;
    return sameIdentity(creator.identity, options.identity);
  });
}

export function isPluginBrowserWindowCreateCurrent(options: {
  capturedGeneration: number;
  currentGeneration: number;
  creator: PluginBrowserWindowCreator;
  sources: CurrentFrameRegistry;
}) {
  return options.capturedGeneration === options.currentGeneration
    && options.sources.isCurrent(options.creator.source, options.creator.identity);
}
