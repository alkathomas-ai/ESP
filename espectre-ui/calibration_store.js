'use strict'

/**
 * Calibration store — persists per-device baseline results to a JSON file.
 * Device identity key is the ESPectre device id (hex string from mDNS/device endpoint).
 */

const fs   = require('fs')
const path = require('path')

const STORE_PATH = path.join(__dirname, 'calibration_store.json')

function load () {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function save (store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8')
}

function get_calibration (device_id) {
  if (!device_id) return null
  return load()[device_id] ?? null
}

function set_calibration (device_id, result) {
  if (!device_id || !result) return
  const store = load()
  store[device_id] = { ...result, device_id, saved_at: Date.now() }
  save(store)
}

function clear_calibration (device_id) {
  if (!device_id) return
  const store = load()
  delete store[device_id]
  save(store)
}

module.exports = { get_calibration, set_calibration, clear_calibration }
