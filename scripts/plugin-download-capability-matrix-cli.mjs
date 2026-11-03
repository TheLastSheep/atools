import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildPluginDownloadCapabilityMatrix } from "./plugin-download-capability-matrix.mjs";

function parseArgs(args) {
  const options = { threshold: 30, catalog: "", plugins: "", output: "" };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (["--threshold", "--catalog", "--plugins", "--output"].includes(key)) {
      const value = args[++index];
      if (!value) throw new Error(`${key} requires a value`);
      options[key.slice(2)] = value;
    } else throw new Error(`unknown option: ${key}`);
  }
  if (!options.catalog || !options.plugins) throw new Error("usage: node scripts/plugin-download-capability-matrix-cli.mjs --catalog FILE --plugins DIR [--threshold 30] [--output FILE]");
  return options;
}

export async function runCli(args) {
  const options = parseArgs(args);
  const report = await buildPluginDownloadCapabilityMatrix({ catalogPath: options.catalog, pluginsRoot: options.plugins, threshold: options.threshold });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    const outputPath = resolve(options.output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, output, { flag: "wx" });
  }
  else process.stdout.write(output);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runCli(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`plugin matrix failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
