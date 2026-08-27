/**
 * Pure route-and-effort policy for the forced-model subagent tool.
 *
 * Kept free of Harness imports so every rule below is exercised by
 * dependency-free tests. The tool (lib/spawn.js) owns all I/O.
 *
 * A route is always spelled `provider/model-id`. There is deliberately no
 * bare-model form and no inheritance sentinel: the whole point of this plugin
 * is that a child's route is chosen explicitly, so a tool call must visibly
 * carry the route it runs on.
 */

/** Effort value meaning "send no explicit effort and let the provider decide". */
export const EFFORT_PROVIDER_DEFAULT = 'provider/default'

/**
 * The one route that deliberately follows the calling turn's captured route
 * and effort.
 *
 * This is an EXPLICIT allowlist entry, never a fallback: a child inherits only
 * when the user allowed this route and the model named it in the call, so the
 * tool call still visibly carries what the child runs on. Omitting it from the
 * allowlist makes inheritance impossible.
 *
 * It resolves the route recorded for the current turn (`request/header`), not
 * the session-creation model, so a mid-session model switch is respected.
 */
export const INHERIT_ROUTE = 'inherit/current'

/** Canonical `provider/model-id` key for one resolved catalog entry. */
export function routeKey(entry) {
  if (entry.inherit === true) return INHERIT_ROUTE
  return `${entry.provider}/${entry.id}`
}

/**
 * Split a configured `provider/model-id` route.
 * @param value - the configured spelling.
 * @returns `{ provider, id }`, or undefined when the spelling is unusable.
 */
export function parseRoute(value) {
  if (typeof value !== 'string') return undefined
  const slash = value.indexOf('/')
  // Reject a missing separator, an empty provider, and an empty model id. A
  // model id may itself contain slashes (`org/name`), so only the FIRST
  // separator splits.
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) }
}

/**
 * Human-readable route label for the tool schema and the prompt section:
 * the route, its native input modalities, and the effort this plugin will
 * actually send.
 */
export function routeLabel(entry, effort) {
  if (entry.inherit === true) {
    return `${INHERIT_ROUTE}  [follows this turn's own model and effort, resolved at call time`
      + `${effort === EFFORT_PROVIDER_DEFAULT ? '' : `; effort overridden to ${effort}`}]`
  }
  const modalities = entry.modalities.length === 0 ? 'text' : entry.modalities.join(',')
  const advertised = entry.reasoning?.efforts?.map(one => one.id) ?? []
  const advertisedLabel = advertised.length === 0 ? '' : `; supports effort ${advertised.join('/')}`
  return `${routeKey(entry)}  [${modalities}${advertisedLabel}; effort sent: ${effort}]`
}

/**
 * Resolve the effort configured for one route against that exact model's
 * advertised efforts.
 *
 * Omission is the ONLY representation of provider default: the harness rejects
 * an unadvertised explicit effort id without clamping, so validating here turns
 * a misconfiguration into one clear message at call time instead of a provider
 * error mid-run.
 *
 * @param configured - the settings value for this route, if any.
 * @param entry - the resolved catalog entry the effort must be valid for.
 * @returns `{ label }` always, plus `reasoningEffort` when one is sent.
 * @throws when a fixed effort is not advertised by this exact model.
 */
export function resolveEffort(configured, entry) {
  const value = typeof configured === 'string' && configured.length > 0
    ? configured
    : EFFORT_PROVIDER_DEFAULT
  if (value === EFFORT_PROVIDER_DEFAULT) return { label: value }

  // An inherit route is resolved to a concrete model at call time; validating a
  // fixed effort here would check it against a model this function cannot see.
  // The caller re-resolves the effort once the turn's route is known.
  if (entry.inherit === true) return { label: value, reasoningEffort: value }

  const advertised = entry.reasoning?.efforts?.map(one => one.id) ?? []
  if (!advertised.includes(value)) {
    throw new Error(
      `reasoning effort "${value}" is not supported by ${routeKey(entry)} — `
      + (advertised.length === 0
        ? `that model advertises no selectable efforts; use ${EFFORT_PROVIDER_DEFAULT}`
        : `supported: ${advertised.join(', ')}`),
    )
  }
  return { label: value, reasoningEffort: value }
}

/**
 * Select the route a tool call asked for from the resolved allowlist.
 * @param value - the model's `model` argument.
 * @param allowlist - resolved catalog entries, in configured order.
 * @returns the matching entry.
 * @throws when the argument is absent, unusable, or not on the allowlist.
 */
export function selectRoute(value, allowlist) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('model is required: choose one exact route from the configured worker allowlist')
  }
  const selected = allowlist.find(entry => routeKey(entry) === value)
  if (selected !== undefined) return selected
  if (value === INHERIT_ROUTE) {
    throw new Error(
      `"${INHERIT_ROUTE}" is not on the configured worker allowlist — the user has not allowed a child `
      + 'to follow this conversation\'s model; choose one of:\n'
      + allowlist.map(entry => routeKey(entry)).join('\n'),
    )
  }
  if (allowlist.length === 0) {
    throw new Error(
      'no worker routes are configured — add one in Settings -> Plugins -> dsh-subagent-model '
      + '(or the dsh-subagent-model: block in ~/.dsh/settings.yaml) before delegating',
    )
  }
  throw new Error(
    `model "${value}" is not on the configured worker allowlist — allowed routes:\n`
    + allowlist.map(entry => routeKey(entry)).join('\n'),
  )
}

/**
 * Detach adapter reasoning metadata into plain data.
 *
 * The resolved catalog aggregate is retained across tool re-registrations and
 * copied into a JSON tool schema, so it must not alias adapter-owned objects.
 */
export function reasoningInfo(reasoning) {
  if (!Array.isArray(reasoning?.efforts)) return undefined
  return {
    efforts: reasoning.efforts
      .filter(one => typeof one?.id === 'string' && one.id.length > 0)
      .map(one => ({ id: one.id })),
  }
}
