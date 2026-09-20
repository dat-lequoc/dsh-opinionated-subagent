# dsh-subagent-model

A minimal, opinionated `subagent` for DeepSeek Harness: you decide which models a child may run on, at which reasoning effort, and a correction reaches a working child at its next step instead of after its turn.

## What it does

- **Forces every child model.** `subagent` takes a required `model` argument; Agent Teams' `spawn_teammate` has no model argument, so it uses the first concrete route in this allowlist. Neither path silently inherits the conversation's model when forcing is configured.
- **Forces the child's reasoning effort.** Effort is set per route by you, not by the delegating agent — it has no effort argument and cannot inherit yours.
- **Refuses a wrong effort before spending anything.** A configured effort is validated against that exact model's advertised set, before any provider call.
- **Steers a running child at its next step.** The shipped `send_message` queues behind the whole current turn; a correction aimed at work in flight can land minutes late. This one joins the turn in progress.
- **Shows the route in the transcript.** Each `subagent` call renders the model it ran on, so you never read the session log to check.
- **Configurable in the UI.** Settings → Plugins, with effort dropdowns populated from what each model actually supports.
- **Neutral until you opt in.** Installed, it behaves exactly like the shipped tool; forcing starts when you edit the allowlist.

Every piece is optional and composes per row: mount only the delegation frontend, only the steering `send_message`, or both.

## Why

A child started with no `agentOptions` inherits its parent's route. Current DSH can optionally expose model selection on its stock tool, but this plugin supplies a separate required-route policy and per-route, user-owned effort. Installing its settings panel does **not** configure the stock tools.

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
| reasoning effort | `agentOptions.reasoningEffort`, plus `installModelSelection` on the live child | current DSH persists it in the continuation descriptor before the first request |

Current DSH supports `agentOptions.reasoningEffort`. The plugin passes it explicitly (including `undefined` to clear same-route inheritance for `provider/default`). `lib/effort.js` additionally uses the harness's `installModelSelection` primitive to keep live prompt interpolation and request routing in agreement.

`agent/created` is a synchronous publication boundary, so the selection is installed before the child can assemble a prompt or issue a request.

## Install

```sh
dsh plugin --profile web add /path/to/dsh-subagent-model
```

That mounts the **host half** only: the settings namespace that owns your allowlist. It registers no tool.

The **tool row** belongs to an agent preset, because a delegation tool is per-agent composition and must *replace* the shipped row rather than sit beside it — two rows registering the same `subagent` name collide, and leaving the shipped one mounted would give the model a way to bypass this policy.

Create a local copy of the preset you actually use (for example `ptc`) in the preset picker, then edit that copy's `agent.cordis.yml` under `~/.dsh/.agent-presets/<your-id>/`. Do not edit shipped presets: upgrades replace them. A host `cordis.patch.yml` does not patch the standing preset composition.

Replace **both** delegation rows in that file as below. This example forces routes for spawn and fork, and prevents either kind of child from delegating:

```yaml
    - id: tool-subagent
      name: dsh-subagent-model/spawn
      config:
        provider: spawn
        toolName: subagent
        backgroundMode: continuable   # or one-shot
        maxDepth: 1
        toolFilter:
          deny: [subagent, subagent_fork]

    - id: tool-subagent-fork
      name: dsh-subagent-model/spawn
      config:
        provider: fork
        toolName: subagent_fork
        backgroundMode: continuable
        maxDepth: 1
        toolFilter:
          deny: [subagent, subagent_fork]
```

Select your local preset for a **new session** (and optionally make it the default). Existing sessions keep their original preset generation. Verify that both tool schemas now require `model` and enumerate your configured routes. If `model` is missing, the stock frontend is still running; editing the allowlist cannot affect it. Remove `inherit/current` to forbid inheritance.

### Depth is not a child permission

`maxDepth` is an absolute per-start cap: root depth is 0, its child is 1. `0` forbids even the first child; `1` permits a direct child. The default remains `3` for compatibility. **The cap is not an inherited ceiling.** A child can bypass one tool’s cap through a different frontend with a larger cap.

Use `toolFilter` to deny both `subagent` and `subagent_fork` inside each child. DSH enforces this on execution as well as schema visibility, including PTC bindings, and persists the filter for continuable cold resume. Keep the stock `send_message` available for reporting. Names must exist in the inherited tool surface; if your preset omits fork, omit that name from the filter too. Add any custom delegation aliases or other agent-creation tools your preset exposes, or use an explicit `allow` list of worker tools. This is tool-surface restriction, not a sandbox against trusted plugins directly calling runtime services.

Forcing the parent’s delegation choices also requires replacing or disabling **every** alternate delegation frontend; filtering children alone does not close a stock fork bypass in the parent.

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

- `routes` — the complete allowlist, spelled `provider/model-id`, plus the optional `inherit/current` entry. Only the *first* `/` splits a provider route, so a model id may itself contain slashes. Defaults to `[inherit/current]`. For Agent Teams `spawn_teammate`, the first concrete route (the first entry other than `inherit/current`) is the route forced onto the teammate.
- `efforts` — effort per route. A route absent from the map, or set to `provider/default`, sends no explicit effort — and for `inherit/current` that means following the calling turn's own effort. Any other value must be an effort that exact model advertises; an unadvertised id is refused **before** any provider call rather than clamped. An explicit effort on `inherit/current` overrides the inherited one, so you can follow the model but pin the effort.

Both are read at **every** tool call, so an edit applies to the next delegation with no restart.

## Behavior worth knowing

- **An empty allowlist unregisters the tool.** It never falls back to the parent's model — silently inheriting is the exact behavior this plugin exists to prevent. The prompt section still states the rule so the model can explain the refusal.
- **A route that no longer resolves is skipped with a warning**, and the remaining routes keep working. If none resolve, the tool is unregistered.
- **The model cannot choose an effort.** There is no effort argument, and a child never inherits the parent's.
- **Settings are re-read inside `execute`**, so a schema captured a step ago cannot authorize a route you removed since.
- **Foreground calls are marked concurrency-unsafe**, because they share one parent-matched effort reservation slot.
- **Each named provider is listed before its routes are resolved.** `resolveModelInfo` is not required to discover capabilities itself: an adapter may answer it from a cache that only `listModels` fills, and report a static fallback list while that cache is cold. Without listing first, an effort the provider genuinely accepts is refused as unadvertised. Only providers your allowlist names are listed, so a delegation never wakes an unrelated adapter.

## Config reference

| Field | Default | Meaning |
|---|---|---|
| `provider` | `spawn` | The `ctx.subagents` provider to start children on |
| `toolName` | `subagent` | Model-facing tool name; must be unique among live tools |
| `backgroundMode` | `continuable` | `continuable` returns a durable subagent id reachable by `send_message`; `one-shot` defaults to waiting |
| `persona` | — | Optional per-child persona shadowing the deployment persona |
| `maxDepth` | `3` | Absolute per-start depth cap; `0` disables starts, `1` permits direct children, `provider-managed` sends none |
| `toolFilter` | — | Child `{ allow?: string[], deny?: string[] }`; use `deny: [subagent, subagent_fork]` to prevent nested delegation in a preset exposing both tools |

## Seeing which model a subagent ran on

Each `subagent` call in the transcript renders one line: a state dot (running / done / failed), the word Subagent, the route the child runs on, and the call's short description.

It is read-only and adds no logic. The route is the `model` argument the tool already requires, so nothing new is logged or computed. A call whose arguments cannot be read — still streaming, interrupted, or made by the shipped frontend, which has no `model` argument — renders the ordinary summary and claims no model rather than guessing one.

The row claims the `subagent` tool name. A keyed tool view replaces the generic row rather than decorating it, so this is a deliberate takeover of that one name; every other tool keeps its shipped rendering. Setting a different `toolName` in the spawn row means calls fall back to the generic row.

## Steering a running subagent

**On current DSH, keep the stock `send_message`: it already supports next-step steering and cold resume.** The following describes the optional legacy `lib/control.js` replacement for older runtimes, not a required part of model/depth enforcement:

```yaml
    - id: tool-subagent-control
      name: dsh-subagent-model/control
```

The shipped tool routes every delivery through `ctx.subagents.followup()`, which calls `Agent.followup()` and therefore targets `next-turn`. For a child that is mid-turn — running tools, one per step — the message is accepted and then waits for the whole turn to end, so a correction aimed at work in flight arrives after that work is done. Measured in a real session: a child counting to ten with one bash step per turn had a steer accepted at +7.4s and claimed at +54.9s, a 47.5-second stall.

This version calls `Agent.steer()` for a running direct child, which targets `next-step` and is consumed at the next step boundary. Everything else is delegated to the native service unchanged: an idle, waiting, or absent child (it owns waking and cold resume), and any authority mismatch (it owns the authoritative rejection). Ownership accounting and settlement are untouched.

The result reports which path ran, as `delivery: 'next-step'` or `'next-turn'`, so the model can tell whether a correction joined the current turn.

A steer that races settlement is not silently lost: disposal clears the inbox, so if the child leaves the registry in the same tick, the delivery falls back to the native path.

## Routes

| Route | Purpose |
|---|---|
| `GET /subagent-model/catalog` | The model catalog the settings card reads: every route with its native input modalities and advertised reasoning efforts, plus the `inherit/current` entry. Registered through a nested plugin injecting `webServer`, so the package still mounts in profiles with no web server. |

## Tests

```sh
npm test
```

Run `npm run test:runtime` with current DSH packages resolvable to require the runtime suites (missing imports fail rather than skip). `child-policy.test.mjs` exercises actual DSH child composition, execution filtering, and descriptor snapshots; it is not a full cold-resume end-to-end test. `policy.test.mjs` and `reservations.test.mjs` are dependency-free — the route, effort, and reservation-matching rules are pure and need no harness. `integration.test.mjs` mounts the tool on a real Cordis context with the real `ToolRuntime`/`SubagentRuntime` and asserts against a capture provider that the built `SubagentStartRequest` carries the chosen route, including that the seeded inherit route reproduces the shipped behavior. `defaults.test.mjs` pins the behavior-neutral seed. `client-card.test.mjs` exercises the browser card without a browser — it supplies a module loader and a React stub that records the element tree, then asserts the slot registration, that nothing is written before Save, that Save writes `efforts` before `routes`, and that a removed route takes its effort with it. It also pins every theme token the card names against the set the Theme provider publishes, because an invented token cannot fail loudly — CSS falls through to the literal fallback, so a typo renders the card unreadable rather than erroring. The harness-dependent suites self-skip when those packages are not resolvable.

### Historical live end-to-end check (pre-preset composition)

The overlay below predates standing presets. **Do not use it to patch a current preset:** follow the local-preset installation above instead. These historical results are not verification of a current live deployment.

`tests/live-headless.patch.yml` runs the real thing: it disables the profile's
shipped `tool-subagent` row, mounts this frontend in its place, and pins the
PARENT to a route that is not on the allowlist, so a child reaching the chosen
model proves the route was forced rather than inherited.

```sh
dsh plugin --profile headless add /path/to/dsh-subagent-model
dsh --profile headless --patch tests/live-headless.patch.yml \
  "Use the subagent tool once with model antigravity/gemini-3.7-flash and prompt 'name your model'."
```

Verified on a real run: with the parent on `unlimited/claude-sonnet-5` and the
allowlist forcing `antigravity/gemini-3.7-flash` at `high`, the child's durable
`request/header` recorded `provider: antigravity`, `model: gemini-3.7-flash`,
`reasoningEffort: high` — so the effort bridge reaches the actual request, not
just the tool's label — and the child reported itself as Gemini 3.7 Flash.
Naming a route the user removed is refused by the schema enum before execution.

The parent route is pinned in the patch layer, but a `agent-default-model` block
in `~/.dsh/settings.yaml` outranks it: set that to the same route, or remove it,
or the run boots on whichever provider settings names.

## Designed, not built

[`docs/refork-spec.md`](docs/refork-spec.md) specifies `refork_subagent`: continue a stalled or wrong-model child's **whole** conversation on a different route, by copying its completed-turn history into a new child rather than resuming the old one on a model that did not produce it.

The spec is complete enough to implement from — every mechanism is cited in current source, the load-bearing assumption is measured on a real stalled child, and the two unverified risks are marked. Two constraints are worth knowing before asking for it: a child killed mid-turn loses that partial turn, because a seed must end at a `turn/end`; and combining a seeded child with continuable mode is a combination the shipped `fork` provider deliberately avoids, so it needs measuring first.

## Known limitations

- **The frontend must be mounted in your selected preset.** The host settings panel alone never enforces model or depth policy. New preset compositions apply to new sessions, not existing conversations.
- **Alternate delegation tools are separate policy paths.** Replace or disable them too. Child filters cover the inherited tools named in the filter, not arbitrary trusted child-local plugin registrations.
- **`lib/client.js` is a hand-written lazy-CJS factory.** The repository's `tsdown` client preset is not published, so an out-of-tree package must reproduce that artifact format itself. The card therefore uses `React.createElement` directly and draws its own chrome — the client bundle-purity gate rejects value imports across plugins, so it cannot reuse the shipped card components.
- **The card needs the catalog route to offer choices.** Without a web server the settings namespace still works from YAML; the picker and effort dropdowns are simply empty.
- **One tool row per provider.** Two rows sharing a `toolName` collide at registration, by design.
