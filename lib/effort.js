/**
 * Child reasoning-effort bridge.
 *
 * `SubagentStartRequest.agentOptions` carries a child's provider and model, so
 * the route itself is durable and needs no bridge. It does NOT carry a
 * reasoning effort: an effort reaches a request only through the
 * `agent/request` waterfall, and the harness ships exactly that primitive as
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
import { createReservations } from './reservations.js'

/**
 * Install the bridge on one plugin fiber.
 * @param ctx - the plugin context owning the listeners.
 * @returns the reservation handle the tool's start path uses.
 */
export function installChildEffortBridge(ctx) {
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
