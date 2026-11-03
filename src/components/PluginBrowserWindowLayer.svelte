<script lang="ts">
  import type { PluginBrowserWindowState } from "../lib/pluginBrowserWindowTypes";
  import type { Action } from "svelte/action";

  type Props = {
    windows: PluginBrowserWindowState[];
    windowStyle: (window: PluginBrowserWindowState) => string;
    frameStyle: (window: PluginBrowserWindowState) => string;
    closeWindow: (id: string) => void;
    mountFrame: Action<HTMLIFrameElement, string>;
    iframeSandbox: string;
  };

  let { windows, windowStyle, frameStyle, closeWindow, mountFrame, iframeSandbox }: Props = $props();
</script>

    {#if windows.some(childWindow => childWindow.hostKind !== "native")}
      <div class="plugin-browser-window-layer" aria-label="插件子窗口">
        {#each windows.filter(childWindow => childWindow.hostKind !== "native") as childWindow (childWindow.id)}
          <section
            class="plugin-browser-window"
            class:hidden={!childWindow.visible}
            class:focused={childWindow.focused}
            class:positioned={childWindow.positioned}
            class:alwaysOnTop={childWindow.alwaysOnTop}
            class:minimized={childWindow.minimized}
            class:maximized={childWindow.maximized}
            class:fullScreen={childWindow.fullScreen}
            class:kiosk={childWindow.kiosk}
            class:flashing={childWindow.flashing}
            class:noShadow={!childWindow.hasShadow}
            class:windowButtonsHidden={!childWindow.windowButtonVisible}
            style={windowStyle(childWindow)}
            data-window-id={childWindow.id}
          >
            <header class="plugin-browser-window-bar">
              <div>
                <strong>{childWindow.title}</strong>
                <small>{childWindow.url}</small>
              </div>
              <button
                type="button"
                disabled={!childWindow.closable}
                title={childWindow.closable ? "关闭" : "关闭已禁用"}
                onclick={() => closeWindow(childWindow.id)}
              >关闭</button>
            </header>
            {#if childWindow.progressBar !== null || childWindow.progressBarMode === "indeterminate"}
              <div
                class="plugin-browser-window-progress"
                data-mode={childWindow.progressBarMode}
                aria-hidden="true"
              >
                <span style={`width: ${Math.round((childWindow.progressBar ?? 1) * 100)}%;`}></span>
              </div>
            {/if}
            {#key childWindow.documentGeneration}
              <iframe
                class="plugin-browser-window-frame"
                use:mountFrame={childWindow.id}
                srcdoc={childWindow.srcdoc}
                title={childWindow.title}
                style={frameStyle(childWindow)}
                sandbox={iframeSandbox}
              ></iframe>
            {/key}
          </section>
        {/each}
      </div>
    {/if}
