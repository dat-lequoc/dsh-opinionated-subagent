/**
 * dsh-subagent-model — host half: the user-owned settings namespace, plus the
 * model catalog its settings card reads.
 *
 * Owns one settings namespace (`dsh-subagent-model`), editable in
 * `~/.dsh/settings.yaml` and in the Web UI under Settings -> Plugins (the card
 * is this package's browser half, lib/client.js — the Plugins tab renders only
 * namespaces a registered card claims, so the card is what puts this plugin on
 * that page at all). It publishes the live value as the `subagentModelSettings`
 * service, which the tool (lib/spawn.js) reads at every call and renders into
 * its prompt section, so an edit applies mid-session with no restart.
 *
 * `GET /subagent-model/catalog` serves the harness model catalog — each route's
 * native input modalities and advertised reasoning efforts — so the card can
 * offer real choices instead of a free-text field. It is registered through a
 * NESTED plugin injecting `webServer`, so this package still mounts in profiles
 * with no web server at all.
 *
 * This plugin registers no tool: the route-forcing logic is the tool row, which
 * a preset mounts as `dsh-subagent-model/spawn`.
 */

import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { EFFORT_PROVIDER_DEFAULT, INHERIT_ROUTE, reasoningInfo } from './policy.js'

export const name = 'dsh-subagent-model'
export const inject = []

/** The user-owned namespace. */
export const SETTINGS_NS = settingsNamespace('dsh-subagent-model')

const SettingsSchema = z.object({
  /**
   * The complete allowlist of worker routes, spelled `provider/model-id`, plus
   * the explicit `inherit/current` entry.
   *
   * Seeded with `inherit/current` alone so INSTALLING this plugin changes no
   * behavior: a child follows the conversation's own model exactly as the
   * shipped tool does. Forcing is opt-in — add the routes you want and remove
   * the inherit entry to make inheritance impossible.
   *
   * An empty list disables the delegation tool rather than falling back to the
   * parent's model.
   */
  routes: z.array(z.string()).default([INHERIT_ROUTE]),
  /**
   * Reasoning effort per route. A route absent from this map, or set to
   * `provider/default`, sends no explicit effort — and for `inherit/current`
   * that means following the calling turn's own effort. Any other value must be
   * an effort that exact model advertises.
   */
  efforts: z.dict(z.string()).default({}),
})

const DEFAULTS = { routes: [INHERIT_ROUTE], efforts: {} }

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const log = ctx?.logger ?? console
  let source = () => DEFAULTS
  const watchers = new Set()

  ctx.provide('subagentModelSettings', {
    current: () => ({ ...DEFAULTS, ...source() }),
    subscribe: (listener) => {
      watchers.add(listener)
      return () => watchers.delete(listener)
    },
  })

  installSettingsSection(ctx, SETTINGS_NS, SettingsSchema, DEFAULTS, {
    setSource: (current) => { source = current },
    onChange: () => {
      for (const listener of watchers) {
        try {
          listener()
        } catch (error) {
          // One bad observer must not stop the others from re-deriving.
          log.warn(`dsh-subagent-model: settings watcher failed: ${error?.message ?? error}`)
        }
      }
    },
  })

  // Nested fiber: waits for webServer on web profiles, never mounts elsewhere.
  ctx.plugin({
    name: 'dsh-subagent-model-catalog',
    inject: ['webServer', 'llm'],
    apply: (webCtx) => {
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'exact',
        path: '/subagent-model/catalog',
        handler: (req, res) => catalogHandler(webCtx, req, res),
      }))
      log.info('dsh-subagent-model: catalog route registered at /subagent-model/catalog')
    },
  })
}

/**
 * `GET /subagent-model/catalog` — the explicit inherit entry followed by every
 * catalog route with its native input modalities and advertised efforts.
 *
 * One adapter failing to enumerate must not empty the whole list, and a route
 * whose capability enrichment fails stays selectable with what is known.
 */
async function catalogHandler(ctx, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end()
    return
  }
  const routes = [{ route: INHERIT_ROUTE, inherit: true, modalities: [] }]
  for (const provider of ctx.llm.listProviders()) {
    try {
      for (const model of await ctx.llm.listModels(provider.id)) {
        const route = `${model.provider}/${model.id}`
        if (route === INHERIT_ROUTE) continue
        let resolved = model
        try {
          resolved = await ctx.llm.resolveModelInfo(model.provider, model.id)
        } catch {
          // Keep the route selectable when only enrichment failed.
        }
        const reasoning = reasoningInfo(resolved.reasoning)
        routes.push({
          route,
          name: model.name ?? model.id,
          modalities: [...resolved.inputModalities ?? model.inputModalities ?? ['text']],
          ...reasoning === undefined ? {} : { efforts: reasoning.efforts.map(one => one.id) },
        })
      }
    } catch {
      // A single unreachable provider must not empty the dropdown.
    }
  }
  const payload = JSON.stringify({ routes })
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(req.method === 'HEAD' ? undefined : payload)
}

export { EFFORT_PROVIDER_DEFAULT, INHERIT_ROUTE }
