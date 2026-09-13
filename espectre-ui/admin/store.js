'use strict'
const fs = require('node:fs')
const path = require('node:path')
const Database = require('better-sqlite3')

function openStore(filename = process.env.ADMIN_DB || path.join(__dirname, '../data/admin.sqlite')) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  const db = new Database(filename)
  fs.chmodSync(filename, 0o600)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE,
      device_id TEXT, chip TEXT, frontend TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL, touched INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, until_ms INTEGER NOT NULL);
  `)
  return {
    db,
    get(key) { const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.value) : null },
    set(key, value) { db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, JSON.stringify(value)) },
    devices() { return db.prepare('SELECT * FROM devices ORDER BY id').all() },
    device(id) { return db.prepare('SELECT * FROM devices WHERE id=?').get(id) },
    save(device) {
      db.prepare(`INSERT INTO devices(name,endpoint,device_id,chip,frontend) VALUES (@name,@endpoint,@device_id,@chip,@frontend)
        ON CONFLICT(endpoint) DO UPDATE SET name=excluded.name,device_id=excluded.device_id,chip=excluded.chip,frontend=excluded.frontend`).run(device)
      return db.prepare('SELECT * FROM devices WHERE endpoint=?').get(device.endpoint)
    },
    limit(key, maximum, windowMs) {
      const now = Date.now()
      db.prepare('DELETE FROM limits WHERE until_ms<=?').run(now)
      const row = db.prepare('SELECT * FROM limits WHERE key=?').get(key)
      if (row && row.count >= maximum) return false
      db.prepare(`INSERT INTO limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1`).run(key, now + windowMs)
      return true
    },
  }
}
module.exports = { openStore }
