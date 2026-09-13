'use strict'
const readline = require('node:readline')
const { Writable } = require('node:stream')
const argon2 = require('argon2')
const { openStore } = require('./store')
const { OPTIONS } = require('./auth')
async function main() {
  if (!process.stdin.isTTY) throw new Error('Run this command in an interactive terminal.')
  let muted = false
  const output = new Writable({ write(chunk, encoding, done) { if (!muted) process.stdout.write(chunk, encoding); done() } })
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true })
  async function password(label) {
    process.stdout.write(label)
    muted = true
    const value = await new Promise(resolve => rl.question('', resolve))
    muted = false
    process.stdout.write('\n')
    return value
  }
  try {
    const first = await password('New admin password (at least 12 characters): ')
    const second = await password('Confirm password: ')
    if (first.length < 12 || first.length > 1024 || first !== second) throw new Error('Passwords must match and contain 12–1024 characters.')
    const hash = await argon2.hash(first, OPTIONS)
    const store = openStore()
    store.db.transaction(() => { store.set('admin_hash', hash); store.db.prepare('DELETE FROM sessions').run() })()
    store.db.close()
    console.log('Admin password saved as an Argon2id hash. Existing sessions revoked.')
  } finally { rl.close() }
}
main().catch(err => { console.error(err.message); process.exitCode = 1 })
