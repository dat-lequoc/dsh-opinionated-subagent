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

    // Inherited theme tokens; the card draws its own chrome.
    const palette = {
      text: 'var(--dsw-color-text-primary, #1f2328)',
      dim: 'var(--dsw-color-text-secondary, #6b7280)',
      border: 'var(--dsw-color-border-default, #d0d7de)',
      surface: 'var(--dsw-color-bg-subtle, rgba(127,127,127,0.06))',
      accent: 'var(--dsw-color-primary, #2563eb)',
    }
    const tone = { bad: 'var(--dsw-color-danger, #b91c1c)' }

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

        const controlStyle = {
          padding: '4px 7px', borderRadius: 8, fontSize: 12,
          border: `1px solid ${palette.border}`, background: 'transparent', color: palette.text,
        }

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
          h('option', { value: EFFORT_PROVIDER_DEFAULT },
            route === INHERIT_ROUTE ? 'Follow this turn' : 'Provider default'),
          // A configured effort the catalog no longer advertises stays visible:
          // hiding it would silently rewrite the user's saved value.
          !known && selected !== EFFORT_PROVIDER_DEFAULT
            ? h('option', { value: selected }, `${selected} (not advertised)`)
            : null,
          efforts.map(id => h('option', { key: id, value: id }, id))),
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
          h('option', { value: '' }, addable.length === 0 ? 'No further routes available' : 'Add a route…'),
          addable.map(one => h('option', { key: one.route, value: one.route },
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
              background: 'transparent',
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

    const inject = ['slots', 'settingsScope']

    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: NAMESPACE })
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
        { name: 'settings.plugin.item', key: NAMESPACE },
        makeCard(scope),
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
