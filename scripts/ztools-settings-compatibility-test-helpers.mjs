import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const packageRequire = createRequire(new URL('../packages/ztools-settings/package.json', import.meta.url))
const { compileScript, parse } = packageRequire('@vue/compiler-sfc')
const ts = packageRequire('typescript')
const { createRenderer } = packageRequire('vue')

function parseVue(source, filename) {
  const { descriptor, errors } = parse(source, { filename })
  assert.deepEqual(errors, [], `${filename} must remain a valid Vue SFC`)
  return descriptor
}

function vueTemplateStyleBlocks(source, filename) {
  const descriptor = parseVue(source, filename)
  const fullBlock = (block) => {
    if (!block) return null
    const contentStart = block.loc.start.offset
    assert.equal(source[contentStart - 1], '>', `${filename} <${block.type}> opener is missing`)
    let quote = null
    let start = -1
    for (let index = contentStart - 2; index >= 0; index -= 1) {
      const character = source[index]
      if (quote) {
        if (character === quote) quote = null
      } else if (character === '"' || character === "'") {
        quote = character
      } else if (character === '<') {
        start = index
        break
      }
    }
    assert.notEqual(start, -1, `${filename} <${block.type}> opening tag start is missing`)
    assert.ok(source.startsWith(`<${block.type}`, start), `${filename} opener type is incorrect`)
    const opening = source.slice(start, contentStart)
    if (/\/\s*>$/.test(opening)) return opening
    const closeStart = block.loc.end.offset
    assert.ok(source.startsWith(`</${block.type}`, closeStart), `${filename} closing tag is missing`)
    const closeEnd = source.indexOf('>', closeStart)
    assert.notEqual(closeEnd, -1, `${filename} closing tag is incomplete`)
    return source.slice(start, closeEnd + 1)
  }
  return {
    template: fullBlock(descriptor.template),
    styles: descriptor.styles.map(fullBlock)
  }
}

export function vueTemplateStyleBytes(source, filename) {
  return JSON.stringify(vueTemplateStyleBlocks(source, filename))
}

export function vueTemplateBytes(source, filename) {
  return vueTemplateStyleBlocks(source, filename).template
}

export function vueStyleBytes(source, filename) {
  return JSON.stringify(vueTemplateStyleBlocks(source, filename).styles)
}

function compiledVueScript(source, filename) {
  const descriptor = parseVue(source, filename)
  return compileScript(descriptor, {
    id: `settings-compat-${path.basename(filename)}`,
    inlineTemplate: true
  }).content
}

const typeErasureCompilerOptions = Object.freeze({
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  removeComments: true,
  sourceMap: false,
  inlineSourceMap: false
})

function assertDeclarationStatementsAreTypeOnly(statements, filename) {
  for (const statement of statements) {
    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isImportDeclaration(statement) ||
      ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      continue
    }
    if (ts.isModuleDeclaration(statement)) {
      if (statement.body && ts.isModuleBlock(statement.body)) {
        assertDeclarationStatementsAreTypeOnly(statement.body.statements, filename)
      }
      continue
    }
    if (ts.isVariableStatement(statement)) {
      assert.ok(
        statement.declarationList.declarations.every((declaration) => !declaration.initializer),
        `${filename} declaration file contains an initialized variable`
      )
      continue
    }
    if (ts.isFunctionDeclaration(statement)) {
      assert.equal(statement.body, undefined, `${filename} declaration file contains a function body`)
      continue
    }
    if (ts.isClassDeclaration(statement)) {
      for (const member of statement.members) {
        if (
          (ts.isMethodDeclaration(member) ||
            ts.isConstructorDeclaration(member) ||
            ts.isGetAccessorDeclaration(member) ||
            ts.isSetAccessorDeclaration(member)) && member.body
        ) {
          assert.fail(`${filename} declaration file contains executable class member code`)
        }
        if (ts.isPropertyDeclaration(member) && member.initializer) {
          assert.fail(`${filename} declaration file contains an initialized class property`)
        }
        assert.ok(!ts.isClassStaticBlockDeclaration(member), `${filename} contains a static block`)
      }
      continue
    }
    assert.fail(`${filename} declaration file contains ${ts.SyntaxKind[statement.kind]}`)
  }
}

function emittedDeclarationJavaScript(source, filename) {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  assert.equal(sourceFile.isDeclarationFile, true, `${filename} must be parsed as a declaration file`)
  assert.deepEqual(sourceFile.parseDiagnostics, [], `${filename} must remain syntactically valid`)
  assertDeclarationStatementsAreTypeOnly(sourceFile.statements, filename)
  return ''
}

function transpileTypeScript(source, filename) {
  const result = ts.transpileModule(source, {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: {
      ...typeErasureCompilerOptions
    }
  })
  const errors = (result.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
  )
  const details = errors.map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  ).join('; ')
  assert.deepEqual(errors, [], `${filename} TypeScript emit failed${details ? `: ${details}` : ''}`)
  return result.outputText
}

function emittedJavaScript(source, filename) {
  if (filename.endsWith('.d.ts')) return emittedDeclarationJavaScript(source, filename)
  const typescriptSource = filename.endsWith('.vue')
    ? compiledVueScript(source, filename)
    : source
  const typescriptFilename = filename.endsWith('.vue') ? `${filename}.ts` : filename
  return transpileTypeScript(typescriptSource, typescriptFilename)
}

export function assertTypeOnlyOutputUnchanged(filename, before, after) {
  const emittedBefore = emittedJavaScript(before, filename)
  const emittedAfter = emittedJavaScript(after, filename)
  assert.equal(emittedAfter, emittedBefore, `${filename} type-only patch changed emitted JavaScript`)
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createHostRenderer(captchaOptions, callbackPromises) {
  function insert(node, parent, anchor = null) {
    const siblings = parent.children || (parent.children = [])
    node.parent = parent
    const index = anchor ? siblings.indexOf(anchor) : -1
    if (index < 0) siblings.push(node)
    else siblings.splice(index, 0, node)
  }

  return createRenderer({
    patchProp(node, key, _previous, value) {
      node.props[key] = value
      if (key === 'id') node.id = value
    },
    insert,
    remove(node) {
      const siblings = node.parent?.children
      if (siblings) {
        const index = siblings.indexOf(node)
        if (index >= 0) siblings.splice(index, 1)
      }
      node.parent = null
    },
    createElement(type) {
      const node = { type, children: [], props: {}, parent: null }
      if (type === 'button') {
        node.click = () => {
          if (captchaOptions.current) {
            callbackPromises.push(captchaOptions.current.captchaVerifyCallback('fixture-token'))
          }
        }
      }
      return node
    },
    createText(text) {
      return { type: '#text', text, parent: null }
    },
    createComment(text) {
      return { type: '#comment', text, parent: null }
    },
    setText(node, text) {
      node.text = text
    },
    setElementText(node, text) {
      node.textContent = text
      node.children = []
    },
    parentNode(node) {
      return node.parent || null
    },
    nextSibling(node) {
      const siblings = node.parent?.children || []
      return siblings[siblings.indexOf(node) + 1] || null
    },
    insertStaticContent(content, parent, anchor) {
      const node = { type: '#static', content, children: [], parent: null }
      insert(node, parent, anchor)
      return [node, node]
    }
  })
}

async function waitForCaptchaOptions(options) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (options.current) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail('Aliyun captcha bootstrap did not install its callback within the bounded wait')
}

async function mountCaptcha(source, modulePath) {
  const componentPath = `${modulePath}-${Math.random().toString(36).slice(2)}.mjs`
  const compiled = emittedJavaScript(source, 'AliyunCaptcha.vue')
  await writeFile(componentPath, compiled)
  const { default: component } = await import(pathToFileURL(componentPath).href)

  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const captchaOptions = { current: null }
  const callbackPromises = []
  const timers = new Map()
  let nextTimerId = 1
  globalThis.window = {
    setTimeout(callback) {
      const id = nextTimerId++
      timers.set(id, callback)
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    ztools: {
      internal: {
        async syncGetCaptchaConfig() {
          return { success: true, config: { enabled: true, prefix: 'fixture', sceneId: 'fixture' } }
        }
      }
    },
    initAliyunCaptcha(options) {
      captchaOptions.current = options
      options.getInstance?.({})
    }
  }
  globalThis.document = {
    querySelector() {
      return {}
    },
    head: { appendChild() {} }
  }

  const renderer = createHostRenderer(captchaOptions, callbackPromises)
  const root = { type: '#root', children: [] }
  const app = renderer.createApp(component)
  try {
    const exposed = app.mount(root)
    await waitForCaptchaOptions(captchaOptions)
    return {
      exposed,
      app,
      root,
      callbackPromises,
      timers,
      dispose() {
        app.unmount()
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
        else delete globalThis.window
        if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
        else delete globalThis.document
      }
    }
  } catch (error) {
    app.unmount()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else delete globalThis.window
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else delete globalThis.document
    throw error
  }
}

async function assertSupersededCaptchaRequestDoesNotSettleNewRequest(source, modulePath, lateResult) {
  const harness = await mountCaptcha(source, modulePath)
  const firstBusiness = deferred()
  const secondBusiness = deferred()
  const first = harness.exposed.execute(() => firstBusiness.promise)
  const firstOutcome = first.then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error })
  )
  assert.equal(harness.callbackPromises.length, 1)

  let secondSettled = false
  const second = harness.exposed.execute(() => secondBusiness.promise)
  const secondOutcome = second.then(
    (value) => {
      secondSettled = true
      return { status: 'resolved', value }
    },
    (error) => {
      secondSettled = true
      return { status: 'rejected', error }
    }
  )
  assert.equal(harness.callbackPromises.length, 2)
  const secondTimer = Math.max(...harness.timers.keys())
  assert.equal((await firstOutcome).status, 'rejected', 'superseding execute should reject request A')

  if (lateResult.kind === 'resolve') firstBusiness.resolve('late A')
  else firstBusiness.reject(new Error('late A business failure'))
  await harness.callbackPromises[0]

  assert.equal(secondSettled, false, 'late request A callback must not settle request B')
  assert.equal(harness.timers.has(secondTimer), true, 'late request A callback must not clear request B timeout')

  secondBusiness.resolve('request B result')
  await harness.callbackPromises[1]
  assert.deepEqual(await secondOutcome, { status: 'resolved', value: 'request B result' })
  harness.dispose()
}

export async function assertCaptchaBehavior(source, modulePath) {
  await assertSupersededCaptchaRequestDoesNotSettleNewRequest(source, modulePath, { kind: 'resolve' })
  await assertSupersededCaptchaRequestDoesNotSettleNewRequest(source, modulePath, { kind: 'reject' })

  {
    const harness = await mountCaptcha(source, modulePath)
    const run = harness.exposed.execute(async () => 'success')
    assert.equal(await run, 'success')
    assert.deepEqual(await harness.callbackPromises[0], { captchaResult: true, bizResult: true })
    harness.dispose()
  }

  {
    const harness = await mountCaptcha(source, modulePath)
    const run = harness.exposed.execute(async () => { throw new Error('business failure') })
    await assert.rejects(run, /business failure/)
    assert.deepEqual(await harness.callbackPromises[0], { captchaResult: true, bizResult: false })
    harness.dispose()
  }

  {
    const harness = await mountCaptcha(source, modulePath)
    let attempt = 0
    let settled = false
    const run = harness.exposed.execute(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('captcha verification failed')
      return 'retry success'
    })
    void run.then(() => { settled = true }, () => { settled = true })
    assert.deepEqual(await harness.callbackPromises[0], { captchaResult: false, bizResult: false })
    assert.equal(settled, false, 'captcha rejection should leave the active request available for retry')

    const button = findButton(harness)
    button.click()
    assert.deepEqual(await harness.callbackPromises[1], { captchaResult: true, bizResult: true })
    assert.equal(await run, 'retry success')
    harness.dispose()
  }
}

function findButton(harness) {
  const visit = (node) => {
    if (node?.type === 'button') return node
    for (const child of node?.children || []) {
      const found = visit(child)
      if (found) return found
    }
    return null
  }
  const button = visit(harness.root)
  return button
}
