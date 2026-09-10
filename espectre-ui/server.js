'use strict'

const http    = require('http')
const fs      = require('fs')
const path    = require('path')
const { spawn } = require('child_process')
const { URL }   = require('url')

const { PresenceEngine } = require('./presence_engine.js')
const { get_calibration, set_calibration } = require('./calibration_store.js')

// ── Configuration ─────────────────────────────────────────────────────────────

const ROOT        = __dirname
const DIST        = path.join(ROOT, 'dist')
const DEVICE_IP   = process.env.DEVICE_IP   || '192.168.0.103'
const DEVICE_PORT = Number(process.env.DEVICE_PORT || 62587)
const SERVER_PORT = Number(process.env.PORT || 3000)
const ESPECTRE_ORIGIN = 'https://espectre.dev'
const REPO_ROOT   = path.resolve(ROOT, '..', 'espectre')
const FLASH_CMD   = path.join(REPO_ROOT, 'espectre')

const DEVICE_BASE = `http://${DEVICE_IP}:${DEVICE_PORT}`

// ── Presence engine (singleton) ───────────────────────────────────────────────

const engine = new PresenceEngine()

// Runtime state consumed by the engine
let sensor_ready     = false
let sensor_calibrating = false
let device_id        = null   // populated from /device endpoint
let last_sensing     = null   // latest /sensing snapshot

// SSE client registry for /api/events (browser clients)
const sse_clients = new Set()

// ── Device SSE consumer ───────────────────────────────────────────────────────

let device_sse_req = null
let reconnect_delay_ms = 1000
let stream_connected = false
let samples_received = 0
let last_stream_error = null
const DEBUG_LIVE = process.env.DEBUG_LIVE === '1'
const MAX_RECONNECT_DELAY_MS = 30_000
function trace(stage, value) {
  if (DEBUG_LIVE) console.log(`[live] ${stage}`, JSON.stringify(value))
}

function presence_snapshot() {
  const snap = engine.snapshot()
  return { ...snap, sensor_status: sensor_ready && !sensor_calibrating ? 'healthy' : 'not_ready',
    stream_status: !stream_connected ? 'disconnected' : snap.last_event_age_ms === null ? 'waiting' :
      snap.last_event_age_ms > engine.config.stale_stream_ms ? 'stale' : 'connected',
    samples_received, last_stream_error }
}

function accept_sensing(evt) {
  sensor_ready = evt.ready === true
  sensor_calibrating = evt.calibrating === true
  last_sensing = evt
  if (!sensor_ready || sensor_calibrating) engine.sensor_not_ready()
  broadcast_sse('sensing', evt)
  broadcast_presence()
}

async function refresh_sensing() {
  try {
    const response = await fetch(`${DEVICE_BASE}/espectre/v1/sensing`, {
      headers: { Origin: ESPECTRE_ORIGIN }, signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) throw new Error(`sensing HTTP ${response.status}`)
    accept_sensing(await response.json())
  } catch (err) {
    sensor_ready = false
    engine.sensor_not_ready()
    trace('sensing unavailable', err.message)
    broadcast_presence()
  }
}

function connect_device_sse () {
  const req = http.request({ hostname: DEVICE_IP, port: DEVICE_PORT,
    path: '/espectre/v1/events', method: 'GET',
    headers: { Origin: ESPECTRE_ORIGIN, Accept: 'text/event-stream' },
  })
  device_sse_req = req
  const fail = err => {
    if (device_sse_req !== req) return
    device_sse_req = null
    stream_connected = false
    last_stream_error = err.message
    req.destroy()
    engine.sensor_disconnected()
    console.error('[SSE]', err.message)
    broadcast_presence()
    setTimeout(() => {
      connect_device_sse()
    }, reconnect_delay_ms)
    reconnect_delay_ms = Math.min(reconnect_delay_ms * 2, MAX_RECONNECT_DELAY_MS)
  }
  req.setTimeout(15000, () => fail(new Error('event stream timeout')))
  req.on('error', fail)
  req.on('response', res => {
    if (res.statusCode !== 200 || !res.headers['content-type']?.includes('text/event-stream')) {
      res.resume()
      fail(new Error(`event stream rejected: HTTP ${res.statusCode}`))
      return
    }
    stream_connected = true
    last_stream_error = null
    reconnect_delay_ms = 1000
    console.log('[SSE] Connected to device')
    refresh_sensing()
    let buf = ''
    let event_type = 'message'
    let data = []
    res.setEncoding('utf8')
    res.on('data', chunk => {
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '')
        if (line === '') {
          if (data.length) handle_device_event(event_type, data.join('\n'))
          event_type = 'message'
          data = []
        } else if (line.startsWith('event:')) event_type = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
    })
    res.on('end', () => fail(new Error('device stream ended')))
    res.on('close', () => fail(new Error('device stream closed')))
    res.on('error', fail)
  })
  req.end()
}

function handle_device_event (type, raw) {
  let evt
  try { evt = JSON.parse(raw) } catch { return }

  if (type === 'sensing') {
    accept_sensing(evt)
    return
  }

  if (type === 'motion' || type === 'telemetry') {
    // Feed into presence engine
    const now = Date.now()
    if (!Number.isFinite(evt.score)) {
      trace('invalid motion event', evt)
      return
    }
    samples_received++
    trace('ESPectre event received / engine input', { ...evt, sensor_ready, sensor_calibrating })
    engine.update(evt, sensor_ready, sensor_calibrating || engine.calibration_active, now)

    // If calibration is active, feed the score as a calibration sample
    if (engine.calibration_active) {
      const cal_result = engine.calibration_sample(evt.score ?? 0, now)
      if (cal_result.done && cal_result.result?.valid && device_id) {
        set_calibration(device_id, cal_result.result)
        console.log(`[CAL] Calibration complete for device ${device_id}`)
      }
    }

    // Forward original motion event to browser (unchanged — preserves existing chart)
    broadcast_sse('motion', evt)
    // Also broadcast enriched presence event
    trace('presence-engine output', presence_snapshot())
    broadcast_presence()
    return
  }

  // Forward any other event types unchanged
  broadcast_sse(type, evt)
}

// ── Stale stream ticker ───────────────────────────────────────────────────────

setInterval(() => {
  engine.tick()
  broadcast_presence()
}, 1000)

// Poll because readiness can change without a configuration SSE event.
setTimeout(async function poll() {
  await refresh_sensing()
  setTimeout(poll, 3000)
}, 3000)

function broadcast_presence () {
  const snap = presence_snapshot()
  trace('backend SSE output', snap)
  broadcast_sse('presence', snap)
}

// ── SSE broadcast to browser clients ─────────────────────────────────────────

function broadcast_sse (event_type, payload) {
  const data = `event: ${event_type}\ndata: ${JSON.stringify(payload)}\n\n`
  for (const client of sse_clients) {
    try { client.write(data) } catch { sse_clients.delete(client) }
  }
}

// ── Fetch device identity on startup ─────────────────────────────────────────

async function fetch_device_id () {
  try {
    const res = await fetch(`${DEVICE_BASE}/espectre/v1/device`, {
      headers: { Origin: ESPECTRE_ORIGIN },
    })
    const data = await res.json()
    device_id = data.device_id ?? data.id ?? null
    if (device_id) {
      console.log(`[DEVICE] id=${device_id}`)
      // Restore calibration if available
      const saved = get_calibration(device_id)
      if (saved?.valid) {
        engine.apply_calibration(saved)
        console.log(`[CAL] Restored calibration for device ${device_id}`)
      }
    }
  } catch {
    // Device not reachable yet — will retry via SSE reconnect
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function send_json (res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(payload))
}

function add_cors (res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Origin, X-Requested-With')
}

function read_body (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) }
    })
    req.on('error', reject)
  })
}

async function proxy_device (req, res, target_path) {
  const upstream = `${DEVICE_BASE}${target_path}`
  const method   = req.method || 'GET'
  const incoming = await read_body(req)
  const body     = (method === 'GET' || method === 'DELETE') ? undefined : JSON.stringify(incoming)

  try {
    const response = await fetch(upstream, {
      method,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
        Origin: ESPECTRE_ORIGIN,
      },
      body,
    })
    const text = await response.text()
    res.writeHead(response.status, {
      'Content-Type': response.headers.get('content-type') || 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    })
    res.end(text)
  } catch (err) {
    send_json(res, 502, { error: 'Cannot reach device', detail: err.message })
  }
}

// ── Static file server ────────────────────────────────────────────────────────

function static_serve (req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const safe = url.pathname === '/' ? '/index.html' : url.pathname
  const file = path.normalize(path.join(DIST, safe))
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end('Forbidden'); return }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return }
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.js':   'application/javascript; charset=utf-8',
      '.css':  'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg':  'image/svg+xml',
      '.png':  'image/png',
      '.ico':  'image/x-icon',
    }[path.extname(file)] || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': mime })
    res.end(data)
  })
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  add_cors(res)
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const url = new URL(req.url, `http://${req.headers.host}`)
  const p   = url.pathname

  // ── /api/presence — current presence state ──────────────────────────────
  if (p === '/api/presence') {
    const snap = presence_snapshot()
    trace('backend API output', snap)
    send_json(res, 200, snap)
    return
  }

  // ── /api/presence/config — read/update engine config ───────────────────
  if (p === '/api/presence/config') {
    if (req.method === 'GET') {
      send_json(res, 200, engine.config)
      return
    }
    if (req.method === 'PATCH') {
      const body = await read_body(req)
      // Only allow known numeric config keys
      const allowed = new Set(Object.keys(engine.config))
      const updates = {}
      for (const [k, v] of Object.entries(body)) {
        if (allowed.has(k) && typeof v === 'number') updates[k] = v
      }
      Object.assign(engine._cfg, updates)
      send_json(res, 200, engine.config)
      return
    }
  }

  // ── /api/calibration — empty-room calibration ──────────────────────────
  if (p === '/api/calibration') {
    if (req.method === 'GET') {
      send_json(res, 200, {
        active: engine.calibration_active,
        progress: engine.calibration_active ? engine.snapshot().calibration : null,
        result: engine.calibration_result,
        device_id,
      })
      return
    }

    if (req.method === 'POST') {
      const body = await read_body(req)
      // Require explicit user confirmation
      if (!body.confirmed) {
        send_json(res, 400, { ok: false, reason: 'confirmation_required',
          message: 'Set confirmed:true to confirm the monitored area is empty.' })
        return
      }
      if (!sensor_ready) {
        send_json(res, 409, { ok: false, reason: 'sensor_not_ready' })
        return
      }
      const result = engine.calibration_start()
      send_json(res, result.ok ? 200 : 409, result)
      return
    }

    if (req.method === 'DELETE') {
      engine.calibration_abort()
      send_json(res, 200, { ok: true })
      return
    }
  }

  // ── /api/events — SSE stream to browser (enriched) ─────────────────────
  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    // Send current presence state immediately on connect
    res.write(`event: presence\ndata: ${JSON.stringify(presence_snapshot())}\n\n`)
    sse_clients.add(res)
    req.on('close', () => sse_clients.delete(res))
    return
  }

  // ── /api/wifi/connect — Improv Serial provisioning ─────────────────────
  if (p.startsWith('/api/wifi/connect')) {
    if (req.method !== 'POST') { send_json(res, 405, { error: 'Use POST' }); return }
    const body = await read_body(req)
    const ssid = String(body.ssid || '')
    const password = String(body.password || '')
    if (!ssid || !password) {
      send_json(res, 400, { ok: false, log: 'SSID and password are required.' })
      return
    }
    const argv = [
      'provision',
      '--chip', body.chip || 's3',
      '--frontend', body.frontend || 'native',
      '--ssid', ssid,
      '--password-env', 'ESPECTRE_WIFI_PASSWORD',
      '--timeout', String(body.timeout || 60),
      '--port', body.port || '/dev/ttyACM0',
    ]
    const child = spawn(FLASH_CMD, argv, {
      cwd: REPO_ROOT, shell: false,
      env: { ...process.env, ESPECTRE_WIFI_PASSWORD: password },
    })
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    child.on('close', code => send_json(res, code === 0 ? 200 : 500,
      { ok: code === 0, code, log: out || 'Done.' }))
    return
  }

  // ── /api/flash ──────────────────────────────────────────────────────────
  if (p.startsWith('/api/flash')) {
    if (req.method !== 'POST') { send_json(res, 405, { error: 'Use POST' }); return }
    const body = await read_body(req)
    const argv = ['micro', 'flash', '--chip', body.chip || 's3', '--erase',
                  '--backend', body.backend || 'auto']
    if (body.pull) argv.push('--pull', body.pull)
    const child = spawn(FLASH_CMD, argv, { cwd: REPO_ROOT, shell: false, env: process.env })
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    child.on('close', code => send_json(res, code === 0 ? 200 : 500, { ok: code === 0, code, log: out }))
    return
  }

  // ── Device proxy routes ─────────────────────────────────────────────────
  if (p.startsWith('/api/wifi/credentials') || p.startsWith('/api/wifi/bssid')) {
    return proxy_device(req, res, p.replace(/^\/api/, '/espectre/v1'))
  }
  if (p.startsWith('/api/sensing/calibrations')) {
    return proxy_device(req, res, '/espectre/v1/sensing/calibrations')
  }
  if (p.startsWith('/api/sensing')) {
    return proxy_device(req, res, '/espectre/v1/sensing')
  }
  if (p.startsWith('/api/wifi')) {
    return proxy_device(req, res, '/espectre/v1/wifi')
  }
  if (p.startsWith('/api/health')) {
    return proxy_device(req, res, '/espectre/v1/health')
  }
  if (p.startsWith('/api/device')) {
    return proxy_device(req, res, '/espectre/v1/device')
  }

  static_serve(req, res)
})

// ── Startup ───────────────────────────────────────────────────────────────────

server.listen(SERVER_PORT, async () => {
  console.log(`ESPectre presence backend running at http://localhost:${server.address().port}`)
  console.log(`Device: http://${DEVICE_IP}:${DEVICE_PORT}`)
  connect_device_sse()
  await Promise.all([fetch_device_id(), refresh_sensing()])
})
