# dsh-subagent-model

A DeepSeek Harness plugin whose `subagent` tool **forces** every child onto an explicitly chosen model route and reasoning effort, instead of letting it inherit the parent agent's model.

## Why

A child started with no `agentOptions` inherits its parent's route: `resolveChildAgentOptions` spreads the parent's `provider`/`model` first, and the shipped `@deepseek-ai/dsh-tool-subagent` takes only `{ description, prompt }` — it exposes no way for a caller to choose. So a worker silently runs on whatever the main agent runs on.

This plugin replaces that frontend. The `model` argument is **required**, its `enum` is your configured allowlist, and the chosen route plus its configured effort are pinned onto the child.

## Installing changes nothing until you say so

The allowlist ships seeded with one entry, `inherit/current`, which explicitly follows the calling turn's own model and effort. So a fresh install behaves exactly like the shipped tool, and there is nothing to undo if you change your mind.

Forcing is opt-in: add the routes you want, and **remove `inherit/current`** to make inheritance impossible. While it is present the model may still name it, so it is a permission, not a fallback — the tool call visibly records which route the child ran on either way.

`inherit/current` resolves the route recorded for the current turn, not the session-creation model, so a mid-session model switch is respected.

## How it forces the route

The harness splits these two facts, so the plugin uses two mechanisms:

| Fact | Mechanism | Durable? |
|---|---|---|
| provider + model | `SubagentStartRequest.agentOptions`, which takes precedence over the inherited parent route | yes — no bridge needed |
| reasoning effort | `installModelSelection` on the child's own context at its `agent/created` edge | reservation is in-memory; the child's first `request/header` becomes the authority |

`agentOptions` has no effort field — an effort reaches a request only through the `agent/request` waterfall. `lib/effort.js` uses the harness's own `installModelSelection` primitive (the same one the Web model picker uses), which also keeps prompt `{{model}}` interpolation and the logged `request/header` agreeing with what is actually sent.

`agent/created` is a synchronous publication boundary, so the selection is installed before the child can assemble a prompt or issue a request.

## Install

```sh
dsh plugin --profile web add /path/to/dsh-subagent-model
```

That mounts the **host half** only: the settings namespace that owns your allowlist. It registers no tool.

The **tool row** belongs to an agent preset, because a delegation tool is per-agent composition and must *replace* the shipped row rather than sit beside it — two rows registering the same `subagent` name collide, and leaving the shipped one mounted would give the model a way to bypass this policy.

In your preset's `agent.cordis.yml`, replace the `tool-subagent` row:

```yaml
    - id: tool-subagent
      name: dsh-subagent-model/spawn
      config:
        provider: spawn
        toolName: subagent
        backgroundMode: continuable   # or one-shot
        maxDepth: 3                   # or provider-managed
```

## Configure

**Settings → Plugins → Subagent model.** The card lists your allowed routes, each with an effort dropdown populated from what that exact model advertises, plus an "Add a route…" picker fed by the live model catalog. Edits stage locally and commit on **Save** through the revision-fenced settings scope, so a half-finished edit never reaches a running agent. The banner states plainly whether you are currently *inheriting* or *forcing*.

Both halves ship in this one package: installing it puts the card on the settings page. The Plugins tab renders only namespaces a registered card claims, so there is no generic schema-driven form to fall back on.

Equivalently, in `~/.dsh/settings.yaml`:

```yaml
dsh-subagent-model:
  routes:
    - kiro/claude-opus-5
    - deepseek/deepseek-chat
    # - inherit/current   # remove to forbid inheriting the conversation's model
  efforts:
    kiro/claude-opus-5: high
    deepseek/deepseek-chat: provider/default
```

- `routes` — the complete allowlist, spelled `provider/model-id`, plus the optional `inherit/current` entry. Only the *first* `/` splits a provider route, so a model id may itself contain slashes. Defaults to `[inherit/current]`.
- `efforts` — effort per route. A route absent from the map, or set to `provider/default`, sends no explicit effort — and for `inherit/current` that means following the calling turn's own effort. Any other value must be an effort that exact model advertises; an unadvertised id is refused **before** any provider call rather than clamped. An explicit effort on `inherit/current` overrides the inherited one, so you can follow the model but pin the effort.

Both are read at **every** tool call, so an edit applies to the next delegation with no restart.

## Behavior worth knowing

- **An empty allowlist unregisters the tool.** It never falls back to the parent's model — silently inheriting is the exact behavior this plugin exists to prevent. The prompt section still states the rule so the model can explain the refusal.
- **A route that no longer resolves is skipped with a warning**, and the remaining routes keep working. If none resolve, the tool is unregistered.
- **The model cannot choose an effort.** There is no effort argument, and a child never inherits the parent's.
- **Settings are re-read inside `execute`**, so a schema captured a step ago cannot authorize a route you removed since.
- **Foreground calls are marked concurrency-unsafe**, because they share one parent-matched effort reservation slot.

## Config reference

| Field | Default | Meaning |
|---|---|---|
| `provider` | `spawn` | The `ctx.subagents` provider to start children on |
| `toolName` | `subagent` | Model-facing tool name; must be unique among live tools |
| `backgroundMode` | `continuable` | `continuable` returns a durable subagent id reachable by `send_message`; `one-shot` defaults to waiting |
| `persona` | — | Optional per-child persona shadowing the deployment persona |
| `maxDepth` | `3` | Child recursion cap, or `provider-managed` to send none |

## Routes

| Route | Purpose |
|---|---|
| `GET /subagent-model/catalog` | The model catalog the settings card reads: every route with its native input modalities and advertised reasoning efforts, plus the `inherit/current` entry. Registered through a nested plugin injecting `webServer`, so the package still mounts in profiles with no web server. |

## Tests

```sh
npm test
```

49 tests. `policy.test.mjs` and `reservations.test.mjs` are dependency-free — the route, effort, and reservation-matching rules are pure and need no harness. `integration.test.mjs` mounts the tool on a real Cordis context with the real `ToolRuntime`/`SubagentRuntime` and asserts against a capture provider that the built `SubagentStartRequest` carries the chosen route, including that the seeded inherit route reproduces the shipped behavior. `defaults.test.mjs` pins the behavior-neutral seed. `client-card.test.mjs` exercises the browser card without a browser — it supplies a module loader and a React stub that records the element tree, then asserts the slot registration, that nothing is written before Save, that Save writes `efforts` before `routes`, and that a removed route takes its effort with it. The harness-dependent suites self-skip when those packages are not resolvable.

## Known limitations

- **The effort reservation is in-memory.** A process restart between a child's creation and its first request loses the reserved effort, and that child falls back to its route's provider default. The route itself is durable, so this cannot silently change models.
- **`lib/client.js` is a hand-written lazy-CJS factory.** The repository's `tsdown` client preset is not published, so an out-of-tree package must reproduce that artifact format itself. The card therefore uses `React.createElement` directly and draws its own chrome — the client bundle-purity gate rejects value imports across plugins, so it cannot reuse the shipped card components.
- **The card needs the catalog route to offer choices.** Without a web server the settings namespace still works from YAML; the picker and effort dropdowns are simply empty.
- **One tool row per provider.** Two rows sharing a `toolName` collide at registration, by design.
