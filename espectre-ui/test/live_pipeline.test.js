'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { spawn } = require('node:child_process')
const path = require('node:path')
const { PresenceEngine } = require('../presence_engine')
const delay = ms => new Promise(r => setTimeout(r, ms))

test('unready samples preserve raw score, and invalid samples do not advance state', () => {
  const engine = new PresenceEngine()
  assert.equal(engine.update({ score: 0.8 }, false, false).motion_score, 0.8)
  assert.equal(engine.update({ score: NaN }, true, false).motion_score, 0.8)
})

test('device SSE → engine → API/SSE, initial readiness, rejection, reconnect, and polling', { timeout: 18000 }, async t => {
  let attempts = 0, ready = true, stream
  const device = http.createServer((req, res) => {
    if (req.url.endsWith('/events')) {
      attempts++
      if (attempts === 1) { res.writeHead(503); res.end('Direct event client limit reached'); return }
      stream = res
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(': connected\r\n\r\n')
    } else {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(req.url.endsWith('/sensing') ? { ready, calibrating: false } : {device_id: 'test'}))
    }
  })
  await new Promise(r => device.listen(0, '127.0.0.1', r))
  const backend = spawn(process.execPath, [path.join(__dirname, '../server.js')], {
    env: { ...process.env, DEVICE_IP: '127.0.0.1', DEVICE_PORT: String(device.address().port), PORT: '0' },
  })
  t.after(() => { backend.kill(); stream?.destroy(); device.closeAllConnections(); device.close() })
  const port = await new Promise((resolve, reject) => {
    backend.on('error', reject)
    backend.stdout.on('data', d => { const match = d.toString().match(/localhost:(\d+)/); if (match) resolve(match[1]) })
  })
  const base = `http://localhost:${port}`
  async function snap() { return (await fetch(`${base}/api/presence`)).json() }
  async function until(predicate) {
    for (let i = 0; i < 100; i++) { const value = await snap(); if (predicate(value)) return value; await delay(75) }
    assert.fail('timed out waiting for live state')
  }
  await until(s => s.stream_status === 'waiting' && s.sensor_status === 'healthy')
  assert.equal(attempts, 2)
  const controller = new AbortController()
  const browser = await fetch(`${base}/api/events`, { signal: controller.signal })
  t.after(() => controller.abort())
  const reader = browser.body.getReader()
  await reader.read() // initial snapshot
  for (let i = 0; i < 20; i++) stream.write('event: motion\r\ndata: {"score":1,\r\ndata: "state":"motion"}\r\n\r\n')
  const moving = await until(s => s.presence_state === 'PRESENT_MOVING')
  assert.equal(moving.motion_score, 1)
  assert.ok(moving.smoothed_motion_score > 0.9)
  assert.equal(moving.activity, 'ACTIVITY_HIGH')
  let browserData = ''
  while (!browserData.includes('PRESENT_MOVING')) browserData += new TextDecoder().decode((await reader.read()).value)
  assert.match(browserData, /smoothed_motion_score/)
  for (let i = 0; i < 25; i++) stream.write('event: motion\ndata: {"score":0}\n\n')
  const quiet = await until(s => s.presence_state === 'PRESENT_STATIONARY')
  assert.ok(quiet.smoothed_motion_score < moving.smoothed_motion_score)
  assert.equal(quiet.activity, 'ACTIVITY_LOW')
  stream.destroy()
  await until(s => s.stream_status === 'disconnected')
  await until(s => s.stream_status === 'connected')
  assert.ok(attempts >= 3)
  ready = false
  await until(s => s.sensor_status === 'not_ready' && s.presence_state === 'UNKNOWN')
  assert.equal((await fetch(`${base}/api/presence`)).headers.get('cache-control'), 'no-store')
})
