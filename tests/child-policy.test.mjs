import assert from 'node:assert/strict'
import { test } from 'node:test'

let runtime
try {
  const [cordis, tools, prompt, scope, subagent, spawn] = await Promise.all([
    import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-tools'),
    import('@deepseek-ai/dsh-system-prompt'), import('@deepseek-ai/dsh-scope'),
    import('@deepseek-ai/dsh-subagent'), import('../lib/spawn.js'),
  ])
  runtime = { cordis, tools, prompt, scope, subagent, spawn }
} catch (error) {
  if (process.env.DSH_REQUIRE_RUNTIME === '1' || error.code !== 'ERR_MODULE_NOT_FOUND') throw error
}
const options = runtime ? {} : { skip: 'harness packages are not resolvable' }

test('saved child composition blocks spawn and fork execution without restricting parent', options, async () => {
  const { cordis, tools, prompt, scope, subagent, spawn } = runtime
  const ctx = new cordis.Context()
  await ctx.plugin(prompt.default)
  await ctx.plugin(tools.default)
  let calls = 0
  const parent = { id: 'parent', ctx }
  for (const name of ['subagent', 'subagent_fork', 'read', 'send_message']) {
    ctx.tools.register(tools.defineTool({
      name, description: name, parameters: {},
      output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
      execute: async () => { calls++; return 'ok' },
    }))
  }
  // Exercise the actual plugin schema: an omitted allow must not become [].
  const config = spawn.Config({ toolFilter: { deny: ['subagent', 'subagent_fork'] } })
  const descriptor = subagent.snapshotSubagentDescriptor({
    mode: 'continuable', provider: 'spawn', label: 'child',
    agentProvider: 'worker', agentModel: 'model', agentReasoningEffort: 'low',
    toolFilter: config.toolFilter,
  })
  config.toolFilter.deny.length = 0
  const saved = JSON.parse(JSON.stringify(descriptor))
  assert.deepEqual(saved.toolFilter, { deny: ['subagent', 'subagent_fork'] })
  assert.equal(saved.agentReasoningEffort, 'low')
  // This is the same composition primitive DSH uses at creation and cold resume,
  // not a full persistence/activation end-to-end test.
  for (const id of ['created', 'reconstructed']) {
    const child = { id }
    let childScope
    await ctx.plugin(Object.assign(inner => { childScope = scope.createScope(inner, child) },
      { inject: ['tools', 'systemPrompt'] }))
    subagent.applyChildComposition(childScope.ctx, parent, saved)
    assert.deepEqual(ctx.tools.schemas(child).map(t => t.name).sort(), ['read', 'send_message'])
    for (const name of ['subagent', 'subagent_fork']) {
      const result = await ctx.tools.execute({ name, arguments: {}, agent: child,
        callId: id + name, signal: new AbortController().signal })
      assert.equal(result.isError, true)
      assert.match(result.content[0].text, /unknown tool/)
    }
    await childScope.dispose()
  }
  assert.equal(calls, 0)
  assert.equal(ctx.tools.schemas(parent).length, 4)
})

test('provider default explicitly clears same-route inherited effort', options, () => {
  const parent = {
    options: { provider: 'p', model: 'm', reasoningEffort: 'high' },
    session: { requestHeader: () => undefined },
  }
  const resolved = runtime.subagent.resolveChildAgentOptions(parent,
    { provider: 'p', model: 'm', reasoningEffort: undefined }, 1)
  assert.equal(resolved.reasoningEffort, undefined)
})

test('invalid caps and empty filters fail before mounting', options, async () => {
  for (const maxDepth of [-1, -0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(runtime.spawn.apply({}, { maxDepth }), /non-negative safe integer/)
  }
  await assert.rejects(runtime.spawn.apply({}, { toolFilter: {} }), /allow or deny/)
})
