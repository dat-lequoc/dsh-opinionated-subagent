/**
 * Pure reservation ledger matching a forced model selection to the child agent
 * it belongs to.
 *
 * Kept free of Harness imports so the matching and release rules are exercised
 * without booting a profile; lib/effort.js wires it to the real events.
 *
 * Two keying strategies, because the two start paths differ:
 *   - A continuable start accepts a caller-reserved child id, so its selection
 *     is keyed by that exact id.
 *   - A foreground `start()` allocates the child id internally, so the only
 *     join available before the child's first request is its `parentSession`.
 *     That slot is single-valued: the tool marks foreground calls
 *     concurrency-unsafe, so at most one is in flight per fiber.
 *
 * Matching is destructive for the parent slot and non-destructive for keyed
 * ids: a keyed reservation is released when the child logs its first
 * `request/header`, after which the durable header is the authority.
 */

export function createReservations() {
  /** childSessionId -> forced selection. */
  const byChild = new Map()
  /** The one pending foreground reservation, or undefined. */
  let pendingParent

  return {
    /**
     * Reserve a selection for an exact child id.
     * @param childId - the caller-reserved child session id.
     * @param selection - `{ provider, model }` plus optional `reasoningEffort`.
     */
    reserve(childId, selection) {
      byChild.set(childId, selection)
    },

    /**
     * Reserve a selection for the next child published under one parent.
     * @param parentId - the calling agent's session id.
     * @param selection - `{ provider, model }` plus optional `reasoningEffort`.
     */
    reserveNextChildOf(parentId, selection) {
      pendingParent = { parentId, selection }
    },

    /**
     * Claim the selection a newly published child should run on.
     *
     * The keyed reservation wins: a continuable start reserves an exact id, and
     * a stale parent slot must never divert it. Claiming through the parent slot
     * consumes it so a later unrelated child cannot inherit that selection.
     *
     * @param childId - the published child's session id.
     * @param parentId - that child's durable `parentSession`, if any.
     * @returns the forced selection, or undefined when this child is not ours.
     */
    claim(childId, parentId) {
      const keyed = byChild.get(childId)
      if (keyed !== undefined) return keyed
      if (pendingParent !== undefined && parentId === pendingParent.parentId) {
        const { selection } = pendingParent
        pendingParent = undefined
        return selection
      }
      return undefined
    },

    /**
     * Release a reservation.
     * @param childId - the reserved child id, or undefined to clear the pending
     *   foreground slot after a start settled or failed.
     */
    release(childId) {
      if (childId === undefined) {
        pendingParent = undefined
        return
      }
      byChild.delete(childId)
    },

    /** Outstanding keyed reservations, for the runtime invariant and tests. */
    size() {
      return byChild.size + (pendingParent === undefined ? 0 : 1)
    },
  }
}
