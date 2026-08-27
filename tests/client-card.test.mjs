/**
 * The browser card, exercised without a browser.
 *
 * The card is a lazy-CJS factory artifact, so the test supplies a minimal module
 * loader and a React stub that records the element tree. That is enough to assert
 * the facts that matter: it registers into the right slot under the right key,
 * it stages edits instead of writing per keystroke, Save writes both fields
 * through the revision-fenced scope, and a removed route takes its effort with it.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = join(import.meta.dirname, '..', 'lib', 'client.js')

/** A React stub recording createElement calls as a plain tree. */
function reactStub() {
  const hooks = { state: [], effects: [] }
  let cursor = 0
  const stub = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter(one => one !== null && one !== undefined && one !== false),
    }),
    useState(initial) {
      const index = cursor++
      if (hooks.state.length <= index) hooks.state.push(initial)
      return [hooks.state[index], (next) => { hooks.state[index] = next }]
    },
    useEffect(fn) { hooks.effects.push(fn) },
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    reset() { cursor = 0 },
  }
  return { stub, hooks }
}

/** Load the card factory and return its registration plus a render helper. */
function loadCard(scope) {
  const { stub, hooks } = reactStub()
  const registrations = []
  const injected = []
  const loaded = []
  globalThis.window = {
    __ModuleLoader__: {
      load: (entry) => { loaded.push(entry) },
    },
  }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ routes: CATALOG }) })

  const code = readFileSync(SOURCE, 'utf8')
  // eslint-disable-next-line no-new-func -- the artifact is a script, by format.
  new Function(code)()
  assert.equal(loaded.length, 1, 'the artifact registered no module')
  const ns = loaded[0].factory(name => {
    if (name === 'react') return stub
    throw new Error(`unexpected require: ${name}`)
  })

  const ctx = {
    slots: {
      inject: (name, run) => { injected.push(name); run() },
      register: (options, Component) => { registrations.push({ options, Component }); return () => {} },
    },
    settingsScope: { bind: () => scope },
  }
  ns.apply(ctx)
  return {
    ns,
    injected,
    registrations,
    render(Component) {
      stub.reset()
      hooks.effects.length = 0
      return { tree: Component(), hooks, stub }
    },
  }
}

const CATALOG = [
  { route: 'inherit/current', inherit: true, modalities: [] },
  { route: 'kiro/claude-opus-5', name: 'Claude Opus 5', modalities: ['text', 'image'], efforts: ['low', 'high'] },
  { route: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', modalities: ['text'] },
]

/** Collect every node of a rendered tree. */
function flatten(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) flatten(child, out)
  return out
}

/** All rendered text, joined. */
function textOf(node) {
  return flatten(node)
    .flatMap(one => one.children.filter(child => typeof child === 'string'))
    .join(' ')
}

function makeScope(value, writable = true) {
  const writes = []
  return {
    writes,
    subscribe: () => () => {},
    getSnapshot: () => ({ value, writable }),
    set: async (field, next) => { writes.push([field, next]) },
  }
}

test('the card registers into settings.plugin.item under its namespace', () => {
  const { injected, registrations } = loadCard(makeScope({}))
  assert.deepEqual(injected, ['settings.plugin.item'])
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'settings.plugin.item')
  assert.equal(registrations[0].options.key, 'dsh-subagent-model')
})

test('the plugin declares only what cordis loading needs', () => {
  const { ns } = loadCard(makeScope({}))
  assert.deepEqual(Object.keys(ns).sort(), ['apply', 'inject'])
  assert.deepEqual(ns.inject, ['slots', 'settingsScope'])
})

test('a seeded install reports inheriting, not forcing', () => {
  const card = loadCard(makeScope({ routes: ['inherit/current'], efforts: {} }))
  const { tree } = card.render(card.registrations[0].Component)
  assert.match(textOf(tree), /Inheriting/)
  assert.doesNotMatch(textOf(tree), /Forcing/)
})

test('removing the inherit route reports forcing', () => {
  const card = loadCard(makeScope({ routes: ['kiro/claude-opus-5'], efforts: {} }))
  const { tree } = card.render(card.registrations[0].Component)
  assert.match(textOf(tree), /Forcing/)
  assert.match(textOf(tree), /never inherits/)
})

test('an empty allowlist says delegation is disabled', () => {
  const card = loadCard(makeScope({ routes: [], efforts: {} }))
  const { tree } = card.render(card.registrations[0].Component)
  assert.match(textOf(tree), /delegation is disabled/)
})

test('a read-only settings document disables the controls and says so', () => {
  const card = loadCard(makeScope({ routes: ['inherit/current'], efforts: {} }, false))
  const { tree } = card.render(card.registrations[0].Component)
  assert.match(textOf(tree), /read-only/)
  const selects = flatten(tree).filter(one => one.type === 'select')
  assert.ok(selects.length > 0, 'rendered no controls')
  assert.ok(selects.every(one => one.props.disabled === true), 'a control stayed enabled')
})

test('nothing is written until Save, and Save writes both fields', async () => {
  const scope = makeScope({ routes: ['kiro/claude-opus-5'], efforts: { 'kiro/claude-opus-5': 'high' } })
  const card = loadCard(scope)
  const first = card.render(card.registrations[0].Component)
  // Rendering and reading alone must not touch the document.
  assert.deepEqual(scope.writes, [])

  // Stage a removal through the rendered Remove button.
  const remove = flatten(first.tree).find(one => one.type === 'button' && one.children.includes('Remove'))
  remove.props.onClick()

  // Re-render with the staged draft, then Save.
  const second = card.render(card.registrations[0].Component)
  const save = flatten(second.tree).find(one => one.type === 'button' && one.children.includes('Save'))
  await save.props.onClick()

  // efforts is written BEFORE routes, so a route is never allowed for one commit
  // without the effort the tool will read for it.
  assert.deepEqual(scope.writes.map(([field]) => field), ['efforts', 'routes'])
  assert.deepEqual(scope.writes[1][1], [], 'the route was not removed')
  assert.deepEqual(scope.writes[0][1], {}, 'a removed route kept its effort')
})

test('a provider-default effort is not persisted as a value', async () => {
  const scope = makeScope({ routes: ['kiro/claude-opus-5'], efforts: {} })
  const card = loadCard(scope)
  const first = card.render(card.registrations[0].Component)
  // Stage an explicit provider-default choice on the effort select.
  const select = flatten(first.tree).find(one => one.type === 'select' && one.props.value === 'provider/default')
  select.props.onChange({ target: { value: 'provider/default' } })
  const second = card.render(card.registrations[0].Component)
  const save = flatten(second.tree).find(one => one.type === 'button' && one.children.includes('Save'))
  await save.props.onClick()
  assert.deepEqual(scope.writes[0][1], {}, 'provider/default was stored as a value')
})

test('a configured effort the catalog no longer advertises stays visible', () => {
  const card = loadCard(makeScope({
    routes: ['deepseek/deepseek-chat'],
    efforts: { 'deepseek/deepseek-chat': 'ultra' },
  }))
  const { tree } = card.render(card.registrations[0].Component)
  assert.match(textOf(tree), /ultra \(not advertised\)/)
})

test('every theme token the card names is one the Theme provider publishes', () => {
  // The card draws its own chrome, so a token TYPO cannot fail loudly: CSS
  // falls through to the literal fallback beside it, and those fallbacks are
  // light-theme colors — a wrong name renders the whole card as near-black text
  // on a dark surface while the shipped cards around it look right. This pins
  // the names against the published `--dsw-alias-*` set.
  const published = new Set([
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-overlay',
    '--dsw-alias-border-l1',
    '--dsw-alias-border-l2',
    '--dsw-alias-brand-primary',
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-success-primary',
    '--dsw-alias-state-warn-primary',
    '--dsw-specific-sidebar-fill',
  ])
  const source = readFileSync(SOURCE, 'utf8')
  const named = [...source.matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1])
  assert.ok(named.length > 0, 'the card names no theme tokens at all')
  const invented = [...new Set(named)].filter(one => !published.has(one))
  assert.deepEqual(invented, [], `card names unpublished theme tokens: ${invented.join(', ')}`)
})

test('no control is left on a transparent background', () => {
  // A native <select> paints its own popup surface and a transparent control
  // shows the browser default (white) under a dark theme.
  const source = readFileSync(SOURCE, 'utf8')
  assert.equal(
    /background:\s*'transparent'/.test(source),
    false,
    'a control still sets background: transparent',
  )
})

test('a failed save keeps the staged values and says so', async () => {
  const scope = makeScope({ routes: ['kiro/claude-opus-5'], efforts: {} })
  scope.set = async () => { throw new Error('read-only') }
  const card = loadCard(scope)
  const first = card.render(card.registrations[0].Component)
  flatten(first.tree).find(one => one.type === 'button' && one.children.includes('Remove')).props.onClick()
  const second = card.render(card.registrations[0].Component)
  await flatten(second.tree).find(one => one.type === 'button' && one.children.includes('Save')).props.onClick()
  const third = card.render(card.registrations[0].Component)
  assert.match(textOf(third.tree), /Save failed/)
})
