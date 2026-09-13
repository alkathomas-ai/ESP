'use strict'

const http    = require('http')
const fs      = require('fs')
const path    = require('path')
const { URL } = require('url')

const { PresenceEngine }              = require('./presence_engine.js')
const { get_calibration, set_calibration } = require('./calibration_store.js')
const { openStore }                   = require('./admin/store')
const { auth }                        = require('./admin/auth')
const { testEndpoint, deviceOperation } = require('./admin/devices')

// ── Configuration ─────────────────────────────────────────────────────────────

const ROOT        = __dirname
const DIST        = path.join(ROOT, 'dist')
const ADMIN_DIR   = path.join(ROOT, 'admin')
const SERVER_PORT = Number(process.env.PORT || 3000)
const ESPECTRE_ORIGIN = 'https://espectre.dev'

// ── Admin store + auth (singletons) ──────────────────────────────────────────

const store    = openStore()
const adminAuth = auth(store)

// ── Active device state ───────────────────────────────────────────────────────
// Falls back to env vars so existing single-device setups keep working.

let active_device = (() => {
  const saved_id = store.get('active_device_id')
  if (saved_id) {
    const row = store.device(saved_id)
    if (row) return row
  }
  const ip   = process.env.DEVICE_IP   || '192.168.0.103'
  const port = process.env.DEVICE_PORT || '62587'
  return { endpoint: `http://${ip}:${port}`, name: 'default', id: null }
})()

function device_base() { return active_device.endpoint }

// ── Presence engine (singleton) ───────────────────────────────────────────────

const engine = new PresenceEngine()

let sensor_ready      = false
let sensor_calibrating = false
let device_id         = null
let last_sensing      = null
const sse_clients     = new Set()

// ── Device SSE consumer ───────────────────────────────────────────────────────

let device_sse_req     = null
let reconnect_delay_ms = 1000
let stream_connected   = false
let samples_received   = 0
let last_stream_error  = null
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
    samples_received, last_stream_error,
    active_device: { endpoint: active_device.endpoint, name: active_device.name, id: active_device.id ?? null },
  }
}

function clear_telemetry() {
  engine.sensor_disconnected()
  sensor_ready      = false
  sensor_calibrating = false
  last_sensing      = null
  samples_received  = 0
  last_stream_error = null
  stream_connected  = false
  device_id         = null
}

function accept_sensing(evt) {
  sensor_ready      = evt.ready === true
  sensor_calibrating = evt.calibrating === true
  last_sensing      = evt
  if (!sensor_ready || sensor_calibrating) engine.sensor_not_ready()
  broadcast_sse('sensing', evt)
  broadcast_presence()
}

async function refresh_sensing() {
  try {
    const response = await fetch(`${device_base()}/espectre/v1/sensing`, {
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

function connect_device_sse() {
  const base = new URL(device_base())
  const req  = http.request({
    hostname: base.hostname, port: Number(base.port) || 80,
    path: '/espectre/v1/events', method: 'GET',
    headers: { Origin: ESPECTRE_ORIGIN, Accept: 'text/event-stream' },
  })
  device_sse_req = req
  const fail = err => {
    if (device_sse_req !== req) return
    device_sse_req    = null
    stream_connected  = false
    last_stream_error = err.message
    req.destroy()
    engine.sensor_disconnected()
    console.error('[SSE]', err.message)
    broadcast_presence()
    setTimeout(connect_device_sse, reconnect_delay_ms)
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
    stream_connected  = true
    last_stream_error = null
    reconnect_delay_ms = 1000
    console.log('[SSE] Connected to device', device_base())
    refresh_sensing()
    let buf = '', event_type = 'message', data = []
    res.setEncoding('utf8')
    res.on('data', chunk => {
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '')
        if (line === '') {
          if (data.length) handle_device_event(event_type, data.join('\n'))
          event_type = 'message'; data = []
        } else if (line.startsWith('event:')) event_type = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
    })
    res.on('end',  () => fail(new Error('device stream ended')))
    res.on('close',() => fail(new Error('device stream closed')))
    res.on('error', fail)
  })
  req.end()
}

function handle_device_event(type, raw) {
  let evt
  try { evt = JSON.parse(raw) } catch { return }
  if (type === 'sensing') { accept_sensing(evt); return }
  if (type === 'motion' || type === 'telemetry') {
    const now = Date.now()
    if (!Number.isFinite(evt.score)) { trace('invalid motion event', evt); return }
    samples_received++
    trace('ESPectre event received / engine input', { ...evt, sensor_ready, sensor_calibrating })
    engine.update(evt, sensor_ready, sensor_calibrating || engine.calibration_active, now)
    if (engine.calibration_active) {
      const cal_result = engine.calibration_sample(evt.score ?? 0, now)
      if (cal_result.done && cal_result.result?.valid && device_id) {
        set_calibration(device_id, cal_result.result)
        console.log(`[CAL] Calibration complete for device ${device_id}`)
      }
    }
    broadcast_sse('motion', evt)
    trace('presence-engine output', presence_snapshot())
    broadcast_presence()
    return
  }
  broadcast_sse(type, evt)
}

// ── Stale stream ticker ───────────────────────────────────────────────────────

setInterval(() => { engine.tick(); broadcast_presence() }, 1000)
setTimeout(async function poll() { await refresh_sensing(); setTimeout(poll, 3000) }, 3000)

function broadcast_presence() {
  trace('backend SSE output', presence_snapshot())
  broadcast_sse('presence', presence_snapshot())
}

function broadcast_sse(event_type, payload) {
  const data = `event: ${event_type}\ndata: ${JSON.stringify(payload)}\n\n`
  for (const client of sse_clients) {
    try { client.write(data) } catch { sse_clients.delete(client) }
  }
}

// ── Fetch device identity on startup ─────────────────────────────────────────

async function fetch_device_id() {
  try {
    const res  = await fetch(`${device_base()}/espectre/v1/device`, { headers: { Origin: ESPECTRE_ORIGIN } })
    const data = await res.json()
    device_id  = data.device_id ?? data.id ?? null
    if (device_id) {
      console.log(`[DEVICE] id=${device_id}`)
      const saved = get_calibration(device_id)
      if (saved?.valid) { engine.apply_calibration(saved); console.log(`[CAL] Restored calibration for device ${device_id}`) }
    }
  } catch {}
}

// ── Active-device hot switch ──────────────────────────────────────────────────

async function switch_device(row) {
  console.log(`[ADMIN] Switching active device → ${row.endpoint}`)
  // Tear down existing SSE connection
  if (device_sse_req) { const old = device_sse_req; device_sse_req = null; old.destroy() }
  clear_telemetry()
  reconnect_delay_ms = 1000
  active_device = row
  store.set('active_device_id', row.id)
  broadcast_presence()
  await Promise.all([fetch_device_id(), refresh_sensing()])
  connect_device_sse()
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function send_json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(payload))
}

function add_cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Origin, X-Requested-With, X-CSRF-Token')
}

function read_body(req) {
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

async function proxy_device(req, res, target_path) {
  const upstream = `${device_base()}${target_path}`
  const method   = req.method || 'GET'
  const incoming = await read_body(req)
  const body     = (method === 'GET' || method === 'DELETE') ? undefined : JSON.stringify(incoming)
  try {
    const response = await fetch(upstream, {
      method, headers: { 'Content-Type': req.headers['content-type'] || 'application/json', Origin: ESPECTRE_ORIGIN }, body,
    })
    const text = await response.text()
    res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' })
    res.end(text)
  } catch (err) {
    send_json(res, 502, { error: 'Cannot reach device', detail: err.message })
  }
}

// ── Static file server ────────────────────────────────────────────────────────

function static_serve(req, res) {
  const url  = new URL(req.url, `http://${req.headers.host}`)
  const safe = url.pathname === '/' ? '/index.html' : url.pathname
  const file = path.normalize(path.join(DIST, safe))
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end('Forbidden'); return }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return }
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
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

  // ── Admin UI page ───────────────────────────────────────────────────────
  if (p === '/admin' || p === '/admin/') {
    const file = path.join(ADMIN_DIR, 'admin.html')
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('Admin UI not found'); return }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(data)
    })
    return
  }

  // ── Admin API ───────────────────────────────────────────────────────────
  if (p.startsWith('/admin/api/')) {
    try {
      const sub = p.slice('/admin/api'.length)

      // Auth endpoints (no session required)
      if (sub === '/auth/login' && req.method === 'POST') {
        const body = await read_body(req)
        const result = await adminAuth.login(req, res, body.password)
        send_json(res, 200, result)
        return
      }
      if (sub === '/auth/logout' && req.method === 'POST') {
        adminAuth.logout(req, res)
        send_json(res, 200, { ok: true })
        return
      }
      if (sub === '/auth/session' && req.method === 'GET') {
        const s = adminAuth.session(req)
        send_json(res, 200, { authenticated: !!s, csrf: s?.csrf ?? null })
        return
      }

      // All routes below require admin session
      const session = adminAuth.requireAdmin(req)

      // Devices CRUD
      if (sub === '/devices' && req.method === 'GET') {
        send_json(res, 200, { devices: store.devices(), active_id: active_device.id ?? null })
        return
      }
      if (sub === '/devices' && req.method === 'POST') {
        const body = await read_body(req)
        const info = await testEndpoint(String(body.endpoint || ''))
        const row  = store.save(info)
        send_json(res, 200, { ok: true, device: row })
        return
      }
      const devMatch = sub.match(/^\/devices\/(\d+)$/)
      if (devMatch) {
        const id = Number(devMatch[1])
        if (req.method === 'DELETE') {
          store.db.prepare('DELETE FROM devices WHERE id=?').run(id)
          if (active_device.id === id) {
            active_device = { endpoint: `http://${process.env.DEVICE_IP || '192.168.0.103'}:${process.env.DEVICE_PORT || '62587'}`, name: 'default', id: null }
            store.set('active_device_id', null)
          }
          send_json(res, 200, { ok: true })
          return
        }
        if (req.method === 'POST' && sub.endsWith('/activate')) {
          // handled below
        }
      }
      const activateMatch = sub.match(/^\/devices\/(\d+)\/activate$/)
      if (activateMatch && req.method === 'POST') {
        const row = store.device(Number(activateMatch[1]))
        if (!row) { send_json(res, 404, { error: 'Device not found' }); return }
        await switch_device(row)
        send_json(res, 200, { ok: true, device: row })
        return
      }

      // Serial ports
      if (sub === '/serial' && req.method === 'GET') {
        const ports = await deviceOperation({ operation: 'serial' })
        send_json(res, 200, { ports })
        return
      }

      // mDNS discovery
      if (sub === '/discover' && req.method === 'GET') {
        const devices = await deviceOperation({ operation: 'discover' })
        send_json(res, 200, { devices })
        return
      }

      // Improv Serial provisioning
      if (sub === '/provision' && req.method === 'POST') {
        const body = await read_body(req)
        if (!body.port || !body.ssid || !body.password) {
          send_json(res, 400, { error: 'port, ssid, and password are required' }); return
        }
        const result = await deviceOperation({ operation: 'provision', port: body.port, ssid: body.ssid, password: body.password })
        // Auto-register the newly provisioned device
        let saved = null
        try { saved = await testEndpoint(result.endpoint); saved = store.save(saved) } catch {}
        send_json(res, 200, { ok: true, endpoint: result.endpoint, device: saved })
        return
      }

      // Test an endpoint
      if (sub === '/test-endpoint' && req.method === 'POST') {
        const body = await read_body(req)
        const info = await testEndpoint(String(body.endpoint || ''))
        send_json(res, 200, { ok: true, ...info })
        return
      }

      send_json(res, 404, { error: 'Unknown admin endpoint' })
    } catch (err) {
      send_json(res, err.status ?? 500, { error: err.message })
    }
    return
  }

  // ── /api/presence ───────────────────────────────────────────────────────
  if (p === '/api/presence') {
    const snap = presence_snapshot()
    trace('backend API output', snap)
    send_json(res, 200, snap)
    return
  }

  // ── /api/presence/config ────────────────────────────────────────────────
  if (p === '/api/presence/config') {
    if (req.method === 'GET') { send_json(res, 200, engine.config); return }
    if (req.method === 'PATCH') {
      const body    = await read_body(req)
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

  // ── /api/calibration ────────────────────────────────────────────────────
  if (p === '/api/calibration') {
    if (req.method === 'GET') {
      send_json(res, 200, { active: engine.calibration_active,
        progress: engine.calibration_active ? engine.snapshot().calibration : null,
        result: engine.calibration_result, device_id })
      return
    }
    if (req.method === 'POST') {
      const body = await read_body(req)
      if (!body.confirmed) { send_json(res, 400, { ok: false, reason: 'confirmation_required', message: 'Set confirmed:true to confirm the monitored area is empty.' }); return }
      if (!sensor_ready)   { send_json(res, 409, { ok: false, reason: 'sensor_not_ready' }); return }
      const result = engine.calibration_start()
      send_json(res, result.ok ? 200 : 409, result)
      return
    }
    if (req.method === 'DELETE') { engine.calibration_abort(); send_json(res, 200, { ok: true }); return }
  }

  // ── /api/events ─────────────────────────────────────────────────────────
  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' })
    res.write(`event: presence\ndata: ${JSON.stringify(presence_snapshot())}\n\n`)
    sse_clients.add(res)
    req.on('close', () => sse_clients.delete(res))
    return
  }

  // ── Device proxy routes ─────────────────────────────────────────────────
  if (p.startsWith('/api/wifi/credentials') || p.startsWith('/api/wifi/bssid')) {
    return proxy_device(req, res, p.replace(/^\/api/, '/espectre/v1'))
  }
  if (p.startsWith('/api/sensing/calibrations')) return proxy_device(req, res, '/espectre/v1/sensing/calibrations')
  if (p.startsWith('/api/sensing'))              return proxy_device(req, res, '/espectre/v1/sensing')
  if (p.startsWith('/api/wifi'))                 return proxy_device(req, res, '/espectre/v1/wifi')
  if (p.startsWith('/api/health'))               return proxy_device(req, res, '/espectre/v1/health')
  if (p.startsWith('/api/device'))               return proxy_device(req, res, '/espectre/v1/device')

  static_serve(req, res)
})

// ── Startup ───────────────────────────────────────────────────────────────────

server.listen(SERVER_PORT, async () => {
  console.log(`ESPectre presence backend running at http://localhost:${server.address().port}`)
  console.log(`Device: ${device_base()}`)
  console.log(`Admin UI: http://localhost:${server.address().port}/admin`)
  connect_device_sse()
  await Promise.all([fetch_device_id(), refresh_sensing()])
})
