export const asyncCaptchaPatches = [
  {
    path: 'internal-plugins/setting/src/components/common/AccountLoginDialog/AliyunCaptcha.vue',
    beforeSha256: 'c2d5190c31ff57d577dea001f06a690ac458c4094825e725ce3dd1ce1ad7e5c2',
    changes: [
      {
        id: 'captcha-callback-settles-only-active-request',
        kind: 'async-guard',
        before: `async function captchaVerifyCallback(captchaVerifyParam: string): Promise<{\n  captchaResult: boolean\n  bizResult: boolean\n}> {\n  if (!pending) return { captchaResult: false, bizResult: false }\n  try {\n    const result = await pending.business(captchaVerifyParam)\n    window.clearTimeout(pending.timeoutId)\n    pending.resolve(result)\n    pending = null\n    return { captchaResult: true, bizResult: true }\n  } catch (err) {\n    if (isCaptchaFailure(err)) {\n      return { captchaResult: false, bizResult: false }\n    }\n    window.clearTimeout(pending.timeoutId)\n    pending.reject(err)\n    pending = null\n    return { captchaResult: true, bizResult: false }\n  }\n}`,
        after: `async function captchaVerifyCallback(captchaVerifyParam: string): Promise<{\n  captchaResult: boolean\n  bizResult: boolean\n}> {\n  const activePending = pending\n  if (!activePending) return { captchaResult: false, bizResult: false }\n  try {\n    const result = await activePending.business(captchaVerifyParam)\n    if (pending !== activePending) return { captchaResult: false, bizResult: false }\n    window.clearTimeout(activePending.timeoutId)\n    activePending.resolve(result)\n    pending = null\n    return { captchaResult: true, bizResult: true }\n  } catch (err) {\n    if (isCaptchaFailure(err) || pending !== activePending) {\n      return { captchaResult: false, bizResult: false }\n    }\n    window.clearTimeout(activePending.timeoutId)\n    activePending.reject(err)\n    pending = null\n    return { captchaResult: true, bizResult: false }\n  }\n}`
      }
    ]
  }
]
