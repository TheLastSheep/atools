#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_URL = "https://github.com/TheLastSheep/atools.git";
const GITHUB_PACKAGES_REGISTRY = "https://npm.pkg.github.com";

export function parseStageArgs(argv) {
  let outputDir = path.join(REPO_ROOT, "target", "github-packages", "npm");
  let scope = "@thelastsheep";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output" && argv[index + 1]) {
      outputDir = path.resolve(argv[index + 1]);
      index += 1;
    } else if (arg === "--scope" && argv[index + 1]) {
      scope = argv[index + 1].startsWith("@")
        ? argv[index + 1]
        : `@${argv[index + 1]}`;
      index += 1;
    }
  }

  return { outputDir, scope: scope.toLowerCase() };
}

function copyIfExists(sourcePath, destinationPath) {
  if (!fs.existsSync(sourcePath)) {
    return false;
  }
  fs.cpSync(sourcePath, destinationPath, { recursive: true });
  return true;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function stageGithubNpmPackages({
  repoRoot = REPO_ROOT,
  outputDir = path.join(repoRoot, "target", "github-packages", "npm"),
  scope = "@thelastsheep",
} = {}) {
  const rootPackage = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const version = rootPackage.version;
  const normalizedScope = scope.startsWith("@")
    ? scope.toLowerCase()
    : `@${scope.toLowerCase()}`;

  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const packageSpecs = [
    {
      slug: "atools-ztools-renderer",
      description:
        "Pinned ZTools renderer bundle and source manifest packaged for ATools hosts",
      sourceDir: path.join(repoRoot, "packages", "ztools-renderer"),
      distSource: path.join(repoRoot, "packages", "ztools-renderer", "dist"),
      extraFiles: ["README.md", "source-manifest.json"],
    },
    {
      slug: "atools-ztools-settings",
      description:
        "Pinned ZTools settings web bundle and source manifest packaged for ATools hosts",
      sourceDir: path.join(repoRoot, "packages", "ztools-settings"),
      distSource: path.join(repoRoot, "packages", "ztools-settings", "dist"),
      extraFiles: ["README.md", "source-manifest.json"],
    },
    {
      slug: "atools-ztools-updater",
      description:
        "Pinned ZTools updater UI bundle and Tauri host bridge packaged for ATools hosts",
      sourceDir: path.join(repoRoot, "packages", "ztools-updater"),
      distSource: path.join(repoRoot, "dist-ztools-updater"),
      extraFiles: ["README.md", "source-manifest.json"],
    },
  ];

  const stagedPackages = [];

  for (const spec of packageSpecs) {
    const pkgDir = path.join(outputDir, spec.slug);
    fs.mkdirSync(pkgDir, { recursive: true });

    const copiedDist = copyIfExists(spec.distSource, path.join(pkgDir, "dist"));
    for (const fileName of spec.extraFiles) {
      copyIfExists(
        path.join(spec.sourceDir, fileName),
        path.join(pkgDir, fileName),
      );
    }

    writeJson(path.join(pkgDir, "index.json"), {
      name: `${normalizedScope}/${spec.slug}`,
      version,
      hasDistBundle: copiedDist,
    });

    const manifest = {
      name: `${normalizedScope}/${spec.slug}`,
      version,
      description: spec.description,
      license: "MIT",
      type: "module",
      main: "./index.json",
      exports: {
        ".": "./index.json",
        "./source-manifest": "./source-manifest.json",
      },
      files: ["index.json", "source-manifest.json", "README.md", "dist"],
      repository: {
        type: "git",
        url: REPOSITORY_URL,
        directory: `packages/${spec.slug.replace(/^atools-/, "")}`,
      },
      publishConfig: {
        registry: GITHUB_PACKAGES_REGISTRY,
        access: "public",
      },
    };

    writeJson(path.join(pkgDir, "package.json"), manifest);
    stagedPackages.push({
      name: manifest.name,
      version,
      dir: pkgDir,
    });
  }

  const hostShimSlug = "atools-host-api-shim";
  const hostShimDir = path.join(outputDir, hostShimSlug);
  fs.mkdirSync(path.join(hostShimDir, "src"), { recursive: true });
  copyIfExists(
    path.join(repoRoot, "src", "lib", "hostApiSurfaceManifest.ts"),
    path.join(hostShimDir, "src", "hostApiSurfaceManifest.ts"),
  );
  copyIfExists(
    path.join(repoRoot, "src", "lib", "pluginApiStandinProbe.ts"),
    path.join(hostShimDir, "src", "pluginApiStandinProbe.ts"),
  );
  copyIfExists(
    path.join(repoRoot, "scripts", "compare-host-api-surface.mjs"),
    path.join(hostShimDir, "compare-host-api-surface.mjs"),
  );
  fs.writeFileSync(
    path.join(hostShimDir, "README.md"),
    `# ${normalizedScope}/${hostShimSlug}\n\nATools uTools + ZTools dual-namespace host API surface manifest, prototype stand-in probe, and surface comparator CLI.\n`,
    "utf8",
  );

  const hostShimManifest = {
    name: `${normalizedScope}/${hostShimSlug}`,
    version,
    description:
      "ATools uTools/ZTools dual-namespace host API surface manifest, stand-in probe, and surface comparator",
    license: "MIT",
    type: "module",
    main: "./compare-host-api-surface.mjs",
    bin: {
      "atools-compare-host-api-surface": "./compare-host-api-surface.mjs",
    },
    exports: {
      ".": "./compare-host-api-surface.mjs",
      "./manifest": "./src/hostApiSurfaceManifest.ts",
      "./standin-probe": "./src/pluginApiStandinProbe.ts",
    },
    files: [
      "compare-host-api-surface.mjs",
      "src/hostApiSurfaceManifest.ts",
      "src/pluginApiStandinProbe.ts",
      "README.md",
    ],
    repository: {
      type: "git",
      url: REPOSITORY_URL,
    },
    publishConfig: {
      registry: GITHUB_PACKAGES_REGISTRY,
      access: "public",
    },
  };

  writeJson(path.join(hostShimDir, "package.json"), hostShimManifest);
  stagedPackages.push({
    name: hostShimManifest.name,
    version,
    dir: hostShimDir,
  });

  writeJson(path.join(outputDir, "manifest.json"), {
    version,
    registry: GITHUB_PACKAGES_REGISTRY,
    scope: normalizedScope,
    packages: stagedPackages,
  });

  return {
    version,
    registry: GITHUB_PACKAGES_REGISTRY,
    scope: normalizedScope,
    outputDir,
    packages: stagedPackages,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseStageArgs(process.argv.slice(2));
  const summary = stageGithubNpmPackages(options);
  console.log(
    `staged ${summary.packages.length} GitHub Packages in ${summary.outputDir} (${summary.packages.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ")})`,
  );
}
