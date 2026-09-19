/**
 * Smart wait_agent interceptor to eliminate busy-polling loops in Agent Teams.
 *
 * When an agent team Lead calls `wait_agent`, models frequently anchor on short
 * timeouts (15s - 30s) due to default schema descriptions. When this expires without
 * an event, the Lead executes a full model re-list turn (team_task_list + list_agents)
 * and immediately calls wait_agent again, repeating dozens of times.
 *
 * This module:
 * 1. Patches the `wait_agent` tool description and parameter schema so models know
 *    the default is 5 minutes and that short polling is unnecessary (wait_agent is
 *    event-driven and wakes immediately upon teammate activity).
 * 2. Intercepts `wait_agent` in `tools/execute`: if a short timeout expires with
 *    `timedOut: true` while teammates are still actively running, it continues waiting
 *    internally up to a 5-minute cap instead of waking the Lead with a spurious timeout.
 */

const ACTIVE_STATUSES = new Set(['running', 'provisioning'])
export const DEFAULT_WAIT_CAP_MS = 300_000 // 5 minutes

/**
 * Patch wait_agent parameter description to discourage short-interval polling.
 * @param {import('@deepseek-ai/dsh-tools').ToolDefinition} tool
 */
export function patchWaitAgentSchema(tool) {
  if (!tool || tool._opinionatedWaitPatched) return
  tool._opinionatedWaitPatched = true
  if (tool.parameters?.properties?.timeout_ms) {
    tool.parameters.properties.timeout_ms.description =
      'Wait duration in milliseconds. Defaults to 300000 (5 minutes). wait_agent is event-driven and returns immediately whenever a teammate completes a task, sends a message, or changes status.'
  }
}

/**
 * Check if the team has other active members running or provisioning.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('@deepseek-ai/dsh-agent').Agent} caller
 * @returns {boolean}
 */
export function hasActivePeers(ctx, caller) {
  try {
    const agentTeams = ctx.get('agentTeams')
    if (!agentTeams || !caller) return false
    const members = agentTeams.listMembers(caller) ?? []
    return members.some(m => m.id !== caller.id && ACTIVE_STATUSES.has(m.status))
  } catch {
    return false
  }
}

/**
 * Install the smart wait_agent interceptor on a Cordis context.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function installSmartWait(ctx) {
  if (ctx.root?._smartWaitInstalled) return
  if (ctx.root) ctx.root._smartWaitInstalled = true

  // Update schema when tools change
  ctx.effect(() => {
    const updateSchema = () => {
      const tool = ctx.get('tools')?.get('wait_agent')
      if (tool) patchWaitAgentSchema(tool)
    }
    updateSchema()
    return ctx.on('tools/change', updateSchema)
  })

  // Intercept wait_agent execution
  ctx.effect(() => ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'wait_agent') return await next()

    const caller = exec.agent
    const requestedTimeout = typeof exec.arguments?.timeout_ms === 'number' ? exec.arguments.timeout_ms : 30_000
    const waitCapMs = Math.max(requestedTimeout, DEFAULT_WAIT_CAP_MS)
    const startTime = Date.now()

    let res = await next()

    // Loop internally if it timed out but peers are still actively running
    while (
      res.value?.timedOut === true
      && !exec.signal?.aborted
      && (Date.now() - startTime) < waitCapMs
      && hasActivePeers(ctx, caller)
    ) {
      res = await next()
    }

    return res
  }))
}
