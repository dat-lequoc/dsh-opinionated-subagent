/**
 * The install must be behavior-neutral: the settings namespace seeds
 * `inherit/current` alone, so a fresh install delegates on the conversation's
 * own model exactly as the shipped tool does, and forcing is opt-in.
 *
 * Skips when the harness packages are not resolvable.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

let host
try {
  host = await import('../lib/index.js')
} catch {
  host = undefined
}

const options = host === undefined
  ? { skip: 'harness packages are not resolvable from this checkout' }
  : {}

test('a fresh install seeds the inherit route and no forced route', options, async () => {
  const { INHERIT_ROUTE } = await import('../lib/policy.js')
  // Mount on a bare context: no settings service, so the composition entry is
  // the authoritative value a fresh install runs on.
  const { Context } = await import('@deepseek-ai/cordis')
  const ctx = new Context()
  await ctx.plugin(host)
  const current = ctx.get('subagentModelSettings').current()
  assert.deepEqual(current.routes, [INHERIT_ROUTE])
  assert.deepEqual(current.efforts, {})
})

test('the namespace is the documented one', options, () => {
  assert.equal(host.SETTINGS_NS, 'dsh-subagent-model')
})
