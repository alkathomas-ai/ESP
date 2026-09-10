'use strict'

/**
 * Deterministic tests for PresenceEngine.
 * Run with: node test/presence_engine.test.js
 * No external test framework required.
 */

const { PresenceEngine, PresenceState, ActivityState } = require('../presence_engine.js')

let passed = 0
let failed = 0

function assert_eq(label, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}`)
    console.error(`    expected: ${JSON.stringify(expected)}`)
    console.error(`    actual:   ${JSON.stringify(actual)}`)
    failed++
  }
}

function assert_not_eq(label, actual, unexpected) {
  if (actual !== unexpected) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}: should not be ${JSON.stringify(unexpected)}`)
    failed++
  }
}

function make_evt(score) {
  return { score, state: score > 0.55 ? 'motion' : 'idle', timestamp_ms: Date.now() }
}

// Feed N events at 250 ms intervals starting at t0
function feed(engine, score, n, ready = true, calibrating = false, t0 = 1000) {
  let snap
  for (let i = 0; i < n; i++) {
    snap = engine.update(make_evt(score), ready, calibrating, t0 + i * 250)
  }
  return snap
}

// ── Test 1: Startup → UNKNOWN ─────────────────────────────────────────────────
console.log('\nTest 1: Startup → UNKNOWN')
{
  const e = new PresenceEngine()
  const snap = e.snapshot()
  assert_eq('initial state is UNKNOWN', snap.presence_state, PresenceState.UNKNOWN)
  assert_eq('initial activity is ACTIVITY_UNKNOWN', snap.activity, ActivityState.ACTIVITY_UNKNOWN)
  assert_eq('people_count is UNKNOWN', snap.people_count, 'UNKNOWN')
  assert_eq('reason is startup', snap.reason, 'startup')
}

// ── Test 2: Single motion spike → rejected ────────────────────────────────────
console.log('\nTest 2: Single motion spike → rejected (stays UNKNOWN)')
{
  const e = new PresenceEngine()
  const snap = e.update(make_evt(0.9), true, false, 1000)
  assert_eq('single spike stays UNKNOWN', snap.presence_state, PresenceState.UNKNOWN)
}

// ── Test 3: Sustained motion → PRESENT_MOVING ────────────────────────────────
console.log('\nTest 3: Sustained motion → PRESENT_MOVING')
{
  // Use alpha=1.0 so smoothed = raw immediately, making tests deterministic
  const e = new PresenceEngine({ smoothing_alpha: 1.0 })
  const snap = feed(e, 0.9, 5, true, false, 1000)
  assert_eq('sustained motion → PRESENT_MOVING', snap.presence_state, PresenceState.PRESENT_MOVING)
  assert_not_eq('activity not UNKNOWN when moving', snap.activity, ActivityState.ACTIVITY_UNKNOWN)
}

// ── Test 4: Motion stops after confirmed presence → PRESENT_STATIONARY ────────
console.log('\nTest 4: Motion stops → PRESENT_STATIONARY')
{
  const e = new PresenceEngine({ smoothing_alpha: 1.0 })
  feed(e, 0.9, 5, true, false, 1000)
  // Feed low scores for enough windows to exit MOVING (moving_exit_windows=4)
  const snap = feed(e, 0.1, 6, true, false, 10000)
  assert_eq('motion stops → PRESENT_STATIONARY', snap.presence_state, PresenceState.PRESENT_STATIONARY)
}

// ── Test 5: Stationary hold — does NOT immediately become POSSIBLE_EMPTY ──────
console.log('\nTest 5: Stationary hold — no immediate POSSIBLE_EMPTY')
{
  const e = new PresenceEngine({ smoothing_alpha: 1.0, stationary_hold_ms: 60_000 })
  feed(e, 0.9, 5, true, false, 1000)
  feed(e, 0.1, 6, true, false, 10000)
  // Feed quiet for 30 s (less than stationary_hold_ms=60s)
  const snap = feed(e, 0.02, 120, true, false, 20000)
  assert_eq('still PRESENT_STATIONARY after 30s quiet', snap.presence_state, PresenceState.PRESENT_STATIONARY)
}

// ── Test 6: Prolonged quiet → POSSIBLE_EMPTY ─────────────────────────────────
console.log('\nTest 6: Prolonged quiet → POSSIBLE_EMPTY')
{
  const e = new PresenceEngine({
    smoothing_alpha: 1.0,
    stationary_hold_ms: 1000,
    possible_empty_quiet_ms: 2000,
  })
  feed(e, 0.9, 5, true, false, 1000)
  feed(e, 0.1, 6, true, false, 10000)
  // Feed quiet past both hold durations (3 s total)
  const snap = feed(e, 0.02, 12, true, false, 20000)
  assert_eq('prolonged quiet → POSSIBLE_EMPTY', snap.presence_state, PresenceState.POSSIBLE_EMPTY)
}

// ── Test 7: Renewed motion from POSSIBLE_EMPTY → PRESENT_MOVING ──────────────
console.log('\nTest 7: Renewed motion from POSSIBLE_EMPTY → PRESENT_MOVING')
{
  const e = new PresenceEngine({
    smoothing_alpha: 1.0,
    stationary_hold_ms: 1000,
    possible_empty_quiet_ms: 2000,
  })
  feed(e, 0.9, 5, true, false, 1000)
  feed(e, 0.1, 6, true, false, 10000)
  feed(e, 0.02, 12, true, false, 20000)
  // Motion returns
  const snap = feed(e, 0.9, 5, true, false, 30000)
  assert_eq('renewed motion → PRESENT_MOVING', snap.presence_state, PresenceState.PRESENT_MOVING)
}

// ── Test 8: Stale stream → UNKNOWN ───────────────────────────────────────────
console.log('\nTest 8: Stale stream → UNKNOWN')
{
  const e = new PresenceEngine({ smoothing_alpha: 1.0, stale_stream_ms: 5000 })
  feed(e, 0.9, 5, true, false, 1000)
  // Tick 6 seconds after last event
  const snap = e.tick(1000 + 5 * 250 + 6000)
  assert_eq('stale stream → UNKNOWN', snap.presence_state, PresenceState.UNKNOWN)
  assert_eq('reason is stale_stream', snap.reason, 'stale_stream')
}

// ── Test 9: Sensor disconnected → UNKNOWN ────────────────────────────────────
console.log('\nTest 9: Sensor disconnected → UNKNOWN')
{
  const e = new PresenceEngine({ smoothing_alpha: 1.0 })
  feed(e, 0.9, 5, true, false, 1000)
  e.sensor_disconnected()
  const snap = e.snapshot()
  assert_eq('sensor disconnected → UNKNOWN', snap.presence_state, PresenceState.UNKNOWN)
  assert_eq('reason is sensor_disconnected', snap.reason, 'sensor_disconnected')
}

// ── Test 10: Sensor not ready → UNKNOWN ──────────────────────────────────────
console.log('\nTest 10: Sensor not ready → UNKNOWN')
{
  const e = new PresenceEngine({ smoothing_alpha: 1.0 })
  const snap = e.update(make_evt(0.95), false, false, 1000)
  assert_eq('sensor not ready → UNKNOWN', snap.presence_state, PresenceState.UNKNOWN)
  assert_eq('reason is sensor_not_ready', snap.reason, 'sensor_not_ready')
}

// ── Test 11: Calibrating → UNKNOWN ───────────────────────────────────────────
console.log('\nTest 11: Calibrating → UNKNOWN')
{
  const e = new PresenceEngine({ smoothing_alpha: 1.0 })
  const snap = e.update(make_evt(0.95), true, true, 1000)
  assert_eq('calibrating → UNKNOWN', snap.presence_state, PresenceState.UNKNOWN)
}

// ── Test 12: Activity LOW / MEDIUM / HIGH ────────────────────────────────────
console.log('\nTest 12: Activity levels')
{
  const e = new PresenceEngine({ smoothing_alpha: 1.0 })
  // Get to PRESENT_MOVING first so activity is not UNKNOWN
  feed(e, 0.9, 5, true, false, 1000)

  const low  = e.update(make_evt(0.10), true, false, 5000)
  assert_eq('score 0.10 → ACTIVITY_LOW',    low.activity,  ActivityState.ACTIVITY_LOW)

  const med  = e.update(make_evt(0.35), true, false, 5250)
  assert_eq('score 0.35 → ACTIVITY_MEDIUM', med.activity,  ActivityState.ACTIVITY_MEDIUM)

  const high = e.update(make_evt(0.75), true, false, 5500)
  assert_eq('score 0.75 → ACTIVITY_HIGH',   high.activity, ActivityState.ACTIVITY_HIGH)
}

// ── Test 13: people_count always UNKNOWN ─────────────────────────────────────
console.log('\nTest 13: people_count always UNKNOWN')
{
  const e = new PresenceEngine({ smoothing_alpha: 1.0 })
  feed(e, 0.9, 5, true, false, 1000)
  const snap = e.snapshot()
  assert_eq('people_count always UNKNOWN', snap.people_count, 'UNKNOWN')
}

// ── Test 14: Calibration requires confirmation (server-side gate) ─────────────
console.log('\nTest 14: Calibration engine starts when called')
{
  const e = new PresenceEngine()
  e.update(make_evt(0.1), true, false, 1000)
  const result = e.calibration_start(2000)
  assert_eq('calibration_start returns ok', result.ok, true)
  assert_eq('calibration_active is true', e.calibration_active, true)
  const snap = e.snapshot()
  assert_eq('presence is UNKNOWN during calibration', snap.presence_state, PresenceState.UNKNOWN)
}

// ── Test 15: Calibration collects samples and produces statistics ─────────────
console.log('\nTest 15: Calibration statistics')
{
  const e = new PresenceEngine()
  e.calibration_start(0)
  let cal_result
  for (let i = 0; i <= 125; i++) {
    // Stable low scores (empty room)
    const score = 0.05 + (i % 5) * 0.005
    const r = e.calibration_sample(score, i * 250)
    if (r.done) { cal_result = r.result; break }
  }
  assert_eq('calibration completes', cal_result !== undefined, true)
  assert_eq('calibration valid', cal_result?.valid, true)
  assert_eq('has median', typeof cal_result?.median, 'number')
  assert_eq('has mad', typeof cal_result?.mad, 'number')
  assert_eq('has p95', typeof cal_result?.p95, 'number')
  assert_eq('has sample_count', typeof cal_result?.sample_count, 'number')
  assert_eq('has stability', typeof cal_result?.stability, 'number')
}

// ── Test 16: Unstable calibration rejected ────────────────────────────────────
console.log('\nTest 16: Unstable calibration rejected')
{
  const e = new PresenceEngine()
  e.calibration_start(0)
  let cal_result
  for (let i = 0; i <= 125; i++) {
    // Wildly oscillating scores → unstable
    const score = i % 2 === 0 ? 0.02 : 0.98
    const r = e.calibration_sample(score, i * 250)
    if (r.done) { cal_result = r.result; break }
  }
  assert_eq('unstable calibration is invalid', cal_result?.valid, false)
}

// ── Test 17: CONFIRMED_EMPTY never emitted ────────────────────────────────────
console.log('\nTest 17: CONFIRMED_EMPTY never emitted')
{
  const e = new PresenceEngine({
    smoothing_alpha: 1.0,
    stationary_hold_ms: 100,
    possible_empty_quiet_ms: 200,
  })
  const states = new Set()
  feed(e, 0.9, 5, true, false, 1000)
  feed(e, 0.02, 20, true, false, 10000)
  for (const s of [e.snapshot()]) states.add(s.presence_state)
  assert_eq('CONFIRMED_EMPTY never emitted', states.has('CONFIRMED_EMPTY'), false)
}

// ── Test 18: Adaptive threshold applied from calibration ─────────────────────
console.log('\nTest 18: Adaptive threshold from calibration')
{
  const e = new PresenceEngine()
  const before = e.config.moving_enter_threshold
  e.apply_calibration({ valid: true, p95: 0.10, mad: 0.02, timestamp_ms: Date.now() })
  const after = e.config.moving_enter_threshold
  // adaptive = clamp(0.10 + 2*0.02, 0.30, 0.85) = 0.30
  assert_eq('adaptive threshold applied', after, 0.30)
  assert_not_eq('threshold changed from default', after, before)
}

// ── Test 19: Smoothed score is causal (no future data) ───────────────────────
console.log('\nTest 19: Smoothed score is causal')
{
  const e = new PresenceEngine({ smoothing_alpha: 0.5 })
  e.update(make_evt(0.0), true, false, 1000)
  const snap1 = e.update(make_evt(0.8), true, false, 1250)
  // smoothed = 0.5*0.8 + 0.5*0.0 = 0.4 (not 0.8)
  assert_eq('smoothed < raw after one step', snap1.smoothed_motion_score < snap1.motion_score, true)
}

// ── Test 20: No flickering — state stable under constant input ────────────────
console.log('\nTest 20: No flickering under constant input')
{
  const e = new PresenceEngine({ smoothing_alpha: 1.0 })
  feed(e, 0.9, 5, true, false, 1000)
  // Feed constant high score — should stay PRESENT_MOVING, not flicker
  const states = []
  for (let i = 0; i < 20; i++) {
    states.push(e.update(make_evt(0.9), true, false, 5000 + i * 250).presence_state)
  }
  const unique = new Set(states)
  assert_eq('constant motion stays PRESENT_MOVING', unique.size, 1)
  assert_eq('state is PRESENT_MOVING', [...unique][0], PresenceState.PRESENT_MOVING)
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.error('SOME TESTS FAILED')
  process.exit(1)
} else {
  console.log('ALL TESTS PASSED')
}
