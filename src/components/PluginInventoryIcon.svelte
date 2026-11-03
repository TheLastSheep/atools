<script lang="ts">
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { hasTauriAssetRuntime } from "../lib/resultIcons";
  import { pluginInventoryLogoSrc } from "../lib/pluginInventoryLogo";
  import type { InstalledPlugin } from "../lib/types";

  type Props = {
    pluginId: string;
    name: string;
    sourceKind: InstalledPlugin["source_kind"];
    logoPath: string | null | undefined;
  };
  let { pluginId, name, sourceKind, logoPath }: Props = $props();
  let failedImageKey = $state<string | null>(null);
  const src = $derived(pluginInventoryLogoSrc(logoPath, sourceKind, hasTauriAssetRuntime(), convertFileSrc));
  const imageKey = $derived(`${pluginId}\u0000${sourceKind ?? ""}\u0000${src ?? ""}`);
  const showImage = $derived(Boolean(src && failedImageKey !== imageKey));
</script>

<span class="inventory-icon" aria-hidden="true">
  {#if showImage && src}
    <img src={src} alt="" loading="lazy" decoding="async" onerror={() => failedImageKey = imageKey} />
  {:else}
    <span class="monogram">{name.slice(0, 1).toLocaleUpperCase()}</span>
  {/if}
</span>

<style>
  .inventory-icon {
    flex: 0 0 34px;
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    overflow: hidden;
    background: var(--settings-primary-soft, #f1edf9);
    color: var(--settings-primary, #7650d6);
    border: 1px solid var(--settings-control-border, #e3deef);
    border-radius: 9px;
  }
  .inventory-icon img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .monogram {
    font-size: 17px;
    font-weight: 550;
  }
  @media (max-width: 540px) {
    .inventory-icon {
      flex-basis: 30px;
      width: 30px;
      height: 30px;
    }
    .monogram { font-size: 15px; }
  }
</style>
