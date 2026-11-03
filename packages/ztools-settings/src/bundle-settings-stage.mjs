import { builtinModules, createRequire } from 'node:module'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { isInside, sha256 } from './build-integrity.mjs'
import { hostBridgeSourceGuardPlugin } from './host-bridge-build.mjs'

const forbiddenBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')))

export const SETTINGS_PURE_DIAGNOSTIC_CALLS = Object.freeze([
  'console.log',
  'console.debug',
  'console.info'
])

function cleanModuleId(id) {
  if (id.startsWith('\0')) return null
  const filePath = id.split('?')[0]
  return path.isAbsolute(filePath) ? path.resolve(filePath) : null
}

function importedModuleIsForbidden(specifier) {
  const normalized = specifier.replace(/^node:/, '')
  const topLevel = normalized.split('/')[0]
  return normalized === 'electron' || forbiddenBuiltins.has(topLevel)
}

function rejectRuntimeExternalPlugin() {
  return {
    name: 'atools-settings-reject-node-runtime',
    enforce: 'pre',
    resolveId(source) {
      if (importedModuleIsForbidden(source)) {
        throw new Error(`Settings WebView cannot bundle Electron/Node module: ${source}`)
      }
      return null
    }
  }
}

function dependencyCapturePlugin(nodeModulesRoot, capturedFiles) {
  return {
    name: 'atools-settings-capture-dependency-inputs',
    enforce: 'pre',
    async load(id) {
      const filePath = cleanModuleId(id)
      if (!filePath) return null
      let resolved
      try {
        resolved = await realpath(filePath)
      } catch {
        return null
      }
      if (!isInside(nodeModulesRoot, resolved)) return null
      let info
      try {
        info = await lstat(resolved)
      } catch {
        return null
      }
      if (!info.isFile()) return null
      const bytes = await readFile(resolved)
      const key = path.relative(nodeModulesRoot, resolved).split(path.sep).join('/')
      capturedFiles.set(resolved, { key, sha256: sha256(bytes), bytes: bytes.byteLength })
      return null
    }
  }
}

async function loadBuildPackages(packageRoot) {
  const localRequire = createRequire(path.join(packageRoot, 'package.json'))
  const load = async (name) => {
    const entry = localRequire.resolve(name)
    const loaded = await import(pathToFileURL(entry).href)
    return loaded.default ?? loaded
  }
  const vite = await load('vite')
  const vuePlugin = await load('@vitejs/plugin-vue')
  const unoCss = await load('unocss/vite')
  return { vite, vuePlugin, unoCss }
}

export function createSettingsViteOptions({
  stage,
  manifest,
  temporaryRoot,
  temporaryOutput,
  nodeModulesRoot,
  upstream,
  hostBridgeSources,
  capturedFiles,
  hostBridgeRuntimeImports,
  packages
}) {
  const { vite, vuePlugin, unoCss } = packages
  return {
    configFile: false,
    root: stage.settingRoot,
    base: manifest.build.base,
    publicDir: path.join(stage.settingRoot, 'public'),
    cacheDir: path.join(temporaryRoot, 'vite-cache'),
    plugins: [
      rejectRuntimeExternalPlugin(),
      dependencyCapturePlugin(nodeModulesRoot, capturedFiles),
      hostBridgeSourceGuardPlugin({
        sources: hostBridgeSources,
        stageRoot: stage.root,
        upstreamFiles: upstream.files,
        nodeModulesRoot,
        runtimeImports: hostBridgeRuntimeImports
      }),
      vuePlugin(),
      unoCss(path.join(stage.settingRoot, 'uno.config.ts'))
    ],
    resolve: {
      alias: [
        { find: /^@shared(?=\/)/, replacement: path.join(stage.root, 'src/shared') },
        { find: /^@(?=\/)/, replacement: path.join(stage.settingRoot, 'src') }
      ],
      dedupe: ['vue']
    },
    esbuild: { pure: [...SETTINGS_PURE_DIAGNOSTIC_CALLS] },
    build: {
      outDir: temporaryOutput,
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: { input: path.join(stage.settingRoot, manifest.build.entryHtml) }
    },
    logLevel: 'info'
  }
}

export async function emitSettingsBundle({
  packageRoot,
  stage,
  manifest,
  temporaryRoot,
  temporaryOutput,
  upstream,
  hostBridgeSources
}) {
  const packages = await loadBuildPackages(packageRoot)
  const nodeModulesRoot = await realpath(path.join(packageRoot, 'node_modules'))
  const capturedFiles = new Map()
  const hostBridgeRuntimeImports = new Set()
  const options = createSettingsViteOptions({
    stage,
    manifest,
    temporaryRoot,
    temporaryOutput,
    nodeModulesRoot,
    upstream,
    hostBridgeSources,
    capturedFiles,
    hostBridgeRuntimeImports,
    packages
  })
  await packages.vite.build(options)
  return { capturedFiles, hostBridgeRuntimeImports }
}
