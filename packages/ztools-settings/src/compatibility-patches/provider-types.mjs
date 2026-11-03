export const providerTypePatches = [
  {
    path: 'internal-plugins/setting/src/env.d.ts',
    beforeSha256: '9efb86fdb4adb14056bf97e0d3d40d3b3defc5aa0f1615d9dd284bf96286b0f5',
    changes: [
      {
        id: 'provider-filter-result-types-are-discriminated',
        kind: 'type-only',
        before: `declare global {`,
        after: `type SettingsProviderKind = 'translation' | 'ocr'\n\ntype SettingsProviderEntry<T extends SettingsProviderKind = SettingsProviderKind> = {\n  id: string\n  type: T\n  label: string\n  description: string\n  source: 'builtin' | 'plugin'\n  pluginName?: string\n  pluginPath?: string\n  pluginLogo?: string\n}\n\ntype SettingsProviderResponse<T extends SettingsProviderKind = SettingsProviderKind> = {\n  success: boolean\n  data?: SettingsProviderEntry<T>[]\n  error?: string\n}\n\ndeclare global {`
      },
      {
        id: 'provider-get-all-overloads-follow-backend-filter-contract',
        kind: 'type-only',
        before: `          getAll: (type?: 'translation' | 'ocr') => Promise<{\n            success: boolean\n            data?: Array<{\n              id: string\n              type: 'translation' | 'ocr'\n              label: string\n              description: string\n              source: 'builtin' | 'plugin'\n              pluginName?: string\n              pluginPath?: string\n              pluginLogo?: string\n            }>\n            error?: string\n          }>`,
        after: `          getAll: {\n            <T extends SettingsProviderKind>(type: T): Promise<SettingsProviderResponse<T>>\n            (type?: undefined): Promise<SettingsProviderResponse>\n          }`
      }
    ]
  }
]
