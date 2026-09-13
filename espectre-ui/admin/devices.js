'use strict'
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const http = require('node:http')

function endpoint(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('Enter a valid http://host:port endpoint') }
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash ||
      !['/', '/espectre/v1', '/espectre/v1/'].includes(url.pathname)) throw new Error('Use an HTTP device origin without credentials, query, or extra path')
  return url.origin
}
function deviceJSON(base, route) {
  return new Promise((resolve, reject) => {
    const req = http.get(base + '/espectre/v1/' + route, { headers: { Origin: 'https://espectre.dev' } }, res => {
      let body = ''
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`${route}: HTTP ${res.statusCode}`)); return }
      res.setEncoding('utf8')
      res.on('data', part => { body += part; if (body.length > 65536) req.destroy(new Error('Device response too large')) })
      res.on('error', reject)
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch { reject(new Error(`${route}: invalid JSON`)) } })
    })
    const timer = setTimeout(() => req.destroy(new Error('Device request timed out')), 4000)
    req.on('close', () => clearTimeout(timer))
    req.on('error', reject)
  })
}
async function testEndpoint(value) {
  const base = endpoint(value)
  const [device, sensing, health] = await Promise.all(['device', 'sensing', 'health'].map(route => deviceJSON(base, route)))
  if (!device.device_id || typeof sensing.ready !== 'boolean' || health.status !== 'ok') throw new Error('Endpoint does not return the expected ESPectre device, sensing, and health contract')
  return { name: String(device.name || device.device_id).slice(0,100), endpoint: base,
    device_id: String(device.device_id), chip: String(device.chip || ''), frontend: String(device.frontend || '') }
}
let busy = false
function deviceOperation(request) {
  if (busy) return Promise.reject(Object.assign(new Error('Another device operation is running'), { status: 409 }))
  busy = true
  return new Promise((resolve, reject) => {
    const python = process.env.ESPECTRE_PYTHON || path.resolve(__dirname, '../../espectre/.venv/bin/python')
    if (!fs.existsSync(python)) { busy = false; reject(new Error('ESPectre Python environment missing. Set ESPECTRE_PYTHON.')); return }
    const child = spawn(python, [path.join(__dirname, 'device_helper.py')], { stdio: ['pipe', 'pipe', 'ignore'] })
    let output = ''
    const timer = setTimeout(() => child.kill(), request.operation === 'provision' ? 70000 : 12000)
    child.stdout.on('data', data => { output += data; if (output.length > 262144) child.kill() })
    child.stdin.on('error', () => {})
    child.on('error', () => { clearTimeout(timer); busy = false; reject(new Error('Cannot start ESPectre helper')) })
    child.on('close', code => {
      clearTimeout(timer); busy = false
      try {
        const result = JSON.parse(output)
        if (code !== 0 || !result.ok) throw new Error(result.error || 'Device operation failed')
        resolve(result.result)
      } catch { reject(new Error('Device operation failed. Check the USB data cable, firmware Improv support, and network access.')) }
    })
    // Password is sent over stdin, never command-line arguments, environment, SQLite, or logs.
    child.stdin.end(JSON.stringify(request))
  })
}
module.exports = { endpoint, testEndpoint, deviceOperation }
