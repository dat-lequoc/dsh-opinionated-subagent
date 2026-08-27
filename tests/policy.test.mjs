import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  EFFORT_PROVIDER_DEFAULT,
  INHERIT_ROUTE,
  parseRoute,
  reasoningInfo,
  resolveEffort,
  routeKey,
  routeLabel,
  selectRoute,
} from '../lib/policy.js'

const inherit = { inherit: true, modalities: [] }

const opus = {
  provider: 'kiro',
  id: 'claude-opus-5',
  modalities: ['text', 'image'],
  reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] },
}
const plain = { provider: 'deepseek', id: 'deepseek-chat', modalities: ['text'] }

test('a route splits on its first separator so a model id may contain slashes', () => {
  assert.deepEqual(parseRoute('kiro/claude-opus-5'), { provider: 'kiro', id: 'claude-opus-5' })
  assert.deepEqual(parseRoute('hf/org/model-name'), { provider: 'hf', id: 'org/model-name' })
})

test('an unusable route spelling is rejected rather than guessed', () => {
  for (const value of ['', 'bare-model', '/leading', 'trailing/', 42, undefined, null]) {
    assert.equal(parseRoute(value), undefined, `accepted ${String(value)}`)
  }
})

test('a route key round-trips through parse', () => {
  const parsed = parseRoute(routeKey(opus))
  assert.deepEqual(parsed, { provider: 'kiro', id: 'claude-opus-5' })
})

test('an omitted effort sends nothing and reports the provider default', () => {
  for (const configured of [undefined, '', EFFORT_PROVIDER_DEFAULT]) {
    const resolved = resolveEffort(configured, opus)
    assert.equal(resolved.label, EFFORT_PROVIDER_DEFAULT)
    assert.equal('reasoningEffort' in resolved, false, 'sent an effort for a default')
  }
})

test('an advertised effort is sent verbatim', () => {
  assert.deepEqual(resolveEffort('high', opus), { label: 'high', reasoningEffort: 'high' })
})

test('an effort the exact model does not advertise is refused, never clamped', () => {
  assert.throws(() => resolveEffort('medium', opus), /not supported by kiro\/claude-opus-5/)
  assert.throws(() => resolveEffort('medium', opus), /supported: low, high/)
})

test('a non-reasoning model refuses any fixed effort and names the escape', () => {
  assert.throws(() => resolveEffort('high', plain), /advertises no selectable efforts/)
  assert.throws(() => resolveEffort('high', plain), /provider\/default/)
})

test('selecting a route requires an exact allowlisted key', () => {
  const allowlist = [opus, plain]
  assert.equal(selectRoute('kiro/claude-opus-5', allowlist), opus)
  assert.equal(selectRoute('deepseek/deepseek-chat', allowlist), plain)
})

test('a bare model id is not accepted as a route', () => {
  assert.throws(() => selectRoute('claude-opus-5', [opus]), /not on the configured worker allowlist/)
})

test('an absent model argument is refused with a pointer to the setting', () => {
  for (const value of [undefined, '', null, 7]) {
    assert.throws(() => selectRoute(value, [opus]), /model is required/)
  }
})

test('an empty allowlist refuses every route and never falls back', () => {
  assert.throws(() => selectRoute('kiro/claude-opus-5', []), /no worker routes are configured/)
})

test('a route label states modalities and the effort actually sent', () => {
  assert.equal(
    routeLabel(opus, 'high'),
    'kiro/claude-opus-5  [text,image; supports effort low/high; effort sent: high]',
  )
  assert.equal(
    routeLabel(plain, EFFORT_PROVIDER_DEFAULT),
    'deepseek/deepseek-chat  [text; effort sent: provider/default]',
  )
})

test('the inherit route keys and labels as itself, not as a provider route', () => {
  assert.equal(routeKey(inherit), INHERIT_ROUTE)
  assert.equal(
    routeLabel(inherit, EFFORT_PROVIDER_DEFAULT),
    "inherit/current  [follows this turn's own model and effort, resolved at call time]",
  )
  assert.match(routeLabel(inherit, 'high'), /effort overridden to high/)
})

test('the inherit route is selectable only when the user allowed it', () => {
  assert.equal(selectRoute(INHERIT_ROUTE, [inherit, opus]), inherit)
  assert.throws(() => selectRoute(INHERIT_ROUTE, [opus]), /has not allowed a child to follow/)
})

test('an inherit effort defers validation to the concrete call-time model', () => {
  // The model behind an inherit route is unknown here, so validating against it
  // is impossible; the tool re-resolves once the turn's route is known.
  assert.deepEqual(resolveEffort('anything', inherit), { label: 'anything', reasoningEffort: 'anything' })
  assert.deepEqual(resolveEffort(undefined, inherit), { label: EFFORT_PROVIDER_DEFAULT })
})

test('reasoning metadata is detached from the adapter aggregate', () => {
  const adapter = { efforts: [{ id: 'low', name: 'Low' }, { id: '' }] }
  const detached = reasoningInfo(adapter)
  assert.deepEqual(detached, { efforts: [{ id: 'low' }] })
  adapter.efforts.push({ id: 'high' })
  assert.equal(detached.efforts.length, 1, 'aliased the adapter array')
})

test('absent reasoning metadata stays absent rather than becoming empty', () => {
  assert.equal(reasoningInfo(undefined), undefined)
  assert.equal(reasoningInfo({ efforts: 'not-a-list' }), undefined)
})
