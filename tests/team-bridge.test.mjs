import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { installTeamModelBridge } from '../lib/effort.js'

function harness(settings) {
  let seen
  const subagents = {
    async startContinuable(spec) {
      seen = spec
      return { childId: 'child' }
    },
  }
  const ctx = {
    root: {},
    get(name) {
      if (name === 'subagents') return subagents
      if (name === 'llm') return {
        resolveModelInfo: async () => ({
          inputModalities: ['text'],
          reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] },
        }),
      }
      if (name === 'subagentModelSettings') return { current: () => settings }
      return undefined
    },
    effect(register) { return register() },
  }
  installTeamModelBridge(ctx)
  return { ctx, subagents, get seen() { return seen } }
}

test('team continuable starts receive the configured route and effort', async () => {
  const h = harness({
    routes: ['antigravity/gemini-3.8-flash-tiered'],
    efforts: { 'antigravity/gemini-3.8-flash-tiered': 'high' },
  })
  await h.subagents.startContinuable({
    provider: 'spawn',
    request: { parent: { id: 'lead' } },
  })
  assert.deepEqual(h.seen.request.agentOptions, {
    provider: 'antigravity',
    model: 'gemini-3.8-flash-tiered',
    reasoningEffort: 'high',
  })
})

test('an explicit child agentOptions is preserved', async () => {
  const h = harness({ routes: ['antigravity/gemini-3.8-flash-tiered'], efforts: {} })
  const agentOptions = { provider: 'custom', model: 'chosen' }
  await h.subagents.startContinuable({ provider: 'spawn', request: { parent: {}, agentOptions } })
  assert.deepEqual(h.seen.request.agentOptions, agentOptions)
})

test('inherit-only settings preserve native team behavior', async () => {
  const h = harness({ routes: ['inherit/current'], efforts: {} })
  await h.subagents.startContinuable({ provider: 'spawn', request: { parent: {} } })
  assert.equal(Object.hasOwn(h.seen.request, 'agentOptions'), false)
})

test('an empty route list disables team delegation instead of inheriting', async () => {
  const h = harness({ routes: [], efforts: {} })
  await assert.rejects(
    h.subagents.startContinuable({ provider: 'spawn', request: { parent: {} } }),
    /delegation is disabled/,
  )
})
