export const selectorTypePatches = [
  {
    path: 'internal-plugins/setting/src/views/ShortcutsSetting/components/CommandTargetSelector.vue',
    beforeSha256: '1e86c70737deb61f357cadbf5e33313e5a3c6053da0b1029c2544b95098a1363',
    changes: [
      {
        id: 'selector-preserves-option-subtype',
        kind: 'type-only',
        before: `<script setup lang="ts">`,
        after: `<script setup lang="ts" generic="T extends ShortcutsSettingCommandTargetOptionBase">`
      },
      {
        id: 'selector-group-retains-option-subtype',
        kind: 'type-only',
        before: `  commands: ShortcutsSettingCommandTargetOptionBase[]`,
        after: `  commands: T[]`
      },
      {
        id: 'selector-options-retain-option-subtype',
        kind: 'type-only',
        before: `  options: ShortcutsSettingCommandTargetOptionBase[]`,
        after: `  options: T[]`
      },
      {
        id: 'selector-selected-option-retains-subtype',
        kind: 'type-only',
        before: `  selectedOption?: ShortcutsSettingCommandTargetOptionBase | null`,
        after: `  selectedOption?: T | null`
      },
      {
        id: 'selector-event-retains-option-subtype',
        kind: 'type-only',
        before: `  (e: 'select', value: ShortcutsSettingCommandTargetOptionBase): void`,
        after: `  (e: 'select', value: T): void`
      },
      {
        id: 'selector-handler-retains-option-subtype',
        kind: 'type-only',
        before: `function handleSelectTarget(target: ShortcutsSettingCommandTargetOptionBase): void {`,
        after: `function handleSelectTarget(target: T): void {`
      }
    ]
  }
]
