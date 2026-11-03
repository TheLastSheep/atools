import { build } from "vite";

/** Build the production loader and its local helpers as one browser-importable module. */
export async function bundlePluginResourceLoader(entryPath) {
  const outputs = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      lib: { entry: entryPath, formats: ["es"], fileName: "plugin-resource-loader.mjs" },
      rollupOptions: { external: [] },
    },
  });
  const code = outputs[0]?.output?.find((item) => item.type === "chunk")?.code;
  if (!code) throw new Error("Failed to bundle plugin resource loader");
  return code;
}
