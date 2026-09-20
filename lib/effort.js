/**
 * Child reasoning-effort bridge.
 *
 * Current `SubagentStartRequest.agentOptions` carries provider, model and
 * reasoning effort durably. This bridge additionally pins the live child's
 * prompt assembly and `agent/request` waterfall using the shipped primitive
 * `installModelSelection(agentCtx, ref)` — the same one the Web model picker
 * uses, which also keeps prompt `{{model}}` interpolation and the logged
 * `request/header` agreeing with what is sent.
 *
 * This module reserves a selection per pending child (lib/reservations.js owns
 * the matching rules), then installs that selection on the exact child at its
 * `agent/created` edge. That edge is a synchronous publication boundary, so the
 * listener runs before the child can assemble a prompt or issue a request.
 *
 * ROOT listeners are required: an ordinary agent-scoped listener receives events
 * for its own agent only, and the targets here are children published on their
 * own scopes. Both listeners fail closed on an unrecognized child and unregister
 * with this plugin's fiber.
 */

import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { EFFORT_PROVIDER_DEFAULT, INHERIT_ROUTE, parseRoute, reasoningInfo, resolveEffort } from './policy.js'
import { createReservations } from './reservations.js'

/**
 * Make Agent Teams continuable starts use the first configured concrete route.
 * The stock Team tool only supplies a subagent provider, so without this bridge
 * the continuation manager resolves agentOptions entirely from the parent.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function installTeamModelBridge(ctx) {
  if (ctx.root?._teamModelBridgeInstalled) return
  const subagents = ctx.get('subagents')
  const llm = ctx.get('llm')
  if (!subagents || !llm || typeof subagents.startContinuable !== 'function') return
  if (ctx.root) ctx.root._teamModelBridgeInstalled = true

  const original = subagents.startContinuable
  const settings = () => ctx.get('subagentModelSettings')?.current?.() ?? {}
  const forcedSelection = async () => {
    const current = settings()
    const routes = Array.isArray(current.routes) ? current.routes : []
    const route = routes.find(value => value !== INHERIT_ROUTE)
    if (route === undefined) {
      if (routes.length === 0) {
        throw new Error('dsh-subagent-model: Agent Teams delegation is disabled because no route is configured')
      }
      return undefined
    }
    const parsed = parseRoute(route)
    if (parsed === undefined) throw new Error('dsh-subagent-model: team route "' + route + '" is not provider/model-id')
    const info = await llm.resolveModelInfo(parsed.provider, parsed.id)
    const reasoning = reasoningInfo(info.reasoning)
    const entry = {
      provider: parsed.provider,
      id: parsed.id,
      modalities: [...info.inputModalities ?? ['text']],
      ...reasoning === undefined ? {} : { reasoning },
    }
    const configured = current.efforts !== null && typeof current.efforts === 'object'
      ? current.efforts[route]
      : undefined
    const effort = resolveEffort(configured ?? EFFORT_PROVIDER_DEFAULT, entry)
    return {
      provider: parsed.provider,
      model: parsed.id,
      // Explicit undefined clears an inherited effort when provider/default is selected.
      reasoningEffort: effort.reasoningEffort,
    }
  }

  const wrapped = async function (spec) {
    if (spec?.request?.agentOptions !== undefined) return await original.call(this, spec)
    const selection = await forcedSelection()
    if (selection === undefined) return await original.call(this, spec)
    return await original.call(this, {
      ...spec,
      request: { ...spec.request, agentOptions: selection },
    })
  }
  subagents.startContinuable = wrapped
  ctx.effect(() => () => {
    if (subagents.startContinuable === wrapped) subagents.startContinuable = original
    if (ctx.root?._teamModelBridgeInstalled) delete ctx.root._teamModelBridgeInstalled
  })
}

export function installChildEffortBridge(ctx) {
  installTeamModelBridge(ctx)
  const reservations = createReservations()

  ctx.effect(() => ctx.root.on('agent/created', ({ agent }) => {
    const selection = reservations.claim(agent.id, agent.session.header.parentSession)
    if (selection === undefined) return
    // Installing on the CHILD's own context scopes both waterfall listeners to
    // that child and disposes them with it.
    installModelSelection(agent.ctx, { current: selection, assembled: undefined })
  }))

  // Once the child's own request/header is durable it is the authority, and a
  // warm step or cold resume needs nothing from here.
  ctx.effect(() => ctx.root.on('session/event', (session, event) => {
    if (event.type === 'request/header') reservations.release(session.id)
  }))

  return reservations
}
