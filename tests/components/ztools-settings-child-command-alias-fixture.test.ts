import { describe, expect, it, vi } from 'vitest'
import { createSettingsChildBridge } from '../../packages/ztools-settings/src/childBridge'
import type { SettingsBridgeTarget } from '../../packages/ztools-settings/src/childBridgeTypes'
import type { SettingsZToolsApi } from '../../packages/ztools-settings/src/childBridgeApi'
import {
  SettingsAliasNativeTransportFixture,
  createFixtureCommandCatalog,
  createLegacyMissingTargetAliases
} from './ztoolsSettingsAliasNativeTransportFixture'

const CONFIG = {
  version: 1 as const,
  sessionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  bundleRevision: 'b'.repeat(64),
  platform: 'darwin' as const
}

function attachFixture(fixture: SettingsAliasNativeTransportFixture) {
  const target = new EventTarget() as SettingsBridgeTarget
  const bridge = createSettingsChildBridge({ config: CONFIG, invoke: fixture.invoke, reportError: vi.fn() })
  bridge.attach(target)
  return { bridge, internal: (target.ztools as SettingsZToolsApi).internal }
}

describe('ztools settings child command/alias transport fixture', () => {
  it('reads all 1,024 commands and retains regex/plugin metadata over bounded pages', async () => {
    const fixture = new SettingsAliasNativeTransportFixture({ pageBytes: 17 * 1024 })
    const { bridge, internal } = attachFixture(fixture)

    const commands = await internal.getCommands()
    expect(commands.commands).toHaveLength(1_024)
    expect(commands.regexCommands).toEqual(createFixtureCommandCatalog().regexCommands)
    expect(commands.plugins).toEqual(createFixtureCommandCatalog().plugins)
    expect(fixture.calls.filter((call) => call.operation === 'readCommandDataPage').length).toBeGreaterThan(1)
    expect(fixture.calls.every((call) => call.sessionId === CONFIG.sessionId)).toBe(true)
    bridge.dispose()
  })

  it('distinguishes missing storage from a stored empty-map no-op', async () => {
    expect(() => new SettingsAliasNativeTransportFixture({ aliases: null, aliasStoragePresent: true }))
      .toThrow('Synthetic fixture only allows null for a missing alias fact')
    const missing = new SettingsAliasNativeTransportFixture()
    const storedEmpty = new SettingsAliasNativeTransportFixture({ aliases: {} })
    const first = attachFixture(missing)
    const second = attachFixture(storedEmpty)

    expect(missing.hasAliasStorageFact).toBe(false)
    expect(storedEmpty.hasAliasStorageFact).toBe(true)
    await expect(first.internal.dbGet('command-aliases')).resolves.toBeNull()
    await expect(second.internal.dbGet('command-aliases')).resolves.toEqual({})
    await expect(first.internal.updateCommandAliases({})).resolves.toMatchObject({ success: true })
    await expect(second.internal.updateCommandAliases({})).resolves.toMatchObject({ success: true })
    expect(missing.hasAliasStorageFact).toBe(false)
    expect(storedEmpty.hasAliasStorageFact).toBe(true)
    expect(missing.getAliases()).toBeNull()
    expect(storedEmpty.getAliases()).toEqual({})
    first.bridge.dispose()
    second.bridge.dispose()
  })

  it('passes the normalized legacy and missing-target projection through unchanged', async () => {
    const aliases = createLegacyMissingTargetAliases()
    const fixture = new SettingsAliasNativeTransportFixture({ aliases, aliasStoragePresent: true })
    const { bridge, internal } = attachFixture(fixture)

    const readValue = await internal.dbGet('command-aliases')
    expect(readValue).toEqual(aliases)
    const candidate = {
      ...(readValue as Record<string, unknown>),
      'direct:app:/Applications/current.app': [{ alias: 'renamed current alias', icon: 'app://icon' }]
    }
    await expect(internal.updateCommandAliases(candidate)).resolves.toMatchObject({ success: true })
    expect(fixture.getAliases()).toEqual(candidate)
    expect(fixture.getAliases()).toHaveProperty('direct:app:/Applications/removed.app', [
      { alias: 'legacy orphan alias' }
    ])
    expect(fixture.getAliases()).toHaveProperty('missing-plugin:feature:old-command:text')
    bridge.dispose()
  })

  it('uses bounded staged operations for a large candidate through the transport fixture', async () => {
    const fixture = new SettingsAliasNativeTransportFixture({ aliases: {} })
    const { bridge, internal } = attachFixture(fixture)
    await internal.dbGet('command-aliases')
    const candidate = {
      'direct:app:/Applications/Large.app': Array.from({ length: 120 }, (_, index) => ({
        alias: `alias-${String(index).padStart(3, '0')}: ${'a'.repeat(400)}`,
        icon: `data:image/png;base64,${'b'.repeat(250)}`
      }))
    }
    // This is only candidate JSON sizing; the synthetic fixture does not assert Core persistence.
    const serializedBytes = new TextEncoder().encode(JSON.stringify(candidate)).byteLength
    expect(serializedBytes).toBeGreaterThan(40 * 1024)
    expect(serializedBytes).toBeLessThan(90 * 1024)
    expect(serializedBytes).toBeLessThan(128 * 1024)
    for (const entry of candidate['direct:app:/Applications/Large.app']) {
      expect(new TextEncoder().encode(entry.alias).byteLength).toBeLessThanOrEqual(512)
      expect(new TextEncoder().encode(entry.icon).byteLength).toBeLessThanOrEqual(65_536)
    }

    await expect(internal.updateCommandAliases(candidate)).resolves.toMatchObject({ success: true })
    const operations = fixture.calls.map((call) => call.operation)
    expect(operations).toContain('beginAliasWrite')
    expect(operations).toContain('appendAliasWrite')
    expect(operations.at(-1)).toBe('commitAliasWrite')
    expect(operations).not.toContain('writeAliases')
    expect(fixture.getAliases()).toEqual(candidate)
    bridge.dispose()
  })

  it('surfaces a CAS conflict and keeps the externally committed value', async () => {
    const fixture = new SettingsAliasNativeTransportFixture({ aliases: { bucket: [{ alias: 'before' }] } })
    const { bridge, internal } = attachFixture(fixture)
    await internal.dbGet('command-aliases')
    fixture.replaceAliasesExternally({ bucket: [{ alias: 'external commit' }] })

    await expect(internal.updateCommandAliases({ bucket: [{ alias: 'stale child value' }] })).rejects.toMatchObject({
      code: 'SETTINGS_ALIAS_REVISION_CONFLICT'
    })
    expect(fixture.getAliases()).toEqual({ bucket: [{ alias: 'external commit' }] })
    bridge.dispose()
  })

  it('models an unknown commit receipt as persisted but requiring a reread', async () => {
    const fixture = new SettingsAliasNativeTransportFixture({ interruptCommitAfterPersist: true })
    const { bridge, internal } = attachFixture(fixture)
    await internal.dbGet('command-aliases')

    await expect(internal.updateCommandAliases({ bucket: [{ alias: 'saved before reply loss' }] })).rejects.toMatchObject({
      code: 'SETTINGS_ALIAS_COMMIT_INTERRUPTED'
    })
    expect(fixture.getAliases()).toEqual({ bucket: [{ alias: 'saved before reply loss' }] })
    await expect(internal.updateCommandAliases({ bucket: [{ alias: 'blind retry' }] })).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_ALIAS_BASE_NOT_READ'
    })
    expect(fixture.calls.filter((call) => call.operation === 'writeAliases')).toHaveLength(1)
    await expect(internal.dbGet('command-aliases')).resolves.toEqual({
      bucket: [{ alias: 'saved before reply loss' }]
    })
    bridge.dispose()
  })
})
