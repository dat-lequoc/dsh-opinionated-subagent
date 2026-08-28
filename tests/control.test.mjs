/**
 * send_message delivery routing.
 *
 * The fact under test: a RUNNING direct child is steered (target next-step,
 * consumed at the next step boundary), while every other case goes through the
 * native followup unchanged. A real session stalled 47.5s because the shipped
 * tool routes every delivery to next-turn.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

let harness
try {
  const [cordis, tools, session, prompt] = await Promise.all([
    import('@deepseek-ai/cordis'),
    import('@deepseek-ai/dsh-tools'),
    import('@deepseek-ai/dsh-session'),
    import('@deepseek-ai/dsh-system-prompt'),
  ])
  harness = {
    Context: cordis.Context,
    ToolRuntime: tools.default,
    SystemPrompt: prompt.default,
    SessionId: session.SessionId,
  }
} catch {
  harness = undefined
}

const options = harness === undefined
  ? { skip: 'harness packages are not resolvable from this checkout' }
  : {}

/** A child the registry reports, recording steer calls into `sink`. */
function makeChild(status, sink, opts = {}) {
  const { SessionId } = harness
  const child = {
    id: SessionId('child-1'),
    status,
    session: { header: { parentSession: opts.parentSession ?? SessionId('parent-1') } },
    steer: (message) => {
      sink.push(message)
      if (opts.onSteer !== undefined) opts.onSteer(child)
    },
  }
  return child
}

/**
 * Mount the control tool over stub registries and call send_message.
 * @param child - the child agent the registry reports, or undefined.
 * @param opts - parentLive false breaks the exact-live-parent check.
 */
async function send(child, opts = {}) {
  const { Context, ToolRuntime, SystemPrompt, SessionId } = harness
  const control = await import('../lib/control.js')
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)

  const parent = { id: SessionId('parent-1') }
  const followups = []
  const registry = new Map()
  if (child !== undefined) registry.set(child.id, child)
  if (opts.parentLive !== false) registry.set(parent.id, parent)

  ctx.provide('agents', { get: id => registry.get(id) })
  ctx.provide('subagents', {
    followup: async (caller, childId, content) => {
      followups.push({ caller: caller.id, childId, content })
      return 'native-message-id'
    },
  })
  await ctx.plugin(control)

  const result = await ctx.tools.execute({
    callId: 'call-1',
    name: 'send_message',
    arguments: { subagent_id: 'child-1', message: 'stop and report' },
    agent: parent,
    signal: new AbortController().signal,
  })
  return { result, followups, registry, parent }
}
test('a running direct child is steered into its current turn', options, async () => {
  const sink = []
  const { result, followups } = await send(makeChild('running', sink))
  assert.notEqual(result.isError, true, JSON.stringify(result))
  assert.equal(result.value.delivery, 'next-step')
  assert.equal(sink.length, 1, 'the child was not steered')
  assert.deepEqual(followups, [], 'a steered delivery also went through followup')
  assert.match(result.content.map(one => one.text ?? '').join(''), /next step/)
})

test('the steered message carries the caller as its relay source', options, async () => {
  const sink = []
  await send(makeChild('running', sink))
  assert.equal(sink[0].source.kind, 'coordinator')
  assert.equal(sink[0].source.form, 'relay')
  assert.equal(sink[0].source.senderSessionId, 'parent-1')
  assert.equal(sink[0].content[0].text, 'stop and report')
})

test('an idle child goes through the native followup', options, async () => {
  const sink = []
  const { result, followups } = await send(makeChild('idle', sink))
  assert.equal(sink.length, 0, 'an idle child was steered instead of woken')
  assert.equal(followups.length, 1)
  assert.equal(result.value.delivery, 'next-turn')
  assert.equal(result.value.messageId, 'native-message-id')
})

test('an absent child goes through the native cold resume', options, async () => {
  const { result, followups } = await send(undefined)
  assert.equal(followups.length, 1)
  assert.equal(result.value.delivery, 'next-turn')
})

test('a child of a different parent is never steered', options, async () => {
  const { SessionId } = harness
  const sink = []
  const child = makeChild('running', sink, { parentSession: SessionId('someone-else') })
  const { result, followups } = await send(child)
  assert.equal(sink.length, 0, 'steered a child this caller does not own')
  assert.equal(followups.length, 1, 'authority was not left to the native service')
  assert.equal(result.value.delivery, 'next-turn')
})

test('a caller that is not the exact live parent is never steered', options, async () => {
  const sink = []
  const { result, followups } = await send(makeChild('running', sink), { parentLive: false })
  assert.equal(sink.length, 0)
  assert.equal(followups.length, 1)
  assert.equal(result.value.delivery, 'next-turn')
})

test('a steer that races settlement falls back instead of being lost', options, async () => {
  // Disposal clears the inbox, so a child that left the registry in the same
  // tick never sees the steered message.
  const sink = []
  let registry
  const child = makeChild('running', sink, { onSteer: one => { registry.delete(one.id) } })
  const { Context, ToolRuntime, SystemPrompt, SessionId } = harness
  const control = await import('../lib/control.js')
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const parent = { id: SessionId('parent-1') }
  const followups = []
  registry = new Map([[child.id, child], [parent.id, parent]])
  ctx.provide('agents', { get: id => registry.get(id) })
  ctx.provide('subagents', { followup: async () => { followups.push(1); return 'native-message-id' } })
  await ctx.plugin(control)
  const result = await ctx.tools.execute({
    callId: 'call-1',
    name: 'send_message',
    arguments: { subagent_id: 'child-1', message: 'stop' },
    agent: parent,
    signal: new AbortController().signal,
  })
  assert.equal(sink.length, 1, 'the steer never ran')
  assert.equal(followups.length, 1, 'the lost steer was not re-delivered')
  assert.equal(result.value.delivery, 'next-turn')
})

test('a missing calling agent fails loud', options, async () => {
  const { Context, ToolRuntime, SystemPrompt } = harness
  const control = await import('../lib/control.js')
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('agents', { get: () => undefined })
  ctx.provide('subagents', { followup: async () => 'x' })
  await ctx.plugin(control)
  const result = await ctx.tools.execute({
    callId: 'call-1',
    name: 'send_message',
    arguments: { subagent_id: 'child-1', message: 'm' },
    agent: undefined,
    signal: new AbortController().signal,
  })
  assert.equal(result.isError, true)
  assert.match(result.content.map(one => one.text ?? '').join(''), /requires a calling agent/)
})
