/**
 * dsh-subagent-model — host half: the user-owned settings namespace.
 *
 * Owns one settings namespace (`dsh-subagent-model`), editable in
 * `~/.dsh/settings.yaml` and, because the schema is plain, in the Web UI under
 * Settings -> Plugins. It publishes the live value as the
 * `subagentModelSettings` service, which the tool (lib/spawn.js) reads at every
 * call and renders into its prompt section, so an edit applies mid-session with
 * no restart.
 *
 * This plugin registers no tool and mounts no route: the route-forcing logic is
 * the tool row, which a preset or profile mounts as `dsh-subagent-model/spawn`.
 */

import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { EFFORT_PROVIDER_DEFAULT, INHERIT_ROUTE } from './policy.js'

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
}

export { EFFORT_PROVIDER_DEFAULT, INHERIT_ROUTE }
