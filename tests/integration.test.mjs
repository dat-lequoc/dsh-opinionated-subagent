/**
 * Real-composition test: the tool is mounted on an actual Cordis context with
 * the real `ToolRuntime`, `SystemPrompt`, and `SubagentRuntime`, and a capture
 * provider records the `SubagentStartRequest` the tool actually built.
 *
 * This is what proves the point of the plugin: the request carries the CHOSEN
 * route in `agentOptions`, so `resolveChildAgentOptions` cannot fall back to
 * the parent's model.
 *
 * Skips itself when the harness packages are not resolvable, so the pure suites
 * still run in a bare checkout.
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

/** Mount the plugin with a capture provider and return the recorded request. */
async function delegate(settings, args) {
  const { Context, ToolRuntime, SubagentRuntime, SystemPrompt, SessionId } = harness
  const spawn = await import('../lib/spawn.js')

  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SubagentRuntime)

  // The settings service the plugin reads through ctx.get.
  ctx.provide('subagentModelSettings', {
    current: () => settings,
    subscribe: () => () => {},
  })
  // A minimal catalog: the plugin resolves every configured route through it.
  ctx.provide('llm', {
    resolveModelInfo: async (provider, id) => {
      if (provider === 'nope') throw new Error('no such provider')
      return {
        provider,
        id,
        name: id,
        inputModalities: id.includes('opus') ? ['text', 'image'] : ['text'],
        ...id.includes('opus')
          ? { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }
          : {},
      }
    },
  })

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
    // one-shot keeps the assertion on the plain start() path, which is the
    // path a capture provider can observe.
    backgroundMode: 'one-shot',
    // The capture provider declares no depthLimit capability, exactly like a
    // provider that owns its own recursion budget.
    maxDepth: 'provider-managed',
  })

  const schema = ctx.tools.schemas().find(one => one.name === 'subagent')
  const result = args === undefined ? undefined : await ctx.tools.execute({
    callId: 'call-1',
    name: 'subagent',
    arguments: args,
    agent: {
      id: SessionId('parent-1'),
      session: {
        id: SessionId('parent-1'),
        header: {},
        // The route captured for this turn, which inherit/current follows.
        requestHeader: () => ({
          config: { provider: 'kiro', model: 'claude-opus-5', reasoningEffort: 'high' },
        }),
      },
    },
    signal: new AbortController().signal,
  })
  return { ctx, schema, seen, result }
}

test('the chosen route reaches the start request, defeating parent inheritance', options, async () => {
  const { seen, result } = await delegate(
    { routes: ['kiro/claude-opus-5'], efforts: {} },
    { description: 'd', prompt: 'p', model: 'kiro/claude-opus-5' },
  )
  assert.notEqual(result.isError, true, JSON.stringify(result))
  assert.deepEqual(seen.agentOptions, { provider: 'kiro', model: 'claude-opus-5' })
})

test('the tool schema enumerates exactly the configured routes', options, async () => {
  const { schema } = await delegate(
    { routes: ['kiro/claude-opus-5', 'deepseek/deepseek-chat'], efforts: {} },
  )
  const model = schema.parameters.properties.model
  assert.deepEqual(model.enum, ['kiro/claude-opus-5', 'deepseek/deepseek-chat'])
  assert.ok(schema.parameters.required.includes('model'), 'model is not required')
})

test('no configured route means no tool at all, never a parent-model fallback', options, async () => {
  const { schema } = await delegate({ routes: [], efforts: {} })
  assert.equal(schema, undefined, 'the tool registered with an empty allowlist')
})

test('an unresolvable route is skipped without disabling the rest', options, async () => {
  const { schema } = await delegate(
    { routes: ['nope/ghost-model', 'deepseek/deepseek-chat'], efforts: {} },
  )
  assert.deepEqual(schema.parameters.properties.model.enum, ['deepseek/deepseek-chat'])
})

test('a route outside the allowlist is refused at execution', options, async () => {
  const { result } = await delegate(
    { routes: ['deepseek/deepseek-chat'], efforts: {} },
    { description: 'd', prompt: 'p', model: 'kiro/claude-opus-5' },
  )
  assert.equal(result.isError, true)
})

test('an effort the model does not advertise is refused before any provider call', options, async () => {
  const { seen, result } = await delegate(
    { routes: ['deepseek/deepseek-chat'], efforts: { 'deepseek/deepseek-chat': 'high' } },
    { description: 'd', prompt: 'p', model: 'deepseek/deepseek-chat' },
  )
  assert.equal(result.isError, true)
  assert.equal(seen, undefined, 'the provider was called despite an invalid effort')
})

test('the seeded inherit route reproduces the shipped no-plugin behavior', options, async () => {
  // Installing this plugin must change nothing until the user edits settings:
  // the default allowlist is inherit/current alone, so a child follows the
  // conversation's own model and effort exactly as the shipped tool does.
  const { seen, result } = await delegate(
    { routes: ['inherit/current'], efforts: {} },
    { description: 'd', prompt: 'p', model: 'inherit/current' },
  )
  assert.notEqual(result.isError, true, JSON.stringify(result))
  // The turn's own route, resolved at call time — not a creation-time default.
  assert.deepEqual(seen.agentOptions, { provider: 'kiro', model: 'claude-opus-5' })
  const rendered = result.content.map(block => block.text ?? '').join('')
  assert.match(rendered, /effort=high \(inherited\)/)
})

test('an inherit route the user removed cannot be named', options, async () => {
  const { seen, result } = await delegate(
    { routes: ['deepseek/deepseek-chat'], efforts: {} },
    { description: 'd', prompt: 'p', model: 'inherit/current' },
  )
  assert.equal(result.isError, true)
  assert.equal(seen, undefined, 'a removed inherit route still started a child')
})

test('a configured effort overrides the inherited one on an inherit route', options, async () => {
  const { result } = await delegate(
    { routes: ['inherit/current'], efforts: { 'inherit/current': 'low' } },
    { description: 'd', prompt: 'p', model: 'inherit/current' },
  )
  const rendered = result.content.map(block => block.text ?? '').join('')
  assert.match(rendered, /effort=low/)
})

test('the forced route and effort are reported back to the model', options, async () => {
  const { result } = await delegate(
    { routes: ['kiro/claude-opus-5'], efforts: { 'kiro/claude-opus-5': 'high' } },
    { description: 'd', prompt: 'p', model: 'kiro/claude-opus-5' },
  )
  const rendered = result.content.map(block => block.text ?? '').join('')
  assert.match(rendered, /kiro\/claude-opus-5/)
  assert.match(rendered, /effort=high/)
})
