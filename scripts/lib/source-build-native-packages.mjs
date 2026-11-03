import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

/** Private synthetic projects with real, copied local Vite dependencies; never installs packages. */
export async function createSourceBuildPackages(root, cohort, profile = "synthetic") {
  if (!["synthetic", "synthetic-typescript"].includes(profile)) throw Error("Unsupported private fixture profile");
  const typecheckProfile = profile === "synthetic-typescript";
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) throw Error("Private fixture requires macOS arm64/x64");
  const dependencies = join(cohort, "toolchain/node_modules");
  await mkdir(dependencies, { recursive: true, mode: 0o700 });
  const copied = new Map(), excludedOptional = [];
  const host = `darwin-${process.arch}`;
  async function copyPackage(name, from) {
    if (copied.has(name)) return;
    const metadata = await realpath(createRequire(from).resolve(`${name}/package.json`));
    const pkg = JSON.parse(await readFile(metadata, "utf8"));
    copied.set(name, { version: pkg.version, source: metadata });
    const target = join(dependencies, name);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await cp(dirname(metadata), target, { recursive: true, dereference: true, errorOnExist: true, force: false });
    for (const dependency of Object.keys(pkg.dependencies ?? {})) await copyPackage(dependency, metadata);
    for (const optional of Object.keys(pkg.optionalDependencies ?? {})) {
      if (optional === `@esbuild/${host}` || optional === `@rollup/rollup-${host}`) await copyPackage(optional, metadata);
      else excludedOptional.push({ owner: name, name: optional, reason: "Not required by this fixed non-watch macOS fixture" });
    }
  }
  await copyPackage("vite", join(root, "package.json"));
  let typescriptFixture = null;
  if (typecheckProfile) {
    const metadataPath = await realpath(createRequire(join(root, "package.json")).resolve("typescript/package.json"));
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    const tsc = metadata.bin?.tsc;
    if (metadata.name !== "typescript" || typeof metadata.version !== "string"
      || !/^\d+\.\d+\.\d+$/.test(metadata.version) || typeof tsc !== "string"
      || !/^(?:\.\/)?bin\/tsc$/.test(tsc) || (metadata.dependencies && Object.keys(metadata.dependencies).length)) {
      throw Error("Cached TypeScript package metadata is not an exact local compiler package");
    }
    const binPath = join(dirname(metadataPath), tsc);
    const [metadataBytes, binBytes] = await Promise.all([readFile(metadataPath), readFile(binPath)]);
    if (!binBytes.length || binBytes.length > 4096) throw Error("Cached TypeScript compiler shim exceeded its fixed bound");
    typescriptFixture = {
      root: dirname(metadataPath), version: metadata.version, binPath: tsc,
      metadataBytes: metadataBytes.length, metadataSha256: createHash("sha256").update(metadataBytes).digest("hex"),
      binBytes: binBytes.length, binSha256: createHash("sha256").update(binBytes).digest("hex"),
    };
    copied.set("typescript", { version: metadata.version, source: metadataPath });
  }
  const vite = copied.get("vite").version;
  const platformPackageName = `@esbuild/${host}`;
  const viteMetadata = JSON.parse(await readFile(join(dependencies, "vite/package.json"), "utf8"));
  const esbuildMetadata = JSON.parse(await readFile(join(dependencies, "esbuild/package.json"), "utf8"));
  const platformMetadata = JSON.parse(await readFile(join(dependencies, platformPackageName, "package.json"), "utf8"));
  const esbuildSpec = viteMetadata.dependencies?.esbuild;
  const platformSpec = esbuildMetadata.optionalDependencies?.[platformPackageName];
  if (typeof esbuildSpec !== "string" || typeof platformSpec !== "string"
    || platformMetadata.version !== copied.get(platformPackageName)?.version) {
    throw Error("Copied synthetic Vite/esbuild metadata is incomplete");
  }
  const name = "source-build-fixture";
  await mkdir(join(cohort, "baseline-publish"), { mode: 0o700 });
  const manifest = (version, main = "index.html") => ({ name, title: "本地转换验收", version, main,
    features: [{ code: "open", explain: "本地转换验收", cmds: ["source build fixture"] }] });
  await writeFile(join(cohort, "baseline-publish/plugin.json"), JSON.stringify(manifest("1.0.0")));
  await writeFile(join(cohort, "baseline-publish/index.html"), "<!doctype html><main>old</main>");
  const configurations = {
    success: "export default async () => { await new Promise(resolve => setTimeout(resolve, 1500)); return {}; };",
    cancel: "setInterval(() => {}, 1000); export default async () => { await new Promise(() => {}); return {}; };",
    invalid: "import {readFileSync,writeFileSync} from 'node:fs'; export default {plugins:[{name:'private-invalid-output',closeBundle(){const file='dist/plugin.json';const value=JSON.parse(readFileSync(file,'utf8'));value.name='different-private-id';writeFileSync(file,JSON.stringify(value));}}]};",
  };
  for (const [index, [kind, configuration]] of Object.entries(configurations).entries()) {
    const project = join(cohort, kind), version = `${index + 1}.0.0`;
    await mkdir(join(project, "public"), { recursive: true, mode: 0o700 });
    await cp(dependencies, join(project, "node_modules"), { recursive: true, errorOnExist: true, force: false });
    const usesTypecheck = typecheckProfile && kind !== "cancel";
    if (usesTypecheck) {
      await cp(typescriptFixture.root, join(project, "node_modules/typescript"), { recursive: true, dereference: true, errorOnExist: true, force: false });
    }
    const devDependencies = usesTypecheck ? { vite, typescript: typescriptFixture.version } : { vite };
    const pkg = { name: `${name}-${kind}`, version, type: "module",
      scripts: { build: usesTypecheck ? "tsc && vite build" : "vite build" }, devDependencies };
    await writeFile(join(project, "package.json"), JSON.stringify(pkg));
    const lockPackages = {
        "": { name: pkg.name, version, devDependencies },
        "node_modules/vite": { name: "vite", version: vite, dependencies: { esbuild: esbuildSpec } },
        "node_modules/esbuild": { name: "esbuild", version: esbuildMetadata.version,
          optionalDependencies: { [platformPackageName]: platformSpec } },
        [`node_modules/${platformPackageName}`]: { name: platformPackageName,
          version: platformMetadata.version, optional: true },
      };
    if (usesTypecheck) {
      lockPackages["node_modules/typescript"] = { name: "typescript", version: typescriptFixture.version, dev: true,
        bin: { tsc: typescriptFixture.binPath } };
    }
    await writeFile(join(project, "package-lock.json"), JSON.stringify({ name: pkg.name, version, lockfileVersion: 3, packages: lockPackages }));
    const publicMain = kind === "success" ? "../index.html" : "index.html";
    await writeFile(join(project, "public/plugin.json"), JSON.stringify(manifest(version, publicMain)));
    await writeFile(join(project, "index.html"), '<!doctype html><main>converted</main><script type="module" src="/source.ts"></script>');
    const source = usesTypecheck && kind === "invalid"
      ? 'const invalid: string = 17; document.querySelector("main")!.textContent=invalid;'
      : 'document.querySelector("main")!.textContent="built private fixture";';
    await writeFile(join(project, "source.ts"), source);
    if (usesTypecheck) {
      await writeFile(join(project, "tsconfig.json"), JSON.stringify({ compilerOptions: {
        strict: true, noEmit: true, target: "ES2020", module: "ESNext", skipLibCheck: true,
      }, include: ["source.ts"] }));
    }
    await writeFile(join(project, "vite.config.mjs"), configuration);
  }
  return { synthetic: true, profile, originalPlugins: [], ownDependencyDirectories: true, packageManagerInvocations: 0,
    dependencyInstallation: false, copiedPackages: Object.fromEntries([...copied].map(([name, value]) => [name, value.version])),
    ...(typescriptFixture ? { typescriptFixture: { packageName: "typescript", version: typescriptFixture.version, binKey: "tsc",
      binPath: typescriptFixture.binPath, metadataBytes: typescriptFixture.metadataBytes, metadataSha256: typescriptFixture.metadataSha256,
      binBytes: typescriptFixture.binBytes, binSha256: typescriptFixture.binSha256,
      projects: ["success", "invalid"], lockScope: "Exact copied compiler metadata and lock entries for these two private fixture projects only" } } : {}),
    excludedOptional,
    lockScope: "Generated synthetic fixture metadata ties copied Vite to its copied esbuild and host platform package; not complete lock integrity or dependency closure proof" };
}
