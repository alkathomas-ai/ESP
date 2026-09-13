'use strict'
const crypto = require('node:crypto')
const argon2 = require('argon2')
const OPTIONS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 }
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const random = () => crypto.randomBytes(32).toString('hex')
const cookieName = 'espectre_admin'
const lifetime = 8 * 60 * 60 * 1000

function auth(store) {
  function token(req) { return (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '='))?.slice(cookieName.length + 1) || '' }
  function session(req) {
    const now = Date.now()
    store.db.prepare('DELETE FROM sessions WHERE expires<=? OR touched<=?').run(now, now - 30 * 60 * 1000)
    const key = digest(token(req))
    const row = store.db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(key)
    if (row) store.db.prepare('UPDATE sessions SET touched=? WHERE token_hash=?').run(now, key)
    return row
  }
  function cookie(res, value, age) {
    res.setHeader('Set-Cookie', `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${process.env.ADMIN_SECURE_COOKIE === '1' ? '; Secure' : ''}`)
  }
  function requireAdmin(req) {
    const current = session(req)
    if (!current) throw Object.assign(new Error('Admin login required'), { status: 401 })
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-csrf-token'] !== current.csrf) {
      throw Object.assign(new Error('Invalid CSRF token'), { status: 403 })
    }
    return current
  }
  return {
    session, requireAdmin,
    async login(req, res, password) {
      const ip = req.socket.remoteAddress || 'unknown'
      if (!store.limit('login:' + ip, 5, 60000) || !store.limit('login:global', 20, 60000)) {
        throw Object.assign(new Error('Too many login attempts. Try again in one minute.'), { status: 429 })
      }
      const hash = store.get('admin_hash')
      if (!hash) throw Object.assign(new Error('Run npm run admin:setup on the backend computer first.'), { status: 503 })
      if (typeof password !== 'string' || password.length > 1024 || !await argon2.verify(hash, password)) {
        throw Object.assign(new Error('Invalid administrator password'), { status: 401 })
      }
      store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token(req)))
      const raw = random(), csrf = random(), now = Date.now()
      store.db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(digest(raw), csrf, now + lifetime, now)
      cookie(res, raw, lifetime / 1000)
      return { authenticated: true, csrf }
    },
    logout(req, res) {
      store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token(req)))
      cookie(res, '', 0)
    },
  }
}
module.exports = { auth, OPTIONS }
