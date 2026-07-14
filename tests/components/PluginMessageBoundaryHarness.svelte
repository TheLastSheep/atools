<script lang="ts">
  import {
    identifyPluginMessageEvent,
    type PluginFrameIdentity,
    type PluginFrameSourceRegistry,
  } from "../../src/lib/pluginInvokePolicy";

  let {
    sources,
    onaccepted,
  }: {
    sources: PluginFrameSourceRegistry;
    onaccepted: (identity: PluginFrameIdentity, data: unknown) => void;
  } = $props();

  function handleMessage(event: MessageEvent) {
    const identity = identifyPluginMessageEvent(sources, event);
    if (identity) onaccepted(identity, event.data);
  }
</script>

<svelte:window onmessage={handleMessage} />
