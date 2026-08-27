import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createReservations } from '../lib/reservations.js'

const opus = { provider: 'kiro', model: 'claude-opus-5', reasoningEffort: 'high' }
const chat = { provider: 'deepseek', model: 'deepseek-chat' }

test('a keyed reservation is claimed by its exact child id', () => {
  const r = createReservations()
  r.reserve('child-1', opus)
  assert.equal(r.claim('child-1', 'parent-1'), opus)
})

test('an unrelated child claims nothing', () => {
  const r = createReservations()
  r.reserve('child-1', opus)
  assert.equal(r.claim('child-2', 'parent-1'), undefined)
})

test('a foreground reservation is claimed by the next child of that parent', () => {
  const r = createReservations()
  r.reserveNextChildOf('parent-1', chat)
  assert.equal(r.claim('any-child-id', 'parent-1'), chat)
})

test('a foreground reservation ignores a child of a different parent', () => {
  const r = createReservations()
  r.reserveNextChildOf('parent-1', chat)
  assert.equal(r.claim('child-x', 'parent-2'), undefined)
  assert.equal(r.claim('child-y', undefined), undefined)
})

test('a foreground slot is consumed so a later sibling cannot inherit it', () => {
  const r = createReservations()
  r.reserveNextChildOf('parent-1', chat)
  assert.equal(r.claim('child-1', 'parent-1'), chat)
  assert.equal(r.claim('child-2', 'parent-1'), undefined, 'second child reused a consumed slot')
})

test('a keyed reservation outranks a stale parent slot for the same parent', () => {
  const r = createReservations()
  r.reserveNextChildOf('parent-1', chat)
  r.reserve('child-1', opus)
  assert.equal(r.claim('child-1', 'parent-1'), opus)
  // The parent slot survives, because the keyed claim did not consume it.
  assert.equal(r.claim('child-2', 'parent-1'), chat)
})

test('a keyed reservation is repeatable until released', () => {
  const r = createReservations()
  r.reserve('child-1', opus)
  assert.equal(r.claim('child-1', 'parent-1'), opus)
  assert.equal(r.claim('child-1', 'parent-1'), opus)
  r.release('child-1')
  assert.equal(r.claim('child-1', 'parent-1'), undefined)
})

test('releasing undefined clears only the pending foreground slot', () => {
  const r = createReservations()
  r.reserve('child-1', opus)
  r.reserveNextChildOf('parent-1', chat)
  r.release(undefined)
  assert.equal(r.claim('child-9', 'parent-1'), undefined, 'foreground slot survived release')
  assert.equal(r.claim('child-1', 'parent-1'), opus, 'keyed reservation was wrongly dropped')
})

test('a failed start leaves no reservation behind', () => {
  const r = createReservations()
  r.reserve('child-1', opus)
  r.release('child-1')
  assert.equal(r.size(), 0)
})

test('the ledger does not grow across a settled continuable start', () => {
  const r = createReservations()
  r.reserve('child-1', opus)
  assert.equal(r.size(), 1)
  // request/header lands: the durable header is now authority.
  r.release('child-1')
  assert.equal(r.size(), 0)
})
