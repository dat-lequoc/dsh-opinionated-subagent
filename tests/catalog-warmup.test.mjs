/**
 * The cold-cache regression.
 *
 * An adapter may discover capabilities live and answer `resolveModel` from a
 * cache that only `listModels` fills. `dsh-kiro` does exactly this: its
 * `currentModels` hook is a cache READ, so before any `listModels` call it
 * returns undefined and `resolveModel` falls back to a legacy effort list that
 * omits the discovered efforts. A consumer that resolves a route without
 * listing first therefore validates against stale capabilities and refuses an
 * effort the provider genuinely accepts.
 *
 * These tests use a stub with that exact behavior, so a regression fails here
 * rather than only against a live account.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

let harness
try {
  const [cordis, tools, subagent, prompt, session] = await Promise.all([
    import('@deepseek-ai/cordis'),
    import('@deepseek-ai/dsh-tools'),
    import('@deepseek-ai/dsh-subagent'),
    import('@deepseek-ai/dsh-system-prompt'),
    import('@deepseek-ai/dsh-session'),
  ])
  harness = {
    Context: cordis.Context,
    ToolRuntime: tools.default,
    SubagentRuntime: subagent.default,
    SystemPrompt: prompt.default,
    SessionId: session.SessionId,
  }
} catch {
  harness = undefined
}

const options = harness === undefined
  ? { skip: 'harness packages are not resolvable from this checkout' }
  : {}

/** Efforts the model really supports, discovered live. */
const DISCOVERED = ['low', 'medium', 'high', 'xhigh', 'max']
/** What the adapter falls back to with a cold cache. */
const LEGACY = ['off', 'low', 'medium', 'high']

/** An llm stub reproducing a discovery-cached adapter, recording every call. */
function cachedLlm() {
  const calls = []
  let warm = false
  return {
    calls,
    listProviders() {
      calls.push('listProviders')
      return [{ id: 'kiro', name: 'Kiro' }]
    },
    async listModels(provider) {
      calls.push('listModels:' + provider)
      // Listing is what fills the adapter's discovery cache.
      warm = true
      return [{ provider: 'kiro', id: 'claude-sonnet-5', name: 'Claude Sonnet 5', inputModalities: ['text', 'image'] }]
    },
    async resolveModelInfo(provider, id) {
      calls.push('resolveModelInfo:' + provider + '/' + id)
      const efforts = warm ? DISCOVERED : LEGACY
      return {
        provider,
        id,
        name: id,
        inputModalities: ['text', 'image'],
        reasoning: { efforts: efforts.map(one => ({ id: one, name: one })) },
      }
    },
  }
}
/** Mount the tool over the cached-adapter stub and optionally call it. */
async function delegate(settings, args) {
  const { Context, ToolRuntime, SubagentRuntime, SystemPrompt, SessionId } = harness
  const spawn = await import('../lib/spawn.js')

  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SubagentRuntime)
  ctx.provide('subagentModelSettings', { current: () => settings, subscribe: () => () => {} })
  const llm = cachedLlm()
  ctx.provide('llm', llm)

  let seen
  ctx.subagents.registerProvider({
    name: 'capture',
    capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: true },
    inheritsParentContext: false,
    start: async (request) => {
      seen = request
      return {
        id: SessionId('capture-child'),
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  })
  await ctx.plugin(spawn, {
    provider: 'capture',
    toolName: 'subagent',
    backgroundMode: 'one-shot',
    maxDepth: 'provider-managed',
  })

  const result = args === undefined ? undefined : await ctx.tools.execute({
    callId: 'call-1',
    name: 'subagent',
    arguments: args,
    agent: {
      id: SessionId('parent-1'),
      session: {
        id: SessionId('parent-1'),
        header: {},
        requestHeader: () => ({ config: { provider: 'kiro', model: 'claude-sonnet-5', reasoningEffort: 'high' } }),
      },
    },
    signal: new AbortController().signal,
  })
  return { llm, seen, result }
}

test('a live-discovered effort is accepted, not refused as unadvertised', options, async () => {
  // The bug: resolving without listing first saw the legacy list and refused
  // `xhigh`, an effort the provider genuinely accepts.
  const { seen, result } = await delegate(
    { routes: ['kiro/claude-sonnet-5'], efforts: { 'kiro/claude-sonnet-5': 'xhigh' } },
    { description: 'd', prompt: 'p', model: 'kiro/claude-sonnet-5' },
  )
  assert.notEqual(result.isError, true, JSON.stringify(result))
  assert.ok(seen !== undefined, 'the child never started')
  const rendered = result.content.map(block => block.text ?? '').join('')
  assert.match(rendered, /effort=xhigh/)
})

test('the catalog is warmed before a route is resolved', options, async () => {
  const { llm } = await delegate({ routes: ['kiro/claude-sonnet-5'], efforts: {} })
  const firstResolve = llm.calls.findIndex(one => one.startsWith('resolveModelInfo:'))
  const firstList = llm.calls.findIndex(one => one.startsWith('listModels:'))
  assert.notEqual(firstResolve, -1, 'no route was resolved at all')
  assert.notEqual(firstList, -1, 'listModels was never called, so a cached adapter stays cold')
  assert.ok(firstList < firstResolve, 'listModels must precede resolveModelInfo; got ' + llm.calls.join(', '))
})

test('a genuinely unsupported effort is still refused', options, async () => {
  // Warming must not turn the validation off: it exists to catch a real typo
  // before any provider call.
  const { seen, result } = await delegate(
    { routes: ['kiro/claude-sonnet-5'], efforts: { 'kiro/claude-sonnet-5': 'ultra' } },
    { description: 'd', prompt: 'p', model: 'kiro/claude-sonnet-5' },
  )
  assert.equal(result.isError, true)
  assert.equal(seen, undefined, 'a child started on an unsupported effort')
  const text = result.content.map(block => block.text ?? '').join('')
  // The message must list what the model really supports, not the legacy set.
  assert.match(text, /xhigh/)
})

test('only providers named by the allowlist are listed', options, async () => {
  // Warming is not a licence to enumerate every provider on the machine: an
  // unrelated adapter must not be woken by a delegation.
  const { llm } = await delegate({ routes: ['kiro/claude-sonnet-5'], efforts: {} })
  const listed = llm.calls.filter(one => one.startsWith('listModels:'))
  assert.deepEqual([...new Set(listed)], ['listModels:kiro'])
})
