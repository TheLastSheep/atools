import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareNodeRuntime } from "./lib/node-runtime-package.mjs";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const options={cacheDir:join(root,"target/node-runtime-cache"),destination:join(root,"src-tauri/binaries")};
const args=process.argv.slice(2);
for(let index=0;index<args.length;index++) {
  const flag=args[index];
  if(flag==="--offline"){options.offline=true;continue;}
  const key=new Map([["--target","target"],["--archive","archive"],["--cache-dir","cacheDir"]]).get(flag);
  if(!key || !args[index+1] || args[index+1].startsWith("--"))throw new Error("Usage: prepare-node-runtime.mjs --target <macOS Rust triple> [--offline] [--archive <absolute path>] [--cache-dir <absolute path>]");
  options[key]=args[++index];
  if(key!=="target" && !isAbsolute(options[key]))throw new Error(`${flag} must be absolute`);
}
if(!options.target)throw new Error("--target is required; cross-build targets must never be guessed");
options.pin=JSON.parse(await readFile(join(root,"resources/node-runtime/pin.json"),"utf8"));
console.log(JSON.stringify(await prepareNodeRuntime(options),null,2));
