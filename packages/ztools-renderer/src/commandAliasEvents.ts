import {
  createRendererCommandInvalidationEvents,
  RENDERER_COMMAND_ALIASES_EVENT,
} from "./commandInvalidationEvents";
import type { RendererCommandInvalidationEvents } from "./commandInvalidationEvents";
import type { ZToolsRendererTransport } from "./types";

export {
  RENDERER_COMMAND_ALIASES_EVENT,
  RENDERER_COMMAND_ALIASES_MAX_BYTES,
} from "./commandInvalidationEvents";
export type {
  RendererCommandInvalidationEventsSnapshot as RendererCommandAliasEventsSnapshot,
  RendererCommandInvalidationEvents as RendererCommandAliasEvents,
} from "./commandInvalidationEvents";

/** Keeps the established alias API while sharing its lifecycle with other command invalidations. */
export function createRendererCommandAliasEvents(
  transport: Pick<ZToolsRendererTransport, "listen">,
  invalidateAliases: () => void,
): RendererCommandInvalidationEvents {
  return createRendererCommandInvalidationEvents(
    transport,
    RENDERER_COMMAND_ALIASES_EVENT,
    invalidateAliases,
  );
}

