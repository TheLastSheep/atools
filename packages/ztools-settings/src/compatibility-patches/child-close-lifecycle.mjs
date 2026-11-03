export const childCloseLifecyclePatches = [{
  path: 'internal-plugins/setting/src/main.ts',
  beforeSha256: 'bf94ee1f636d7e0643dd14fe9a13a0797138c8a7b022f0d482a96d6e7f82a8fb',
  description: 'Do not remount General during destruction of the Settings child.',
  changes: [{
    id: 'settings-child-out-skips-general-remount',
    kind: 'child-close-lifecycle',
    before: `ztools.onPluginOut(() => {
  if (router.currentRoute.value.name === 'GeneralSetting') {
    return
  }

  void router.replace({ name: 'GeneralSetting' }).catch((error) => {
    console.error('[插件事件: onPluginOut] 重置设置页路由失败', error)
  })
})`,
    after: `ztools.onPluginOut(() => {
  // The host destroys this child on exit; its next session starts with a fresh route.
})`
  }]
}]
