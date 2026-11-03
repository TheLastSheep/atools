export const commandTypePatches = [
  {
    path: 'internal-plugins/setting/src/composables/usePluginCommandActions.ts',
    beforeSha256: 'e721d9533281799b8a15af8700a6b377a15812ae18f9f1f72ca54b905f3e1f61',
    changes: [
      {
        id: 'plugin-command-type-keeps-filter-narrowing',
        kind: 'type-only',
        before: `export interface UsePluginCommandActionsOptions {`,
        after: `type PluginCommandActionCommand = Omit<CommandActionCommand, 'type'> & { type: 'plugin' }\n\nexport interface UsePluginCommandActionsOptions {`
      },
      {
        id: 'plugin-command-cache-retains-plugin-type',
        kind: 'type-only',
        before: `const pluginCommands = ref<CommandActionCommand[]>([])`,
        after: `const pluginCommands = ref<PluginCommandActionCommand[]>([])`
      },
      {
        id: 'plugin-command-filter-is-a-type-guard',
        kind: 'type-only',
        before: `pluginCommands.value = all.filter((c) => c.path === pluginPath && c.type === 'plugin')`,
        after: `pluginCommands.value = all.filter(\n        (c): c is PluginCommandActionCommand => c.path === pluginPath && c.type === 'plugin'\n      )`
      },
      {
        id: 'plugin-command-lookup-retains-plugin-discriminant',
        kind: 'type-only',
        before: `  ): CommandActionCommand | undefined {
    return pluginCommands.value.find((c) => c.featureCode === featureCode && c.name === cmdName)
  }`,
        after: `  ): PluginCommandActionCommand | undefined {
    return pluginCommands.value.find((c) => c.featureCode === featureCode && c.name === cmdName)
  }`
      },
      {
        id: 'command-id-helper-accepts-all-command-kinds',
        kind: 'type-only',
        before: `  function getPluginCommandId(\n    pluginName: string,\n    featureCode: string,\n    cmdName: string,\n    cmdType: 'text' | 'window'\n  ): string {`,
        after: `  function getPluginCommandId(\n    pluginName: string,\n    featureCode: string,\n    cmdName: string,\n    cmdType: CommandCmdType\n  ): string {`
      },
      {
        id: 'disabled-command-helper-accepts-all-command-kinds',
        kind: 'type-only',
        before: `  function isCommandDisabled(\n    pluginName: string,\n    featureCode: string,\n    cmdName: string,\n    cmdType: 'text' | 'window'\n  ): boolean {`,
        after: `  function isCommandDisabled(\n    pluginName: string,\n    featureCode: string,\n    cmdName: string,\n    cmdType: CommandCmdType\n  ): boolean {`
      },
      {
        id: 'toggle-command-helper-accepts-all-command-kinds',
        kind: 'type-only',
        before: `  async function toggleCommandDisabled(\n    pluginName: string,\n    featureCode: string,\n    cmdName: string,\n    cmdType: 'text' | 'window'\n  ): Promise<void> {`,
        after: `  async function toggleCommandDisabled(\n    pluginName: string,\n    featureCode: string,\n    cmdName: string,\n    cmdType: CommandCmdType\n  ): Promise<void> {`
      },
      {
        id: 'match-menu-accepts-all-command-kinds',
        kind: 'type-only',
        before: `  async function handleMenuSelect(\n    key: string,\n    pluginName: string,\n    featureCode: string,\n    cmdName: string,\n    cmdType: 'text' | 'window'\n  ): Promise<void> {`,
        after: `  async function handleMenuSelect(\n    key: string,\n    pluginName: string,\n    featureCode: string,\n    cmdName: string,\n    cmdType: CommandCmdType\n  ): Promise<void> {`
      }
    ]
  },
  {
    path: 'internal-plugins/setting/src/views/ShortcutsSetting/ShortcutsSetting.vue',
    beforeSha256: '746709f7441db1a192693283f0f7b343c8b6fddd23d9dcc28c92a5001c80c078',
    changes: [
      {
        id: 'shortcut-command-id-helper-accepts-all-command-kinds',
        kind: 'type-only',
        before: `  featureCode?: string\n  cmdType?: 'text' | 'window'\n  pluginName?: string`,
        after: `  featureCode?: string\n  cmdType?: ShortcutsSettingCommandCmdType\n  pluginName?: string`
      }
    ]
  }
]
