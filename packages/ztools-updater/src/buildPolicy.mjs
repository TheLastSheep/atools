import assert from 'node:assert/strict'
export function assertUpdaterBudget(measured, build) {
  assert.equal(build.budgetMilestone, 'original-vue-updater-2026-11-02')
  for (const [kind, actual] of [
    ['javascript', measured.totalJavaScriptBytes],
    ['resources', measured.totalResourceBytes]
  ]) {
    const limits = build[kind]
    assert.deepEqual(
      limits,
      kind === 'javascript'
        ? { baselineBytes: 104330, maxIncreaseBytes: 16384, maxBytes: 120714 }
        : { baselineBytes: 284598, maxIncreaseBytes: 16384, maxBytes: 300982 }
    )
    if (
      !Number.isSafeInteger(actual) ||
      actual < 0 ||
      actual > limits.maxBytes ||
      actual - limits.baselineBytes > limits.maxIncreaseBytes
    )
      throw new Error(`Updater ${kind} budget exceeded: ${actual} > ${limits.maxBytes}`)
  }
  return {
    milestone: build.budgetMilestone,
    javascript: build.javascript,
    resources: build.resources,
    passed: true
  }
}
