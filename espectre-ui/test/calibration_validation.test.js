'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { PresenceEngine, assessCalibration } = require('../presence_engine')

test('reported empty-room summary passes absolute limits despite a high std/mean ratio', () => {
  // User-provided summary, not a replay: raw empty-room samples were not supplied.
  const result = assessCalibration({ std: 0.0995, p95: 0.2999, p99: 0.4957 })
  assert.equal(result.valid, true)
  assert.ok(Math.abs(result.stability - 0.602) < 0.00001)
})

test('previous strongly contaminated baseline remains rejected', () => {
  assert.equal(assessCalibration({ std: 0.3494, p95: 0.9988, p99: 1 }).valid, false)
})

test('quiet near-zero variation passes; high constant scores and upper-tail spikes fail', () => {
  assert.equal(assessCalibration({ std: 0.002, p95: 0.006, p99: 0.008 }).valid, true)
  for (const summary of [
    { std: 0, p95: 1, p99: 1 },
    { std: 0.16, p95: 0.3, p99: 0.5 },
    { std: 0.10, p95: 0.41, p99: 0.5 },
    { std: 0.10, p95: 0.3, p99: 0.8 },
    { std: NaN, p95: 0.1, p99: 0.2 },
  ]) assert.equal(assessCalibration(summary).valid, false)
})

function calibrate(engine, score) {
  engine.calibration_start(0)
  let result
  for (let i = 0; i <= 120; i++) result = engine.calibration_sample(score(i), i * 250)
  return result.result
}

test('accepted calibration applies thresholds; rejected walking preserves them', () => {
  const engine = new PresenceEngine()
  const quiet = calibrate(engine, i => i % 4 === 0 ? 0.08 : 0.002)
  assert.equal(quiet.valid, true)
  assert.equal(quiet.validation.version, 2)
  const config = engine.config
  const walking = calibrate(engine, () => 0.99)
  assert.equal(walking.valid, false)
  assert.equal(walking.reason, 'unstable_baseline')
  assert.deepEqual(engine.config, config)
})
