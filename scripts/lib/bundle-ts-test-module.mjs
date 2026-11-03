import { isAbsolute } from "node:path";
import { build } from "vite";

/** Execute real local TS module graphs in Node fixtures, retaining package imports. */
export async function bundleTsTestModule(entryPath) {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      target: "esnext",
      lib: { entry: entryPath, formats: ["es"], fileName: "test-module.mjs" },
      rollupOptions: { external: id => !id.startsWith(".") && !isAbsolute(id) },
    },
  });
  const code = result[0]?.output?.find(output => output.type === "chunk")?.code;
  if (!code) throw Error("TS test module build produced no code: " + entryPath);
  return code;
}
