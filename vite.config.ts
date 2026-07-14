import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**", "**/crates/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari14",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    modulePreload: {
      resolveDependencies: (_filename, deps) =>
        deps.filter((dep) => !/(^|\/)(plugin-panel|pinyin-engine)-[^/]+\.js$/.test(dep)),
    },
    chunkSizeWarningLimit: 640,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/pinyin-pro")) return "pinyin-engine";
          if (id.endsWith("/src/components/PluginPanel.svelte")) return "plugin-panel";
        },
      },
    },
  },
});
