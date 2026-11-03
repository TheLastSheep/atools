import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const upstreamPath = process.env.ATOOLS_ZTOOLS_SOURCE?.trim()
assert.ok(upstreamPath?.startsWith('/'), 'Set ATOOLS_ZTOOLS_SOURCE to the absolute pinned ZTools checkout')
const upstreamRoot = realpathSync(upstreamPath)
const sourceManifest = JSON.parse(readFileSync(path.join(repoRoot, 'packages/ztools-renderer/source-manifest.json'), 'utf8'))
const upstreamCommit = execFileSync('git', ['-C', upstreamRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const upstreamDirty = execFileSync('git', ['-C', upstreamRoot, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' }).trim()
assert.equal(upstreamCommit, sourceManifest.source.commit, 'upstream must match the renderer source manifest')
assert.equal(upstreamDirty, '', 'upstream must be clean')

const upstreamRequire = createRequire(path.join(upstreamRoot, 'package.json'))

function locatePackageRoot(entryPath, expectedName) {
  let current = path.dirname(realpathSync(entryPath))
  while (true) {
    const manifestPath = path.join(current, 'package.json')
    try {
      const metadata = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (metadata.name === expectedName) return { root: realpathSync(current), metadata }
    } catch {
      // Keep walking until the package's own manifest is found.
    }
    const parent = path.dirname(current)
    if (parent === current) throw new Error(`Could not locate ${expectedName} package root`)
    current = parent
  }
}

function exportedImportPath(packageInfo, exportKey) {
  const entry = packageInfo.metadata.exports?.[exportKey]
  const target = typeof entry === 'string' ? entry : entry?.import
  assert.ok(typeof target === 'string' && target.startsWith('./'), `${exportKey} must provide an ESM export`)
  const file = realpathSync(path.resolve(packageInfo.root, target))
  const relative = path.relative(packageInfo.root, file)
  assert.ok(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `${exportKey} must stay in the pinned package`)
  return file
}

const fullPackage = locatePackageRoot(upstreamRequire.resolve('fuse.js'), 'fuse.js')
const basicPackage = locatePackageRoot(upstreamRequire.resolve('fuse.js/basic'), 'fuse.js')
assert.equal(fullPackage.root, basicPackage.root, 'full and basic entrypoints must come from one installed package')
assert.equal(fullPackage.metadata.version, '7.1.0', 'comparison is pinned to upstream Fuse.js 7.1.0')
assert.equal(basicPackage.metadata.version, fullPackage.metadata.version)

const [fullModule, basicModule] = await Promise.all([
  import(pathToFileURL(exportedImportPath(fullPackage, '.')).href),
  import(pathToFileURL(exportedImportPath(basicPackage, './basic')).href)
])
const FullFuse = fullModule.default
const BasicFuse = basicModule.default
assert.equal(typeof FullFuse, 'function')
assert.equal(typeof BasicFuse, 'function')

// These are the two option objects in commandDataStore.ts: rebuildFuseIndex()
// (global commands, including aliases) and buildPluginCommandItems(commandList)
// (a scoped index without aliases). `distance` is omitted upstream; Fuse 7.1.0
// supplies its default of 100, while ignoreLocation=true disables location bias.
const GLOBAL_OPTIONS = {
  keys: [
    { name: 'name', weight: 2 },
    { name: 'pinyin', weight: 1.5 },
    { name: 'pinyinAbbr', weight: 1 },
    { name: 'acronym', weight: 1.5 },
    { name: 'aliases', weight: 1.5 }
  ],
  threshold: 0,
  ignoreLocation: true,
  includeScore: true,
  includeMatches: true
}

const SCOPED_OPTIONS = {
  keys: [
    { name: 'name', weight: 2 },
    { name: 'pinyin', weight: 1.5 },
    { name: 'pinyinAbbr', weight: 1 },
    { name: 'acronym', weight: 1.5 }
  ],
  threshold: 0,
  ignoreLocation: true,
  includeScore: true,
  includeMatches: true
}

function command(id, name, fields = {}) {
  return {
    id,
    name,
    path: `/fixture/${id}`,
    type: 'plugin',
    featureCode: id,
    cmdType: 'text',
    pinyin: '',
    pinyinAbbr: '',
    acronym: '',
    aliases: [],
    ...fields
  }
}

const COMMANDS = [
  command('calculator-cn', '计算器', {
    pinyin: 'jisuanqi',
    pinyinAbbr: 'jsq',
    acronym: 'JSQ',
    aliases: ['calculator', 'calc.exe', '!^$=|', 'calculator']
  }),
  command('calculator-en', 'Calculator', {
    pinyin: 'jisuanqi',
    pinyinAbbr: 'jsq',
    acronym: 'CALC',
    aliases: ['calculator', 'calc.exe']
  }),
  command('text-search', 'Text Search', {
    pinyin: 'wenbensousuo',
    pinyinAbbr: 'wbss',
    acronym: 'TS',
    aliases: ['Find Text', '搜索文本']
  }),
  command('syntax-literal', 'Search !^$=| literally', {
    pinyin: 'sousuofushu',
    pinyinAbbr: 'ssfs',
    acronym: 'SL',
    aliases: ['operator !^$=|']
  }),
  command('far-match', `${'x'.repeat(140)} farneedle`, {
    pinyin: 'yuanweizifu',
    pinyinAbbr: 'ywzf',
    acronym: 'FM',
    aliases: []
  })
]

function makePair(collection, options) {
  // Each package builds a separate index from an independent copy of identical
  // command input and option data, matching the production constructor seam.
  const fullInput = structuredClone(collection)
  const basicInput = structuredClone(collection)
  return {
    full: new FullFuse(fullInput, structuredClone(options)),
    basic: new BasicFuse(basicInput, structuredClone(options))
  }
}

function compareSearch(pair, query) {
  const fullResults = pair.full.search(query)
  const basicResults = pair.basic.search(query)
  assert.deepStrictEqual(basicResults, fullResults, `result ordering, score, or matches differ for ${JSON.stringify(query)}`)
  return fullResults
}

test('pinned Fuse full and basic ESM builds produce identical renderer search results', async (t) => {
  assert.equal(GLOBAL_OPTIONS.threshold, 0)
  assert.equal(GLOBAL_OPTIONS.ignoreLocation, true)
  assert.equal(GLOBAL_OPTIONS.includeScore, true)
  assert.equal(GLOBAL_OPTIONS.includeMatches, true)
  assert.deepStrictEqual(GLOBAL_OPTIONS.keys, [
    { name: 'name', weight: 2 },
    { name: 'pinyin', weight: 1.5 },
    { name: 'pinyinAbbr', weight: 1 },
    { name: 'acronym', weight: 1.5 },
    { name: 'aliases', weight: 1.5 }
  ])

  await t.test('global index keeps Chinese, pinyin, aliases, punctuation, empty, case, and match metadata', () => {
    const pair = makePair(COMMANDS, GLOBAL_OPTIONS)
    for (const index of [pair.full, pair.basic]) {
      assert.equal(index.options.threshold, 0)
      assert.equal(index.options.distance, 100, 'upstream leaves Fuse 7.1.0 distance at its default')
      assert.equal(index.options.ignoreLocation, true)
      assert.equal(index.options.includeScore, true)
      assert.equal(index.options.includeMatches, true)
      assert.equal(index.options.useExtendedSearch, false)
    }
    assert.equal(Object.hasOwn(GLOBAL_OPTIONS, 'distance'), false, 'the renderer does not override Fuse distance')
    assert.deepStrictEqual(pair.full.options.keys, GLOBAL_OPTIONS.keys)
    assert.deepStrictEqual(pair.basic.options.keys, GLOBAL_OPTIONS.keys)
    const cases = [
      '计算器',
      'jisuanqi',
      'jsq',
      '',
      'CALCULATOR',
      'calc.exe',
      '!^$=|',
      'Find Text'
    ]
    for (const query of cases) compareSearch(pair, query)

    const duplicateAliasResults = compareSearch(pair, 'calculator')
    assert.deepStrictEqual(
      duplicateAliasResults.map((result) => result.item.id).sort(),
      ['calculator-cn', 'calculator-en']
    )
    assert.ok(duplicateAliasResults.every((result) => Number.isFinite(result.score)))
    assert.ok(duplicateAliasResults.some((result) => result.matches.some((match) => match.key === 'aliases')))

    const syntaxResults = compareSearch(pair, '!^$=|')
    assert.ok(syntaxResults.some((result) => result.item.id === 'calculator-cn'))
    const farMatch = compareSearch(pair, 'farneedle').find((result) => result.item.id === 'far-match')
    assert.ok(farMatch, 'ignoreLocation keeps an exact match beyond the default distance window')
  })

  await t.test('scoped commandList index preserves its no-alias key set and result payloads', () => {
    const scoped = COMMANDS.filter((entry) => entry.id !== 'syntax-literal')
    const pair = makePair(scoped, SCOPED_OPTIONS)
    for (const index of [pair.full, pair.basic]) {
      assert.equal(index.options.threshold, 0)
      assert.equal(index.options.distance, 100)
      assert.equal(index.options.ignoreLocation, true)
      assert.equal(index.options.includeScore, true)
      assert.equal(index.options.includeMatches, true)
      assert.equal(index.options.useExtendedSearch, false)
      assert.deepStrictEqual(index.options.keys, SCOPED_OPTIONS.keys)
    }
    for (const query of ['计算器', 'jisuanqi', 'jsq', '', 'CALCULATOR', 'not-present']) {
      compareSearch(pair, query)
    }

    const aliasOnly = compareSearch(pair, 'calc.exe')
    assert.deepStrictEqual(aliasOnly, [], 'the scoped upstream constructor intentionally omits aliases')
    const configuredKeys = SCOPED_OPTIONS.keys.map(({ name }) => name)
    assert.deepStrictEqual(configuredKeys, ['name', 'pinyin', 'pinyinAbbr', 'acronym'])
  })

  await t.test('independently built indexes stay equivalent across add, remove, and collection replacement', () => {
    const pair = makePair(COMMANDS, GLOBAL_OPTIONS)
    const newCommand = command('thermo-new', '温度转换器', {
      pinyin: 'wenduzhuanhuanqi',
      pinyinAbbr: 'wdzhq',
      acronym: 'WDC',
      aliases: ['temperature converter']
    })

    assert.deepStrictEqual(compareSearch(pair, 'temperature'), [])
    pair.full.add(structuredClone(newCommand))
    pair.basic.add(structuredClone(newCommand))
    assert.ok(compareSearch(pair, 'temperature').some((result) => result.item.id === 'thermo-new'))

    pair.full.remove((item) => item.id === 'thermo-new')
    pair.basic.remove((item) => item.id === 'thermo-new')
    assert.deepStrictEqual(compareSearch(pair, 'temperature'), [])

    const updated = COMMANDS.map((item) => item.id === 'text-search'
      ? { ...item, name: 'Updated Text Search', aliases: ['find updated text'] }
      : structuredClone(item))
    pair.full.setCollection(structuredClone(updated))
    pair.basic.setCollection(structuredClone(updated))
    assert.ok(compareSearch(pair, 'updated').some((result) => result.item.id === 'text-search'))
  })
})
