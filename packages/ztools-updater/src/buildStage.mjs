import { copyFile, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { patchUpdater, UPDATER_PATCH, updaterPatchReceipt } from './sourceCompatibility.mjs'
export async function createUpdaterStage(verified, packageRoot, temporaryRoot, apiRoot) {
  const root = path.join(temporaryRoot, 'upstream')
  for (const file of verified.files) {
    const destination = path.join(root, file)
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(path.join(verified.root, file), destination)
  }
  await symlink(path.join(verified.root, 'node_modules'), path.join(root, 'node_modules'), 'dir')
  await symlink(
    path.join(verified.root, 'node_modules'),
    path.join(temporaryRoot, 'node_modules'),
    'dir'
  )
  const host = path.join(temporaryRoot, 'host')
  await mkdir(host)
  for (const file of await readdir(path.join(packageRoot, 'src')))
    if (file.endsWith('.ts'))
      await copyFile(path.join(packageRoot, 'src', file), path.join(host, file))
  const component = path.join(root, UPDATER_PATCH.path),
    original = await readFile(component, 'utf8'),
    patched = patchUpdater(original)
  await writeFile(component, patched)
  const entry = path.join(root, 'src/renderer/src/updater-main.ts'),
    beforeEntry = await readFile(entry, 'utf8')
  await writeFile(entry, `import '@atools-updater/entry'\n${beforeEntry}`)
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      skipLibCheck: true,
      noEmit: true,
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      types: ['vite/client'],
      baseUrl: '.',
      paths: {
        '@renderer/*': ['src/renderer/src/*'],
        '@atools-updater/*': [host + '/*'],
        '@tauri-apps/api/*': [apiRoot + '/*.d.ts']
      }
    },
    vueCompilerOptions: { globalTypesPath: '../vue-global-types.d.ts' },
    include: [
      'src/renderer/src/updater-main.ts',
      'src/renderer/src/components/updater/UpdateWindow.vue',
      'src/renderer/src/env.d.ts',
      host + '/**/*.ts'
    ]
  }
  await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2))
  return {
    root,
    renderer: path.join(root, 'src/renderer'),
    host,
    patch: updaterPatchReceipt(original, patched)
  }
}
