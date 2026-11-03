import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectNodeRuntimeBundle } from "./lib/node-runtime-bundle.mjs";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const options={};let output;
const args=process.argv.slice(2);
for(let index=0;index<args.length;index++) {
  const flag=args[index];
  if(flag==="--execute"){options.execute=true;continue;}
  if(flag==="--verify-signature"){options.verifySigned=true;continue;}
  if(!["--app","--target","--output","--team-id"].includes(flag) || !args[index+1] || args[index+1].startsWith("--"))throw new Error("Usage: verify-node-runtime-bundle.mjs --app <absolute app> --target <macOS Rust triple> [--execute] [--verify-signature --team-id <expected Apple Team ID>] [--output <absolute json>]");
  const value=args[++index];
  if(!["--target","--team-id"].includes(flag) && !isAbsolute(value))throw new Error(`${flag} must be absolute`);
  if(flag==="--output")output=value;else if(flag==="--team-id")options.expectedTeamId=value;else options[flag.slice(2)]=value;
}
if(!options.app || !options.target)throw new Error("--app and --target are required");
options.pin=JSON.parse(await readFile(join(root,"resources/node-runtime/pin.json"),"utf8"));
const result=await inspectNodeRuntimeBundle(options);
if(output)await writeFile(output,JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify(result,null,2));
