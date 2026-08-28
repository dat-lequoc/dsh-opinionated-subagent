# Spec: `refork_subagent` — continue a stalled child's full context on a new model

**Status:** design, not implemented. Every mechanism cited below was read in the current source or measured on this machine; the two places I am still uncertain are marked **UNVERIFIED**.

**Goal.** Take a continuable subagent that is stalled, interrupted, or ran on the wrong model, and continue its *entire* conversation on a different provider/model/effort — without corrupting the original transcript and without changing the harness.

---

## A. Why the obvious approach does not work

A continuable child's route is pinned at creation and replayed verbatim on every resume.

Creation writes it into the durable descriptor — `packages/subagent/subagent/src/continuation.ts:420-427`:

```js
const agentProvider = request.agentOptions?.provider ?? parent.options.provider
const agentModel = request.agentOptions?.model ?? parent.options.model
// ...
...agentProvider !== undefined ? { agentProvider } : {},
...agentModel !== undefined ? { agentModel } : {},
```

Cold resume reconstructs from **only** that descriptor — `continuation.ts:977-987`:

```js
activation = await this.materialize({
  childId,
  provider: descriptor.provider,
  parent,
  agentOptions: {
    ...descriptor.agentProvider !== undefined ? { provider: descriptor.agentProvider } : {},
    ...descriptor.agentModel !== undefined ? { model: descriptor.agentModel } : {},
  },
  composition: { persona: descriptor.persona, toolFilter: descriptor.toolFilter },
  signal: options.signal,
})
```

And `SubagentFollowupOptions` (`continuation.ts:149-155`) carries only `source` and `signal` — no route field:

```ts
export interface SubagentFollowupOptions {
  readonly source: MessageSource
  readonly signal: AbortSignal
}
```

So `send_message` **cannot** change the route, by design: the docstring at `continuation.ts:942-943` states "the descriptor is the whole reconstruction input."

That invariant is correct and this spec does not fight it. Resuming *the same session* on a different model would silently reattribute history one model produced to another, and would carry provider-specific opaque state (effort ids, cache checkpoints) across a route it does not belong to.

**Therefore: do not resume. Fork.** Create a *new* child whose durable prefix is a copy of the old child's history, and give that new child its own route. Two lineages, each honestly attributed.

---

## B. Why forking works

### B1. The seed is plain data, not a live-parent operation

The in-process driver accepts a seed as an ordinary array — `packages/subagent/subagent-in-process-driver/src/index.ts:67-71`:

```ts
export interface InProcessRunOptions {
  /** Completed-turn seed for fork, or undefined for a fresh spawn. */
  readonly seed?: SessionEvent[]
}
```

and passes it straight to agent creation — `index.ts:132-139`:

```js
const handle = await parent.ctx.agents.create({
  sessionId: childId,
  meta: childSessionMeta(parent, childDepth, activationBoundary),
  ...seed !== undefined ? { seed } : {},
  agentOptions: resolveChildAgentOptions(parent, request.agentOptions, childDepth),
  signal: request.signal,
  setup,
})
```

The shipped fork provider happens to build that array from a live parent (`subagent-fork-in-process/src/index.ts:48-54`), but **nothing in the contract requires it**. `CreateAgentOptions.seed` (`packages/core/agent/src/index.ts:102-109`) is declared as data with three obligations only:

> Initial replay/fork history. […] The complete seed must be contiguous from seq 0, carry only lossless-JSON data, and contain no open turn/step or dangling tool call.

### B2. Route and history are resolved independently

In the same `agents.create()` call above, `seed` and `agentOptions` are separate fields. `resolveChildAgentOptions` (`packages/subagent/subagent/src/child-agent.ts:68-83`) lets an explicit request override the parent's route:

```js
return {
  ...parentProvider !== undefined ? { provider: parentProvider } : {},
  ...parentModel !== undefined ? { model: parentModel } : {},
  ...parentMaxTokens !== undefined ? { maxTokens: parentMaxTokens } : {},
  ...requested,          // <- an explicit agentOptions wins
  subagentDepth: childDepth,
}
```

**This is the crux: a child can inherit transcript A while running on model B.**

### B3. The copied prefix becomes the new child's own durable history

`fork-in-process/src/index.ts:83-89` documents the property this design depends on:

> The fork prefix is captured ONCE, at creation: it becomes part of the child's own durable transcript, so a later cold resume replays that prefix instead of re-forking the parent's newer history.

So the reforked child is self-contained. Its own later resumes need nothing from the original.

### B4. Effort does not leak across the route change

`.agents/notes/implemented/architecture/2026-07-24-adapter-owned-reasoning-effort-capabilities.md:14`:

> A resumed loop retains the logged effort only when its initial provider/model route is unchanged; a route change discards the previous model's opaque id.

A refork onto a new provider therefore cannot carry the old model's effort id. Our own effort bridge (`lib/effort.js`) sets the new one explicitly.

---

## C. Measured evidence (run on this machine)

The load-bearing assumption — *a seed taken from a persisted session can create a live session* — was tested against the real stalled child `f5c72718-8e82-4248-becb-c4fac1c34ddd`.

**First attempt failed, and the reason matters.** Reading the `.jsonl.zstd` file directly:

```
persisted events: 217 | seq range: 0 -> 597
contiguous from 0: false
SEED REJECTED: seed event at index 17 has seq 45 (expected 17); seed must be contiguous from 0
```

The on-disk log is **not** the event log. 19 rows had no `seq` at all, of types `tool-call-chunks` (16) and `text-chunks` (3): streaming deltas are packed into single storage rows (`packages/session/session-persistence-jsonl/src/chunk-rows.ts:6-7`, "into ONE storage row […] and expands rows back to the exact original events").

**Reading through the persistence API instead succeeds:**

```
persistence.inspect(CHILD)
inspect events: 598
contiguous from 0: true
last turn/end seq: 597 of 597
prefix: 598 events; dropped tail: 0
SEEDED OK -> id: session-1 | live events: 599
tail marker: session/end-seed
```

Three facts established: `inspect()` rehydrates chunks into a contiguous log; the balanced prefix is accepted by the seed validator; and the new session gets a `session/end-seed` marker appended automatically (`packages/core/session/src/index.ts:545-547`).

**Rule for the implementation: never parse session files. Always go through `ctx.get('sessionPersistence').inspect(id)`.**

---

## D. Hard constraints

### D1. The seed must end at a `turn/end`

Enforced twice. The seed validator runs every event through `surfaceManager.validateNext` (`core/session/src/index.ts:531-535`), and the built-in session fork rejects an unbalanced boundary explicitly (`core/session/src/index.ts:1128-1135`):

```js
const lastTurnBoundary = events.slice(0, boundary + 1)
  .findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
if (lastTurnBoundary?.type === 'turn/start') {
  throw new SessionForkError(
    `fork boundary ${boundary} in session "${session.id}" ends inside open turn ${lastTurnBoundary.data.turn}`,
    'OPEN_TURN',
  )
}
```

**Consequence for the stated goal.** "Full context" means *all completed turns*, not the literal last bytes. A child killed mid-turn loses that partial turn — including the tool call it died inside. The tool must report how many events were dropped so the caller is never misled. For the measured child the dropped tail was 0, because it ended cleanly; an interrupted child will usually drop a tail.

### D2. A provider cannot supply this seed

`ContinuableCreateRequest` (`packages/subagent/subagent/src/types.ts:167-177`) carries only `sessionId`, `parent`, and `signal`. `ContinuableCreateSpec` (`types.ts:185-192`) returns only `seed`, and the provider is the one who computes it — a caller cannot inject one.

So `ctx.subagents.startContinuable()` **cannot** be told "use this seed." Two options follow, and this is the main design decision:

| Option | Mechanism | Cost |
|---|---|---|
| **D2a — own provider** | Register a `refork` provider whose `prepareContinuable` returns a seed it read from persistence, keyed by a pending request the tool set | Keeps `ctx.subagents` ownership of identity, ownership accounting, settlement, and cold resume. Needs a small keyed handoff between tool and provider, like `lib/effort.js` already does for effort |
| **D2b — direct `agents.create`** | Build the child agent ourselves with `seed` + `agentOptions` | Bypasses the continuation manager entirely: no ownership accounting, no settlement notice, no `send_message`, no appearance in `list_agents`. **Rejected** |

**Take D2a.** D2b produces a child the rest of the system does not know about.

### D3. Do not reuse the shipped `fork` provider

`fork-in-process/src/index.ts:77-82` carries a standing TODO:

> no shipped composition calls this — they bind fork to `backgroundMode: one-shot` because a continuable child's `report` tool and prompt section precede the inherited history, defeating the prefix reuse a fork exists for. Reopening needs a byte-identical child system prompt and tool schemas; see issue #2124.

So `fork` + `continuable` is a known-unsound combination in shipped compositions. Our provider is separate and must be tested for exactly this: whether `report`'s registration lands before the seeded history and how that affects the prefix. **UNVERIFIED — this is the main implementation risk and must be measured before the tool is published.**

### D4. Depth accounting

`resolveChildDepth` (`child-agent.ts:48-57`) is `parent depth + 1`, floored by the persisted parent header. A refork is a *new* child of the calling parent, so it costs one more level of depth — it does not reuse the stalled child's slot. With `maxDepth: 3`, reforking a depth-3 child from its depth-2 parent is fine; reforking from the child itself would exceed the cap and throw `SubagentDepthError`.

### D5. Lineage and the sidebar

`childSessionMeta` (`child-agent.ts:102-120`) stamps `parentSession`, `origin: 'subagent'`, `delegationDepth`, and `seedLength`. The reforked child's `parentSession` must be the **calling parent**, not the stalled child, or the Web sidebar will nest it under a session it is not owned by and `authorizeLineage` (`continuation.ts:963`) will reject later deliveries.


---

## E. What to build, step by step

Five files. Nothing in `/root/deepseek-harness` is touched.

### E1. `lib/seed.js` — pure prefix selection

No harness imports, so the balanced-prefix rule is unit-testable.

```js
/**
 * Select the balanced completed-turn prefix of a rehydrated event log.
 * @param events - contiguous events from persistence.inspect(), seq === index.
 * @returns { seed, dropped, turns } — seed is empty when no turn completed.
 */
export function completedTurnPrefix(events) {
  // Find the LAST turn/end. Everything after it is an open turn that the seed
  // validator rejects (core/session/src/index.ts:1128).
  let boundary = -1
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === 'turn/end') { boundary = i; break }
  }
  if (boundary === -1) return { seed: [], dropped: events.length, turns: 0 }
  const seed = events.slice(0, boundary + 1)
  return {
    seed,
    dropped: events.length - seed.length,
    turns: seed.filter(one => one.type === 'turn/end').length,
  }
}

/** Reject a log the seed validator would reject, with a caller-readable reason. */
export function assertSeedable(events) {
  for (const [index, event] of events.entries()) {
    if (event?.seq !== index) {
      throw new Error(
        `event at index ${index} has seq ${event?.seq}; a seed must be contiguous from 0 — `
        + 'read the session through sessionPersistence.inspect(), never from disk',
      )
    }
  }
}
```

### E2. `lib/refork-provider.js` — a provider that seeds from persistence

`prepareContinuable` receives no seed input (D2), so the tool reserves one per child id and the provider claims it — the same keyed-handoff pattern `lib/reservations.js` already uses for effort.

```js
export function createReforkProvider(name) {
  const pending = new Map()   // childId -> seed events
  return {
    provider: {
      name,
      capabilities: { outputSchema: false, depthLimit: true, toolFilter: true, persona: true },
      // Truthful: this child DOES see inherited history, so the tool's wording
      // must not claim a fresh context.
      inheritsParentContext: true,
      start() {
        throw new Error(`provider "${name}" serves continuable reforks only`)
      },
      prepareContinuable(request) {
        const seed = pending.get(request.sessionId)
        pending.delete(request.sessionId)
        return Promise.resolve(seed === undefined || seed.length === 0 ? {} : { seed })
      },
    },
    reserve(childId, seed) { pending.set(childId, seed) },
    release(childId) { pending.delete(childId) },
  }
}
```

`startContinuable` accepts a caller-reserved `childId` (`continuation.ts:112-130`, field `childId`), which is what makes the keying exact.

### E3. `lib/refork.js` — the tool

Arguments: `subagent_id` (the stalled child), `model` (from the same allowlist as `subagent`), `prompt` (what the new child should do now).

Execution order, each step justified:

1. `assertAllowlist` — reuse `selectRoute`/`resolveEffort` from `lib/policy.js` verbatim, after `refreshAllowlist()`. The route must be user-approved exactly as a fresh spawn's is.
2. `inspect(subagent_id)` through `ctx.get('sessionPersistence')`. **Not** the filesystem (C).
3. Authorize: `loaded.meta.parentSession === parent.id`, mirroring `authorizeLineage` (`continuation.ts:963`). Only the stalled child's own live parent may refork it. Reject otherwise, do not fall back.
4. `assertSeedable(loaded.events)`, then `completedTurnPrefix(loaded.events)`.
5. If `seed.length === 0`, fail with a message saying no turn ever completed and to spawn fresh instead. A zero-length seed is a fresh child wearing a misleading name.
6. Reserve the seed under a fresh `randomUUID()` childId, and reserve the effort for that same id through the existing `lib/effort.js` bridge.
7. `ctx.subagents.startContinuable({ provider: 'refork', label, childId, request, signal })` with `request.agentOptions = { provider, model }` and `request.parent = exec.agent`.
8. On any throw, release both reservations. Same rollback shape as `lib/spawn.js:349-352`.
9. Return `{ kind, subagentId, sourceSubagentId, model, effort, inheritedTurns, droppedEvents }`.

Returning `inheritedTurns` and `droppedEvents` is not decoration: it is the only way the caller learns that D1 truncated a partial turn.

### E4. Registration

`cordis.patch.yml` gains the provider row on the **host** plane (a provider name may be registered once per process):

```yaml
    - id: subagent-refork-provider
      name: dsh-subagent-model/refork-provider
```

The **tool** row is per-agent, so it belongs in the preset beside `tool-subagent`:

```yaml
    - id: tool-subagent-refork
      name: dsh-subagent-model/refork
      config:
        provider: refork
        toolName: refork_subagent
```

### E5. Tests

Dependency-free (`tests/seed.test.mjs`):
- a log ending at `turn/end` yields the whole log, `dropped: 0`
- a log ending mid-turn drops exactly the open tail
- a log with no `turn/end` yields an empty seed
- a sparse (unrehydrated) log is rejected by `assertSeedable` with the "use inspect()" message
- `turns` counts completed turns, not steps

Real-composition (`tests/refork.test.mjs`), a stub persistence plus the real `SubagentRuntime`:
- the reforked child's `agentOptions` is the **named** route, not the stalled child's and not the parent's
- the seed reaching `prepareContinuable` is exactly the balanced prefix
- a child of another parent is refused, and no child starts
- a route off the allowlist is refused, and no child starts
- a stalled child with no completed turn is refused with the spawn-fresh message
- a failed `startContinuable` leaves no seed and no effort reservation behind

Live (`UNVERIFIED` until run): refork the measured child `f5c72718` onto a different provider and confirm from the new child's own `request/header` that provider/model/effort are the new ones while `seedLength` equals the inherited prefix.

---

## F. What this does not do

- **It does not resume the original session.** The stalled child stays exactly as it is, still attributed to the model that produced it. That is deliberate (A).
- **It does not recover a partial turn** (D1).
- **It does not change the harness.** If a future harness release lets a caller pass a seed to `startContinuable`, E2's keyed handoff becomes unnecessary and should be deleted.
- **It does not deduplicate cost.** The new child re-reads the inherited transcript on its first request, so a large history is paid for again on the new provider.

## G. Open decisions for the requester

1. **Persona and tool filter** — copy from the stalled child's descriptor (faithful, but may carry whatever caused the stall) or take fresh ones? Default proposal: copy, with an optional override argument.
2. **A framing message** — should the new child be told "you are continuing prior work that stalled at X"? Raw history alone risks it repeating the failing step. Default proposal: the caller's `prompt` is required and is expected to say what changed.
