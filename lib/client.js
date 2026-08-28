/**
 * dsh-subagent-model — browser half: the Settings -> Plugins card.
 *
 * Registers one card into the shipped `settings.plugin.item` slot keyed by this
 * plugin's settings namespace. The Plugins tab renders the intersection of the
 * namespaces the Host serves and the cards registered into that slot, so this
 * file is what puts the plugin on the settings page at all — there is no generic
 * schema-driven form.
 *
 * The card owns everything inside itself (chrome, controls, copy, staging, and
 * revision fencing): the client bundle-purity gate rejects value imports across
 * plugins, so it cannot reuse the shipped card chrome.
 *
 * Reads and writes go through `ctx.settingsScope`, which fences each write with
 * the revision it read. Route choices come from this package's own host route
 * (`/subagent-model/catalog`, lib/index.js) so efforts are offered per model
 * rather than typed free-hand.
 *
 * This file is the loader's lazy-CJS factory artifact, hand-written: the
 * in-repo tsdown preset is not published. No JSX — React.createElement only.
 */
window.__ModuleLoader__.load({
  id: 'dsh-subagent-model',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const h = React.createElement

    const NAMESPACE = 'dsh-subagent-model'
    const INHERIT_ROUTE = 'inherit/current'
    const EFFORT_PROVIDER_DEFAULT = 'provider/default'
    // The wire tool name this row claims. It must match the spawn row's
    // `toolName` config; a mismatch simply renders the shipped generic row.
    const TOOL_NAME = 'subagent'

    // Inherited theme tokens; the card draws its own chrome.
    //
    // These names are the ones the Theme provider actually publishes
    // (`--dsw-alias-*`). An invented token silently falls through to the
    // literal fallback beside it, and those fallbacks are LIGHT-theme colors —
    // so a wrong name renders the whole card as near-black text on a dark
    // surface while every shipped card around it looks correct. The fallbacks
    // are for a missing theme, never the normal path.
    const palette = {
      text: 'var(--dsw-alias-label-primary, #1f2328)',
      dim: 'var(--dsw-alias-label-secondary, #6b7280)',
      border: 'var(--dsw-alias-border-l1, #d0d7de)',
      surface: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06))',
      accent: 'var(--dsw-alias-brand-primary, #2563eb)',
    }
    const tone = {
      bad: 'var(--dsw-alias-state-error-primary, #b91c1c)',
      good: 'var(--dsw-alias-state-success-primary, #16a34a)',
    }

    /** GET a JSON document; null on any failure (an empty catalog is survivable). */
    async function getJson(path) {
      try {
        const res = await fetch(path)
        if (!res.ok) return null
        return await res.json()
      } catch {
        return null
      }
    }

    /**
     * The card.
     * @param scope - the bound settings scope for this namespace.
     */
    function makeCard(scope) {
      return function SubagentModelCard() {
        const snapshot = React.useSyncExternalStore(
          listener => scope.subscribe(listener),
          () => scope.getSnapshot(),
        )
        const value = snapshot.value ?? {}
        const [draft, setDraft] = React.useState(null)
        const [catalog, setCatalog] = React.useState([])
        const [picker, setPicker] = React.useState('')
        const [saving, setSaving] = React.useState(false)
        const [failed, setFailed] = React.useState(false)

        React.useEffect(() => {
          let live = true
          void getJson('/subagent-model/catalog').then((body) => {
            if (live && body !== null) setCatalog(Array.isArray(body.routes) ? body.routes : [])
          })
          return () => { live = false }
        }, [])

        const current = draft ?? {
          routes: Array.isArray(value.routes) ? value.routes : [INHERIT_ROUTE],
          efforts: value.efforts !== null && typeof value.efforts === 'object' && !Array.isArray(value.efforts)
            ? value.efforts
            : {},
        }
        const edit = (patch) => { setDraft({ ...current, ...patch }); setFailed(false) }
        const writable = snapshot.writable === true
        const disabled = !writable || saving

        const entryFor = route => catalog.find(one => one.route === route)
        const effortsFor = (route) => {
          if (route === INHERIT_ROUTE) {
            // An inherit route resolves at call time, so any effort a catalog
            // model advertises may legitimately apply.
            const seen = new Set()
            for (const one of catalog) for (const id of one.efforts ?? []) seen.add(id)
            return [...seen]
          }
          return entryFor(route)?.efforts ?? []
        }
        const describe = (route) => {
          if (route === INHERIT_ROUTE) return "follows this conversation's model and effort"
          const entry = entryFor(route)
          if (entry === undefined) return 'not in the current catalog'
          return `[${entry.modalities.join(',') || 'text'}]`
        }

        const save = async () => {
          if (draft === null || saving) return
          setSaving(true)
          setFailed(false)
          try {
            // Drop efforts for routes no longer allowed, so a removed route
            // cannot leave a stale effort behind for a later re-add.
            const efforts = {}
            for (const route of draft.routes) {
              const chosen = draft.efforts[route]
              if (typeof chosen === 'string' && chosen !== EFFORT_PROVIDER_DEFAULT) efforts[route] = chosen
            }
            await scope.set('efforts', efforts)
            await scope.set('routes', draft.routes)
            setDraft(null)
          } catch {
            setFailed(true)
          }
          setSaving(false)
        }

        // A native <select> paints its own popup surface, so `transparent` would
        // leave the option list on the browser default (white) under a dark
        // theme. Naming the surface explicitly keeps the closed control and its
        // popup on theme.
        const controlStyle = {
          padding: '4px 7px', borderRadius: 8, fontSize: 12,
          border: `1px solid ${palette.border}`,
          background: palette.surface,
          color: palette.text,
        }
        // An <option> does not reliably inherit its <select>'s colors, so the
        // popup list is themed per option rather than once on the control.
        const optionStyle = { background: palette.surface, color: palette.text }

        const forcing = !current.routes.includes(INHERIT_ROUTE) && current.routes.length > 0

        const routeRow = (route) => {
          const efforts = effortsFor(route)
          const selected = current.efforts[route] ?? EFFORT_PROVIDER_DEFAULT
          const known = efforts.includes(selected)
          return h('li', {
            key: route,
            style: {
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
              border: `1px solid ${palette.border}`, borderRadius: 8, background: palette.surface,
            },
          },
          h('code', { style: { fontSize: 12, color: palette.text } }, route),
          h('span', { style: { fontSize: 11, color: palette.dim, flex: 1 } }, describe(route)),
          h('select', {
            value: selected,
            disabled,
            title: `Reasoning effort sent for ${route}`,
            onChange: (event) => edit({
              efforts: { ...current.efforts, [route]: event.target.value },
            }),
            style: { ...controlStyle, minWidth: 150 },
          },
          h('option', { value: EFFORT_PROVIDER_DEFAULT, style: optionStyle },
            route === INHERIT_ROUTE ? 'Follow this turn' : 'Provider default'),
          // A configured effort the catalog no longer advertises stays visible:
          // hiding it would silently rewrite the user's saved value.
          !known && selected !== EFFORT_PROVIDER_DEFAULT
            ? h('option', { value: selected, style: optionStyle }, `${selected} (not advertised)`)
            : null,
          efforts.map(id => h('option', { key: id, value: id, style: optionStyle }, id))),
          h('button', {
            disabled,
            title: `Remove ${route}`,
            onClick: () => edit({ routes: current.routes.filter(one => one !== route) }),
            style: { ...controlStyle, cursor: disabled ? 'default' : 'pointer' },
          }, 'Remove'))
        }

        const addable = catalog.filter(one => !current.routes.includes(one.route))

        return h('li', {
          style: {
            listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10,
            padding: 14, borderRadius: 12, border: `1px solid ${palette.border}`,
          },
        },
        h('div', null,
          h('div', { style: { fontSize: 14, fontWeight: 600, color: palette.text } }, 'Subagent model'),
          h('div', { style: { fontSize: 12, color: palette.dim, marginTop: 2 } },
            'Which models a subagent may run on, and the reasoning effort sent for each. '
            + 'The delegating agent must name one of these routes and cannot choose its effort.')),

        h('div', {
          style: {
            fontSize: 12, color: forcing ? palette.text : palette.dim,
            padding: '6px 8px', borderRadius: 8, background: palette.surface,
          },
        }, forcing
          ? 'Forcing: a subagent runs only on the routes below and never inherits this conversation\'s model.'
          : current.routes.length === 0
            ? 'No routes allowed — delegation is disabled until you add one.'
            : `Inheriting: while ${INHERIT_ROUTE} is allowed, a subagent may follow this conversation's own model. Remove it to force the routes below.`),

        current.routes.length > 0
          ? h('ul', { style: { display: 'flex', flexDirection: 'column', gap: 6, margin: 0, padding: 0, listStyle: 'none' } },
            current.routes.map(routeRow))
          : null,

        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('select', {
            value: picker,
            disabled: disabled || addable.length === 0,
            onChange: event => setPicker(event.target.value),
            style: { ...controlStyle, flex: 1 },
          },
          h('option', { value: '', style: optionStyle },
            addable.length === 0 ? 'No further routes available' : 'Add a route…'),
          addable.map(one => h('option', { key: one.route, value: one.route, style: optionStyle },
            one.route === INHERIT_ROUTE
              ? `${INHERIT_ROUTE} — follow this conversation`
              : `${one.route}${one.name && one.name !== one.route ? ` — ${one.name}` : ''}`))),
          h('button', {
            disabled: disabled || picker === '',
            onClick: () => {
              if (picker === '') return
              edit({ routes: [...current.routes, picker] })
              setPicker('')
            },
            style: {
              ...controlStyle,
              cursor: disabled || picker === '' ? 'default' : 'pointer',
              borderColor: picker === '' ? palette.border : palette.accent,
            },
          }, 'Add')),

        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('button', {
            disabled: disabled || draft === null,
            onClick: save,
            style: {
              padding: '6px 12px', borderRadius: 8, fontSize: 13,
              cursor: disabled || draft === null ? 'default' : 'pointer',
              border: `1px solid ${draft === null ? palette.border : palette.accent}`,
              background: palette.surface,
              color: draft === null ? palette.dim : palette.accent,
            },
          }, saving ? 'Saving…' : 'Save'),
          draft !== null
            ? h('button', {
              disabled: saving,
              onClick: () => { setDraft(null); setFailed(false) },
              style: { ...controlStyle, padding: '6px 12px', fontSize: 13, cursor: 'pointer' },
            }, 'Discard')
            : null,
          failed
            ? h('span', { style: { fontSize: 12, color: tone.bad } }, 'Save failed — values kept, try again.')
            : null,
          !writable
            ? h('span', { style: { fontSize: 12, color: palette.dim } }, 'Settings document is read-only.')
            : null))
      }
    }

    // --------------------------------------------------------- toolview row

    /**
     * Read the route a `subagent` call names, straight from the arguments the
     * tool already sends. Nothing new is logged or computed for this row: the
     * `model` argument is required by the tool's own schema, so a call that
     * reached the log carries it.
     *
     * Returns null for anything unreadable — a truncated streaming argument, or
     * a call from the shipped frontend, which has no `model` argument at all.
     * A null route renders nothing, so the row never claims a model it cannot
     * prove.
     */
    function routeOfCall(block) {
      const raw = block?.argsRaw ?? block?.args
      if (typeof raw === 'object' && raw !== null) {
        return typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : null
      }
      if (typeof raw !== 'string' || raw.length === 0) return null
      try {
        const parsed = JSON.parse(raw)
        return typeof parsed?.model === 'string' && parsed.model.length > 0 ? parsed.model : null
      } catch {
        // A still-streaming or interrupted argument string is not an error here.
        return null
      }
    }

    /** The short description a `subagent` call carries, for the row summary. */
    function labelOfCall(block) {
      const raw = block?.argsRaw ?? block?.args
      let parsed = null
      if (typeof raw === 'object' && raw !== null) parsed = raw
      else if (typeof raw === 'string' && raw.length > 0) {
        try { parsed = JSON.parse(raw) } catch { parsed = null }
      }
      const value = parsed?.description
      return typeof value === 'string' && value.length > 0 ? value : null
    }

    /** Running / ok / error, derived from the same node the shipped row reads. */
    function stateOfCall(block) {
      if (block === null || typeof block !== 'object') return 'running'
      // A settled node is the paired tool/result; a running call has no `kind`.
      if (!('kind' in block)) return 'running'
      return block.isError === true ? 'error' : 'ok'
    }

    const STATE_COLOR = {
      running: palette.accent,
      ok: tone.good,
      error: tone.bad,
    }

    /**
     * The `subagent` call row: one line naming the route the child runs on.
     *
     * A keyed toolview REPLACES the generic row rather than decorating it, and
     * the client bundle-purity gate rejects value imports across plugins, so
     * this row cannot wrap or reuse the shipped card — it draws its own minimal
     * chrome and keeps the state dot and summary the shipped row would show.
     *
     * It reads only what the call already carries: the required `model`
     * argument and the `description`. Nothing new is logged or computed, and an
     * unreadable route renders the ordinary summary with no model claim.
     */
    function SubagentModelRow(props) {
      const { block, toolName, inspect } = props
      const route = routeOfCall(block)
      const label = labelOfCall(block)
      const state = stateOfCall(block)
      return h('div', {
        'data-tool': toolName,
        'data-state': state,
        style: {
          display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
          padding: '3px 0', fontSize: 13, color: palette.text,
        },
      },
      h('span', {
        'aria-hidden': true,
        style: {
          width: 6, height: 6, borderRadius: '50%', flex: '0 0 auto',
          background: STATE_COLOR[state],
        },
      }),
      h('span', { style: { fontWeight: 500, flex: '0 0 auto' } }, 'Subagent'),
      route !== null
        ? h('code', {
          title: 'This subagent runs on ' + route,
          style: {
            fontSize: 11, padding: '1px 6px', borderRadius: 6, flex: '0 0 auto',
            border: '1px solid ' + palette.border, background: palette.surface,
            color: palette.dim, whiteSpace: 'nowrap',
          },
        }, route)
        : null,
      label !== null
        ? h('span', {
          style: {
            color: palette.dim, overflow: 'hidden', minWidth: 0,
            textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          },
        }, label)
        : null,
      typeof inspect === 'function'
        ? h('button', {
          onClick: inspect,
          title: 'Inspect this call',
          style: {
            marginLeft: 'auto', flex: '0 0 auto', cursor: 'pointer',
            border: 'none', background: palette.surface, color: palette.dim, fontSize: 11,
            borderRadius: 6, padding: '1px 6px',
          },
        }, 'details')
        : null)
    }

    const inject = ['slots', 'settingsScope']

    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: NAMESPACE })
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
        { name: 'settings.plugin.item', key: NAMESPACE },
        makeCard(scope),
      ))
      // The keyed toolview hole: a row for this plugin's own tool name.
      // Registering a key the shipped composition covers is a takeover, so
      // this only claims the tool name this package configures.
      ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
        { name: 'tool.call.toolview', key: TOOL_NAME },
        SubagentModelRow,
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
