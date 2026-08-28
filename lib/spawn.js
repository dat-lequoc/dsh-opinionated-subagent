/**
 * dsh-subagent-model — a `subagent` tool that FORCES the child's model route.
 *
 * The shipped `@deepseek-ai/dsh-tool-subagent` takes only
 * `{ description, prompt }`, and a child with no `agentOptions` inherits its
 * parent's provider and model (`resolveChildAgentOptions` spreads the parent's
 * route first). This tool replaces that frontend with one that requires an
 * explicit `model` argument whose enum is the user's configured route
 * allowlist, and pins the chosen route plus its configured reasoning effort
 * onto every child it starts.
 *
 * Two mechanisms, because the harness splits them:
 *   - ROUTE: `SubagentStartRequest.agentOptions` carries `provider`/`model` and
 *     takes precedence over the inherited parent route. Durable, no bridge.
 *   - EFFORT: `agentOptions` has no effort field; an effort reaches a request
 *     only through the `agent/request` waterfall, so lib/effort.js installs the
 *     shipped `installModelSelection` on the exact child (see that module).
 *
 * The allowlist and per-route efforts are user-owned settings read at EVERY tool
 * call, so an edit applies to the next delegation with no restart. An empty
 * allowlist unregisters the tool rather than falling back to an unapproved
 * route: silently inheriting the parent model is the exact behavior this plugin
 * exists to prevent.
 */

import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installChildEffortBridge } from './effort.js'
import {
  EFFORT_PROVIDER_DEFAULT,
  INHERIT_ROUTE,
  parseRoute,
  reasoningInfo,
  resolveEffort,
  routeKey,
  routeLabel,
  selectRoute,
} from './policy.js'

/**
 * Read the route captured for the request currently executing this tool.
 *
 * Deliberately NOT `agent.options`: those are creation-time defaults and go
 * stale after a live model switch, so an inherit route would follow a model the
 * conversation no longer uses.
 *
 * @param agent - the calling agent.
 * @returns the turn's `{ provider, model }` plus its effort when one was sent.
 * @throws when no request header is available, rather than guessing a route.
 */
function currentTurnRoute(agent) {
  const config = agent?.session?.requestHeader?.()?.config
  if (typeof config?.provider !== 'string' || config.provider.length === 0
    || typeof config?.model !== 'string' || config.model.length === 0) {
    throw new Error(
      `"${INHERIT_ROUTE}" needs this turn's captured model route, which is unavailable; `
      + 'it never falls back to the session-creation model',
    )
  }
  return {
    provider: config.provider,
    model: config.model,
    ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
  }
}

export const name = 'dsh-subagent-model-spawn'
export const inject = ['tools', 'subagents', 'llm', 'systemPrompt']

/** Prompt order beside the shipped delegation guidance (116.5). */
const SECTION_ORDER = 116.6

export const Config = z.object({
  /** The `ctx.subagents` provider to start children on. */
  provider: z.string().default('spawn'),
  /** Model-facing tool name; must be unique among live tools. */
  toolName: z.string().default('subagent'),
  /**
   * Background policy. `continuable` (default) returns a durable subagent id
   * the parent can `send_message`; `one-shot` waits in the foreground.
   */
  backgroundMode: z.union(['continuable', 'one-shot']).default('continuable'),
  /** Optional per-child persona shadowing the deployment persona. */
  persona: z.string(),
  /**
   * Child recursion cap forwarded per request (default 3; `0` forbids further
   * delegation). A numeric cap requires the provider's `depthLimit` capability,
   * so `'provider-managed'` sends no cap for a provider that owns its own
   * recursion budget.
   */
  maxDepth: z.union([z.natural(), z.const('provider-managed')]).default(3),
})

/**
 * List each named provider's models so an adapter that discovers capabilities
 * live has answered once before any route is resolved.
 *
 * `resolveModelInfo` is not required to perform discovery itself: an adapter may
 * answer it from a cache that only `listModels` fills, and fall back to a static
 * capability list while that cache is cold. `dsh-kiro` does exactly this — its
 * `currentModels` hook is a cache read, so a cold resolve reports a legacy
 * effort list that omits every live-discovered effort, and validating against it
 * refuses an effort the provider genuinely accepts.
 *
 * Only providers the allowlist actually names are listed, so a delegation never
 * wakes an unrelated adapter. A provider that fails to enumerate is left to the
 * per-route resolve below, which degrades that route on its own.
 *
 * @param ctx - plugin context (for `ctx.llm` and warnings).
 * @param providers - provider ids named by the configured routes.
 */
async function warmCatalog(ctx, providers) {
  for (const provider of providers) {
    try {
      await ctx.llm.listModels(provider)
    } catch (error) {
      ctx.logger.warn(
        `dsh-subagent-model: provider "${provider}" did not enumerate (${error?.message ?? error}); `
        + 'its routes resolve against whatever capabilities the adapter reports',
      )
    }
  }
}

/**
 * Resolve configured route spellings against the live model catalog.
 *
 * A malformed or unresolvable entry is skipped with a warning rather than
 * failing the mount: one retired model in a list of five must not disable
 * delegation entirely. If NONE resolve, the caller unregisters the tool.
 *
 * @param ctx - plugin context (for `ctx.llm` and warnings).
 * @param routes - configured `provider/model-id` spellings, in order.
 * @returns resolved entries, deduplicated, in configured order.
 */
async function resolveAllowlist(ctx, routes) {
  const entries = []
  const seen = new Set()
  // Warm every named provider first: a per-route resolve interleaved with
  // listing would let the first route read a still-cold capability list.
  const providers = new Set()
  for (const value of routes) {
    if (value === INHERIT_ROUTE) continue
    const parsed = parseRoute(value)
    if (parsed !== undefined) providers.add(parsed.provider)
  }
  await warmCatalog(ctx, providers)
  for (const value of routes) {
    if (seen.has(value)) continue
    seen.add(value)
    if (value === INHERIT_ROUTE) {
      // Stays synthetic: there is no model to resolve until a call supplies a turn.
      entries.push({ inherit: true, modalities: [] })
      continue
    }
    const parsed = parseRoute(value)
    if (parsed === undefined) {
      ctx.logger.warn(`dsh-subagent-model: route "${value}" is not provider/model-id — skipped`)
      continue
    }
    try {
      const info = await ctx.llm.resolveModelInfo(parsed.provider, parsed.id)
      entries.push({
        provider: parsed.provider,
        id: parsed.id,
        modalities: [...info.inputModalities ?? ['text']],
        ...reasoningInfo(info.reasoning) === undefined
          ? {}
          : { reasoning: reasoningInfo(info.reasoning) },
      })
    } catch (error) {
      ctx.logger.warn(
        `dsh-subagent-model: route "${value}" did not resolve (${error?.message ?? error}) — skipped`,
      )
    }
  }
  return entries
}

export async function apply(ctx, config) {
  const provider = config.provider ?? 'spawn'
  const toolName = config.toolName ?? 'subagent'
  const continuable = (config.backgroundMode ?? 'continuable') === 'continuable'
  const bridge = installChildEffortBridge(ctx)

  // Settings are the sole routing authority. `ctx.get` rather than a declared
  // injection: the settings service is optional, and without it this plugin
  // still works from its composition entry.
  const settings = () => ctx.get('subagentModelSettings')?.current()
  const configuredRoutes = () => {
    const value = settings()?.routes
    return Array.isArray(value) ? value : []
  }
  const configuredEfforts = () => {
    const value = settings()?.efforts
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  }
  const effortFor = (route) => {
    const value = configuredEfforts()[route]
    return typeof value === 'string' && value.length > 0 ? value : EFFORT_PROVIDER_DEFAULT
  }

  let allowlist = []
  let cachedKey
  let disposeTool
  let providerAvailable = ctx.subagents.getProvider(provider) !== undefined

  const describeRoutes = () => allowlist
    .map(entry => routeLabel(entry, effortFor(routeKey(entry))))
    .join('\n')

  /** Register one schema snapshot holding exactly the currently allowed routes. */
  const mount = () => {
    const rows = describeRoutes()
    disposeTool = ctx.tools.register(defineTool({
      name: toolName,
      description:
        'Delegate a self-contained task to a subagent that runs on an EXPLICITLY CHOSEN model. '
        + 'The child works in its own context and does not see this conversation, so the prompt must be a '
        + 'complete, standalone task. The required `model` argument must be one exact route from the list '
        + 'below; the child runs on that route and does NOT inherit your model. Its reasoning effort is '
        + 'user-configured per route and is not yours to choose. '
        + `Allowed routes:\n${rows}`,
      parameters: {
        description: {
          type: 'string',
          required: true,
          description: 'A short (3-5 word) description of the delegated task, for display.',
        },
        prompt: {
          type: 'string',
          required: true,
          description: 'The complete, self-contained task for the subagent. It does not share this '
            + 'conversation\'s context, so include everything it needs.',
        },
        model: {
          type: 'string',
          required: true,
          enum: allowlist.map(routeKey),
          description: `Required. The exact route the child runs on. Only these are accepted:\n${rows}`,
        },
        run_in_background: {
          type: 'boolean',
          description: continuable
            ? 'Defaults to true (durable background child reachable by send_message). Set false to wait '
              + 'for the result when your next action depends on it.'
            : 'Defaults to false (wait for the result). Set true to run detached.',
        },
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'continuable' },
                subagentId: { type: 'string', required: true },
                model: { type: 'string', required: true },
                modalities: { type: 'array', required: true, items: { type: 'string' } },
                effort: { type: 'string', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'foreground' },
                output: { type: 'array', required: true, items: { type: 'json' } },
                model: { type: 'string', required: true },
                modalities: { type: 'array', required: true, items: { type: 'string' } },
                effort: { type: 'string', required: true },
              },
            },
          ],
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.kind === 'continuable'
            ? `started subagent ${value.subagentId} on ${value.model} `
              + `[${value.modalities.join(',')}] effort=${value.effort}`
            : `subagent completed on ${value.model} [${value.modalities.join(',')}] `
              + `effort=${value.effort}\n\n${value.output
                .filter(block => typeof block === 'object' && block !== null && block.type === 'text')
                .map(block => block.text)
                .join('')}`,
        }],
      },
      // Foreground starts share one parent-matched effort reservation slot, so
      // sibling calls must not overlap.
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const parent = exec.agent
        if (parent === undefined) throw new Error(`${toolName} requires a calling agent`)

        // Re-read settings at execution time: a schema captured a step ago
        // cannot authorize a route the user removed since.
        await refreshAllowlist()
        const chosen = selectRoute(args.model, allowlist)

        // An inherit route becomes concrete here: resolve the turn's captured
        // route, then validate any configured effort against THAT exact model.
        let selected = chosen
        if (chosen.inherit === true) {
          const turn = currentTurnRoute(parent)
          // The turn's provider may not be in the allowlist, so the refresh
          // above did not warm it. Warm it here for the same reason.
          await warmCatalog(ctx, [turn.provider])
          const info = await ctx.llm.resolveModelInfo(turn.provider, turn.model, exec.signal)
          selected = {
            provider: turn.provider,
            id: turn.model,
            modalities: [...info.inputModalities ?? ['text']],
            ...reasoningInfo(info.reasoning) === undefined
              ? {}
              : { reasoning: reasoningInfo(info.reasoning) },
            // Following the turn means following its effort too, unless the user
            // configured an explicit effort for the inherit route.
            inheritedEffort: turn.reasoningEffort,
          }
        }

        const configuredEffort = effortFor(args.model)
        const effort = configuredEffort === EFFORT_PROVIDER_DEFAULT
            && selected.inheritedEffort !== undefined
          ? { label: `${selected.inheritedEffort} (inherited)`, reasoningEffort: selected.inheritedEffort }
          : resolveEffort(configuredEffort, selected)

        const forced = {
          provider: selected.provider,
          model: selected.id,
          ...effort.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: effort.reasoningEffort },
        }
        const depth = config.maxDepth ?? 3
        const request = {
          label: args.description,
          prompt: [{ type: 'text', text: args.prompt }],
          parent,
          // A numeric cap needs the provider's depthLimit capability; omit it
          // entirely when the provider owns its own recursion budget.
          ...depth === 'provider-managed' ? {} : { maxDepth: depth },
          // The route the child actually runs on. This is what defeats parent
          // inheritance; the effort rides the bridge instead.
          agentOptions: { provider: selected.provider, model: selected.id },
          ...config.persona === undefined ? {} : { persona: config.persona },
        }

        const background = args.run_in_background ?? continuable
        if (background && continuable) {
          // A continuable start accepts a caller-reserved id, so the effort is
          // keyed exactly rather than matched by parent.
          const childId = randomUUID()
          bridge.reserve(childId, forced)
          let started
          try {
            started = await ctx.subagents.startContinuable({
              provider,
              label: args.description,
              childId,
              request,
              signal: exec.signal,
            })
          } catch (error) {
            bridge.release(childId)
            throw error
          }
          return {
            kind: 'continuable',
            subagentId: started.childId,
            model: routeKey(selected),
            modalities: selected.modalities,
            effort: effort.label,
          }
        }

        bridge.reserveNextChildOf(parent.id, forced)
        let run
        try {
          run = await ctx.subagents.start(provider, { ...request, signal: exec.signal })
          const result = await run.result
          if (result.stopReason !== 'completed') {
            const partial = result.output
              .filter(block => block.type === 'text')
              .map(block => block.text)
              .join('')
            throw new Error(
              `subagent run ended abnormally (${String(result.stopReason)})`
              + (partial === '' ? '' : `\nPartial output before the run ended:\n${partial}`),
            )
          }
          return {
            kind: 'foreground',
            output: result.output,
            model: routeKey(selected),
            modalities: selected.modalities,
            effort: effort.label,
          }
        } finally {
          bridge.release(undefined)
          if (run !== undefined) await run.dispose()
        }
      },
    }))
  }

  /** Keep registration aligned with provider AND allowlist availability. */
  const reconcile = () => {
    if (disposeTool !== undefined) {
      disposeTool()
      disposeTool = undefined
    }
    if (providerAvailable && allowlist.length > 0) mount()
  }

  // Serialize catalog resolution. A settings edit remounts the tool so the next
  // request's schema carries the current enum; `execute` still re-checks.
  let chain = Promise.resolve()
  const refreshAllowlist = () => {
    chain = chain.then(async () => {
      const routes = configuredRoutes()
      const key = JSON.stringify([routes, configuredEfforts()])
      if (key === cachedKey) return
      const resolved = await resolveAllowlist(ctx, routes)
      cachedKey = key
      allowlist = resolved
      reconcile()
    })
    return chain
  }

  // Live policy section, re-rendered per request. It states the rule even when
  // an empty allowlist leaves no tool, so the model can explain the refusal.
  ctx.systemPrompt.section({
    name: `forced-model:${toolName}`,
    order: SECTION_ORDER,
    text: () => {
      const lines = [
        'WORKER MODEL POLICY (user-owned; Settings -> Plugins -> dsh-subagent-model, or the '
        + 'dsh-subagent-model: block in ~/.dsh/settings.yaml; may change while you run — this section '
        + 'always shows current values):',
      ]
      lines.push(allowlist.length > 0
        ? `- \`${toolName}\` requires one exact \`model\` route from this complete allowlist. A child runs `
          + `on the route you name and NEVER inherits your model:\n${allowlist
            .map(entry => `    ${routeLabel(entry, effortFor(routeKey(entry)))}`)
            .join('\n')}`
        : `- Delegation is disabled: no worker routes are configured. Ask the user to add one in `
          + 'Settings -> Plugins -> dsh-subagent-model. Do not use another delegation tool to bypass '
          + 'this policy.')
      if (!providerAvailable) {
        lines.push(`- Delegation is unavailable: subagent provider "${provider}" is not registered.`)
      }
      lines.push(
        `- Reasoning effort is fixed per route by the user. \`${toolName}\` exposes no effort argument, `
        + `and a child never inherits your effort. Each configured effort is validated against the `
        + `exact model before any provider call; \`${EFFORT_PROVIDER_DEFAULT}\` sends no explicit effort.`,
      )
      lines.push(
        '- Pick a [text,image] route only when the child must inspect images, and name the image files '
        + 'it should read.',
      )
      return lines.join('\n')
    },
  })

  // Sibling load order and HMR can register the provider after this fiber.
  ctx.on('subagent/provider-added', (added) => {
    if (added.name !== provider) return
    providerAvailable = true
    reconcile()
  })
  ctx.on('subagent/provider-removed', (removed) => {
    if (removed !== provider) return
    providerAvailable = false
    reconcile()
  })
  if (!providerAvailable) {
    ctx.logger.info(
      `dsh-subagent-model: provider "${provider}" not registered yet; "${toolName}" will register when it appears`,
    )
  }

  await refreshAllowlist()
  const unsubscribe = ctx.get('subagentModelSettings')?.subscribe(() => {
    void refreshAllowlist().catch((error) => {
      ctx.logger.warn(`dsh-subagent-model: allowlist refresh failed (${error?.message ?? error})`)
    })
  })
  if (unsubscribe !== undefined) ctx.effect(() => unsubscribe)
}
