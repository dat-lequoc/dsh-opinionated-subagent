import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { installSmartWait, patchWaitAgentSchema, hasActivePeers } from '../lib/wait.js'

test('patchWaitAgentSchema updates timeout_ms parameter description', () => {
  const tool = {
    parameters: {
      properties: {
        timeout_ms: { type: 'integer', description: 'Defaults to 30000.' }
      }
    }
  }
  patchWaitAgentSchema(tool)
  assert.match(tool.parameters.properties.timeout_ms.description, /Defaults to 300000/)
})

test('installSmartWait prevents premature timeout loops when peers are active', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)

  let active = true
  let executeCount = 0

  // Mock agentTeams service
  ctx.provide('agentTeams', {
    listMembers: () => active ? [{ id: 'teammate-1', status: 'running' }] : [{ id: 'teammate-1', status: 'idle' }]
  })

  // Register dummy wait_agent
  ctx.tools.register(defineTool({
    name: 'wait_agent',
    parameters: { timeout_ms: { type: 'integer' } },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, val) => [{ type: 'text', text: JSON.stringify(val) }]
    },
    async execute() {
      executeCount++
      if (executeCount >= 3) active = false
      return { timedOut: active }
    }
  }))

  installSmartWait(ctx)

  const caller = { id: 'lead' }
  const result = await ctx.tools.execute({
    callId: 'c1',
    name: 'wait_agent',
    arguments: { timeout_ms: 15000 },
    agent: caller,
    signal: new AbortController().signal,
  })

  // The caller gets a single resolved result after peers settle, not 3 separate wakeups
  assert.equal(executeCount, 3)
  assert.equal(result.value.timedOut, false)
})

test('installSmartWait returns immediately on real event or no active peers', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)

  ctx.provide('agentTeams', {
    listMembers: () => [{ id: 'teammate-1', status: 'idle' }]
  })

  let executeCount = 0
  ctx.tools.register(defineTool({
    name: 'wait_agent',
    parameters: { timeout_ms: { type: 'integer' } },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, val) => [{ type: 'text', text: JSON.stringify(val) }]
    },
    async execute() {
      executeCount++
      return { timedOut: false, change: 'task_completed' }
    }
  }))

  installSmartWait(ctx)

  const result = await ctx.tools.execute({
    callId: 'c2',
    name: 'wait_agent',
    arguments: { timeout_ms: 15000 },
    agent: { id: 'lead' },
    signal: new AbortController().signal,
  })

  assert.equal(executeCount, 1)
  assert.equal(result.value.change, 'task_completed')
})

test('installSmartWait injects affirmative prompt guidance only when wait_agent is present', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)

  installSmartWait(ctx)

  // Before wait_agent is registered: text is empty
  let assembled = await ctx.systemPrompt.assemble({})
  let waitContext = assembled.contexts.find(c => c.name === 'opinionated:team-wait')
  assert.equal(typeof waitContext?.text === 'function' ? waitContext.text() : waitContext?.text ?? '', '')

  // Register wait_agent
  ctx.tools.register(defineTool({
    name: 'wait_agent',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
    execute: async () => ({})
  }))

  assembled = await ctx.systemPrompt.assemble({})
  waitContext = assembled.contexts.find(c => c.name === 'opinionated:team-wait')
  const renderedText = typeof waitContext?.text === 'function' ? waitContext.text() : waitContext?.text ?? ''
  assert.match(renderedText, /timeout_ms: 300000 \(5 minutes\)/)
  assert.match(renderedText, /wait_agent is event-driven/)
  assert.doesNotMatch(renderedText, /Do not/)
})
