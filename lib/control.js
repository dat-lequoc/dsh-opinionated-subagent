/**
 * dsh-subagent-model — a `send_message` that reaches a RUNNING child at its
 * next step instead of its next turn.
 *
 * The shipped `send_message` routes every delivery through
 * `ctx.subagents.followup()`, which calls `Agent.followup()` and therefore
 * targets `next-turn`. For a child that is mid-turn — running tools, one per
 * step — that message is accepted and then sits in the inbox until the whole
 * turn ends. A correction meant to redirect work in flight arrives after the
 * work it was meant to redirect: measured at 47.5s of stall against a child
 * running ten sequential bash steps, where the steer was accepted 7.4s in and
 * claimed only at 54.9s.
 *
 * `Agent.steer()` is the harness's own primitive for exactly this: it targets
 * `next-step`, so a running driver consumes it at its next step boundary. This
 * plugin uses it for the one case the shipped tool handles poorly — a running
 * DIRECT child of the exact live caller — and delegates every other case to the
 * native service unchanged.
 *
 * What stays native, deliberately:
 *   - an idle, waiting, or absent child (the service owns waking and cold
 *     resume from persisted state),
 *   - any authority mismatch (the service owns the authoritative rejection),
 *   - ownership accounting and settlement (untouched; this never mutates the
 *     manager's state).
 *
 * So the fast path narrows to a case where the answer is unambiguous, and
 * anything else keeps the shipped behavior including its error messages.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-subagent-model-control'
export const inject = ['tools', 'subagents', 'agents']

/**
 * Register `send_message`.
 * @param ctx - the plugin context owning the registration.
 */
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'send_message',
    description:
      'Send a message to a background subagent by its subagent id, continuing the same conversation. '
      + 'If the subagent is still working, the message joins its CURRENT turn at the next step, so it can '
      + 'redirect work already underway — send it immediately rather than waiting for the child to finish, '
      + 'and do not interrupt unless the current step must stop. If the subagent is idle, the message starts '
      + 'its next turn. This call returns no answer from the subagent — only confirmation that the message '
      + 'was delivered. A failure means the message was NOT delivered.',
    parameters: {
      subagent_id: {
        type: 'string',
        required: true,
        description: 'The subagent id returned when the background subagent was started.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'The message to deliver to the subagent.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string', required: true },
          delivery: { type: 'string', required: true, enum: ['next-step', 'next-turn'] },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.delivery === 'next-step'
          ? `message delivered to subagent ${args.subagent_id}; it joins the current turn at the next step`
          : `message delivered to subagent ${args.subagent_id}; it starts the subagent's next turn`,
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('send_message requires a calling agent')
      const childId = SessionId(args.subagent_id)
      const content = [{ type: 'text', text: args.message }]
      const source = { kind: 'coordinator', form: 'relay', senderSessionId: parent.id }

      const child = ctx.agents.get(childId)
      // The authority predicate mirrors the service's own lineage check: the
      // caller must be the exact live direct parent of a running child. Any
      // mismatch falls through to the native path, which owns waking, cold
      // resume, and the authoritative rejection.
      const steerable = child !== undefined
        && child.status === 'running'
        && ctx.agents.get(parent.id) === parent
        && child.session.header.parentSession === parent.id
      if (steerable) {
        exec.signal?.throwIfAborted?.()
        const message = createUserMessage({ content, source })
        child.steer(message)
        // Settlement can race the steer: if the child left the registry in this
        // same tick, disposal cleared the inbox and the message is gone. Only a
        // still-registered child proves the steer landed; otherwise fall through
        // so the delivery is not silently lost.
        if (ctx.agents.get(childId) === child) {
          return { messageId: message.id, delivery: 'next-step' }
        }
      }

      const messageId = await ctx.subagents.followup(parent, childId, content, {
        source,
        signal: exec.signal,
      })
      return { messageId, delivery: 'next-turn' }
    },
  }))
}
