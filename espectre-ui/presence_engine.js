'use strict'

/**
 * Temporal Presence Engine
 *
 * Consumes a stream of ESPectre motion events and produces a higher-level
 * presence state. The existing MotionState (idle/motion) is preserved as the
 * low-level motion source; this engine adds a temporal layer on top.
 *
 * Presence states:
 *   UNKNOWN            – startup, sensor unhealthy, stale stream, calibrating
 *   PRESENT_MOVING     – sustained motion evidence above moving threshold
 *   PRESENT_STATIONARY – motion subsided after confirmed presence
 *   POSSIBLE_EMPTY     – prolonged quiet after known presence
 *
 * Activity states (independent):
 *   ACTIVITY_UNKNOWN   – sensor unhealthy or not ready
 *   ACTIVITY_LOW       – smoothed score < low_threshold
 *   ACTIVITY_MEDIUM    – smoothed score < medium_threshold
 *   ACTIVITY_HIGH      – smoothed score >= medium_threshold
 *
 * People count: always UNKNOWN (one ESP32 link cannot count people).
 */

// ── Default configuration ────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  // Motion score thresholds (0..1)
  moving_enter_threshold: 0.55,   // score must exceed this to count as motion
  moving_exit_threshold:  0.40,   // score must drop below this to leave MOVING
  activity_low_threshold: 0.20,
  activity_medium_threshold: 0.50,

  // Temporal confirmation (number of consecutive evaluation windows)
  moving_enter_windows: 3,        // consecutive windows above threshold → MOVING
  moving_exit_windows:  4,        // consecutive windows below threshold → leave MOVING

  // Hold durations in milliseconds
  stationary_hold_ms:   120_000,  // stay PRESENT_STATIONARY for at least 2 min after motion stops
  possible_empty_quiet_ms: 300_000, // 5 min of quiet after known presence → POSSIBLE_EMPTY

  // Stale stream detection
  stale_stream_ms: 10_000,        // no event for 10 s → stream considered stale

  // Exponential smoothing factor for motion score (0 < alpha <= 1)
  // Lower = more smoothing, higher = more responsive
  smoothing_alpha: 0.15,

  // Spike rejection: a single window above threshold does not count
  // (handled by moving_enter_windows >= 2)
}

// ── State machine constants ──────────────────────────────────────────────────

const PresenceState = Object.freeze({
  UNKNOWN:             'UNKNOWN',
  PRESENT_MOVING:      'PRESENT_MOVING',
  PRESENT_STATIONARY:  'PRESENT_STATIONARY',
  POSSIBLE_EMPTY:      'POSSIBLE_EMPTY',
})

const ActivityState = Object.freeze({
  ACTIVITY_UNKNOWN: 'ACTIVITY_UNKNOWN',
  ACTIVITY_LOW:     'ACTIVITY_LOW',
  ACTIVITY_MEDIUM:  'ACTIVITY_MEDIUM',
  ACTIVITY_HIGH:    'ACTIVITY_HIGH',
})

// ── Engine ───────────────────────────────────────────────────────────────────

class PresenceEngine {
  constructor (config = {}) {
    this._cfg = { ...DEFAULT_CONFIG, ...config }
    this._reset()
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Feed one ESPectre motion event.
   * @param {object} evt  { state: 'idle'|'motion', score: number, timestamp_ms: number }
   * @param {boolean} sensorReady  true when sensing.ready_to_publish is true
   * @param {boolean} calibrating  true when startup calibration is running
   * @param {number}  nowMs        wall-clock ms (injectable for tests)
   */
  update (evt, sensorReady, calibrating, nowMs = Date.now()) {
    if (!Number.isFinite(evt.score)) return this.snapshot()
    this._raw_score = evt.score
    this._last_event_ms = nowMs

    if (!sensorReady || calibrating) {
      this._reset_to_unknown('sensor_not_ready')
      return this.snapshot()
    }

    const raw_score = typeof evt.score === 'number' ? evt.score : 0
    this._smoothed = this._cfg.smoothing_alpha * raw_score +
                     (1 - this._cfg.smoothing_alpha) * this._smoothed
    this._raw_score = raw_score

    this._advance_state(nowMs)
    return this.snapshot()
  }

  /**
   * Call periodically (e.g. every second) to detect stale streams.
   * @param {number} nowMs
   */
  tick (nowMs = Date.now()) {
    if (this._last_event_ms !== null &&
        nowMs - this._last_event_ms > this._cfg.stale_stream_ms) {
      this._reset_to_unknown('stale_stream')
    }
    return this.snapshot()
  }

  /** Mark sensor as disconnected / unhealthy. */
  sensor_disconnected () {
    this._reset_to_unknown('sensor_disconnected')
    return this.snapshot()
  }

  sensor_not_ready () {
    this._reset_to_unknown('sensor_not_ready')
  }

  /** Return current state snapshot (plain object, safe to JSON.stringify). */
  snapshot () {
    return {
      presence_state:       this._presence,
      activity:             this._activity(),
      people_count:         'UNKNOWN',
      motion_score:         round4(this._raw_score),
      smoothed_motion_score: round4(this._smoothed),
      reason:               this._reason,
      last_event_age_ms:    this._last_event_ms !== null
                              ? Math.max(0, Date.now() - this._last_event_ms)
                              : null,
      calibration:          this._calibration_info(),
    }
  }

  // ── Calibration ────────────────────────────────────────────────────────────

  /**
   * Begin empty-room calibration.
   * Caller must have already verified user confirmation.
   * @param {number} nowMs
   */
  calibration_start (nowMs = Date.now()) {
    if (this._cal.active) return { ok: false, reason: 'already_running' }
    this._cal = {
      active: true,
      confirmed: true,
      start_ms: nowMs,
      samples: [],
      duration_ms: 30_000,
      result: null,
    }
    this._presence = PresenceState.UNKNOWN
    this._reason = 'calibration_in_progress'
    return { ok: true }
  }

  /**
   * Feed a score sample during calibration.
   * Returns { done, result } when calibration completes.
   */
  calibration_sample (score, nowMs = Date.now()) {
    if (!this._cal.active) return { done: false }
    this._cal.samples.push(score)
    const elapsed = nowMs - this._cal.start_ms
    if (elapsed >= this._cal.duration_ms) {
      return this._calibration_finish(nowMs)
    }
    return { done: false, elapsed_ms: elapsed, sample_count: this._cal.samples.length }
  }

  calibration_abort () {
    this._cal = empty_cal()
    this._reason = 'calibration_aborted'
  }

  get calibration_active () { return this._cal.active }
  get calibration_result () { return this._cal.result }

  /**
   * Apply a previously stored calibration result to derive adaptive thresholds.
   * @param {object} result  output of _calibration_finish
   */
  apply_calibration (result) {
    if (!result || !result.valid) return
    const { p95, mad } = result
    // Adaptive moving threshold: baseline P95 + 2×MAD, clamped to [0.3, 0.85]
    const adaptive_moving = clamp(p95 + 2 * mad, 0.30, 0.85)
    const adaptive_exit   = clamp(p95 + mad,     0.20, 0.75)
    this._cfg.moving_enter_threshold = adaptive_moving
    this._cfg.moving_exit_threshold  = adaptive_exit
    this._cal.result = result
  }

  get config () { return { ...this._cfg } }

  // ── Private ────────────────────────────────────────────────────────────────

  _reset () {
    this._presence      = PresenceState.UNKNOWN
    this._reason        = 'startup'
    this._smoothed      = 0
    this._raw_score     = 0
    this._last_event_ms = null
    // Consecutive window counters
    this._above_count   = 0   // windows above moving_enter_threshold
    this._below_count   = 0   // windows below moving_exit_threshold
    // Timestamps for hold logic
    this._motion_stopped_ms  = null  // when we last left PRESENT_MOVING
    this._last_presence_ms   = null  // last time we were in PRESENT_MOVING
    this._cal = empty_cal()
  }

  _reset_to_unknown (reason) {
    this._presence    = PresenceState.UNKNOWN
    this._reason      = reason
    this._above_count = 0
    this._below_count = 0
  }

  _advance_state (nowMs) {
    const score = this._smoothed
    const cfg   = this._cfg

    const above_threshold = score > cfg.moving_enter_threshold
    const below_exit      = score < cfg.moving_exit_threshold

    // Update consecutive counters
    if (above_threshold) {
      this._above_count++
      this._below_count = 0
    } else if (below_exit) {
      this._below_count++
      this._above_count = 0
    } else {
      // In hysteresis band — don't reset either counter
    }

    switch (this._presence) {

      case PresenceState.UNKNOWN:
      case PresenceState.POSSIBLE_EMPTY:
        if (this._above_count >= cfg.moving_enter_windows) {
          this._presence = PresenceState.PRESENT_MOVING
          this._last_presence_ms = nowMs
          this._motion_stopped_ms = null
          this._reason = 'sustained_motion_detected'
        } else {
          this._reason = this._presence === PresenceState.UNKNOWN
            ? 'insufficient_motion_evidence'
            : 'prolonged_quiet_after_known_presence'
        }
        break

      case PresenceState.PRESENT_MOVING:
        this._last_presence_ms = nowMs
        if (this._below_count >= cfg.moving_exit_windows) {
          this._presence = PresenceState.PRESENT_STATIONARY
          this._motion_stopped_ms = nowMs
          this._reason = 'motion_subsided_after_confirmed_presence'
        } else {
          this._reason = 'sustained_motion_active'
        }
        break

      case PresenceState.PRESENT_STATIONARY: {
        // Still in stationary hold?
        const held_ms = nowMs - (this._motion_stopped_ms ?? nowMs)
        if (this._above_count >= cfg.moving_enter_windows) {
          // Motion returned
          this._presence = PresenceState.PRESENT_MOVING
          this._last_presence_ms = nowMs
          this._motion_stopped_ms = null
          this._reason = 'motion_resumed_after_stationary'
        } else if (held_ms >= cfg.stationary_hold_ms) {
          // Hold expired — check if we should go to POSSIBLE_EMPTY
          const quiet_ms = nowMs - (this._last_presence_ms ?? nowMs)
          if (quiet_ms >= cfg.possible_empty_quiet_ms) {
            this._presence = PresenceState.POSSIBLE_EMPTY
            this._reason = 'prolonged_quiet_after_known_presence'
          } else {
            this._reason = `stationary_hold_active_${Math.round(held_ms / 1000)}s`
          }
        } else {
          this._reason = `stationary_hold_active_${Math.round(held_ms / 1000)}s`
        }
        break
      }
    }
  }

  _activity () {
    if (this._presence === PresenceState.UNKNOWN) return ActivityState.ACTIVITY_UNKNOWN
    const s = this._smoothed
    if (s >= this._cfg.activity_medium_threshold) return ActivityState.ACTIVITY_HIGH
    if (s >= this._cfg.activity_low_threshold)    return ActivityState.ACTIVITY_MEDIUM
    return ActivityState.ACTIVITY_LOW
  }

  _calibration_info () {
    if (!this._cal.active && !this._cal.result) return null
    if (this._cal.active) {
      return {
        status: 'running',
        elapsed_ms: this._cal.start_ms ? Date.now() - this._cal.start_ms : 0,
        sample_count: this._cal.samples.length,
        duration_ms: this._cal.duration_ms,
      }
    }
    return { status: this._cal.result?.valid ? 'complete' : 'failed', ...this._cal.result }
  }

  _calibration_finish (nowMs) {
    const samples = this._cal.samples
    if (samples.length < 10) {
      this._cal.active = false
      this._cal.result = { valid: false, reason: 'insufficient_samples', sample_count: samples.length }
      this._reason = 'calibration_failed'
      return { done: true, result: this._cal.result }
    }

    const sorted = [...samples].sort((a, b) => a - b)
    const n = sorted.length
    const mean = samples.reduce((s, v) => s + v, 0) / n
    const median = sorted[Math.floor(n / 2)]
    const deviations = sorted.map(v => Math.abs(v - median))
    deviations.sort((a, b) => a - b)
    const mad = deviations[Math.floor(n / 2)]
    const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / n
    const std = Math.sqrt(variance)
    const p90 = sorted[Math.floor(n * 0.90)]
    const p95 = sorted[Math.floor(n * 0.95)]
    const p99 = sorted[Math.floor(n * 0.99)]

    // Scores near zero can have high relative variation while remaining quiet.
    // Assess absolute spread and the upper tail instead of dividing by the mean.
    const { valid, stability, checks } = assessCalibration({ std, p95, p99 })

    const result = {
      valid,
      sample_count: n,
      duration_ms: nowMs - this._cal.start_ms,
      mean: round4(mean),
      median: round4(median),
      std: round4(std),
      mad: round4(mad),
      variance: round4(variance),
      p90: round4(p90),
      p95: round4(p95),
      p99: round4(p99),
      stability: round4(stability),
      validation: { version: 2, checks, limits: { ...CALIBRATION_LIMITS } },
      timestamp_ms: nowMs,
      reason: valid ? 'ok' : 'unstable_baseline',
    }

    this._cal.active = false
    this._cal.result = result

    if (valid) {
      this.apply_calibration(result)
      this._reason = 'calibration_complete'
    } else {
      this._reason = 'calibration_failed_unstable'
    }

    return { done: true, result }
  }
}

// Initial engineering limits for the firmware's 0..1 motion score. These are
// independent of previously calibrated thresholds, so retries cannot relax them.
// Validate across more rooms before treating them as universal noise limits.
const CALIBRATION_LIMITS = Object.freeze({ std: 0.15, p95: 0.40, p99: 0.55 })

function assessCalibration({ std, p95, p99 }) {
  const checks = {
    absolute_spread: Number.isFinite(std) && std >= 0 && std <= CALIBRATION_LIMITS.std,
    quiet_upper_tail: Number.isFinite(p95) && p95 >= 0 && p95 <= CALIBRATION_LIMITS.p95,
    motion_spikes: Number.isFinite(p99) && p99 >= p95 && p99 <= CALIBRATION_LIMITS.p99,
  }
  // Display-only spread score, not a probability or a second acceptance gate.
  const stability = Number.isFinite(std) ? clamp(1 - std / 0.25, 0, 1) : 0
  return { valid: Object.values(checks).every(Boolean), stability, checks }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function empty_cal () {
  return { active: false, confirmed: false, start_ms: null, samples: [], duration_ms: 30_000, result: null }
}

function clamp (v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
function round4 (v) { return Math.round(v * 10000) / 10000 }

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = { PresenceEngine, PresenceState, ActivityState, DEFAULT_CONFIG, assessCalibration }
