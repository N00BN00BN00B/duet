#!/usr/bin/env node
/* Duet command line. Installed from Duet → Settings → Command line, run through Duet's own
   runtime (ELECTRON_RUN_AS_NODE), so it needs no Node.js on the machine. */
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const USER_DATA = process.env.DUET_USER_DATA || path.join(os.homedir(), 'Library', 'Application Support', 'Duet')

const HELP = `Duet — Claude Code and Codex in one window

Usage
  duet [folder]                 Open Duet on a project folder (default: here)
  duet "fix the failing test"   Start a chat in this folder and send it
  duet -p "prompt" [folder]     Same, explicit
  duet --draft "prompt"         Put the prompt in the message box without sending

Options
  --claude | --codex            Which agent starts the chat
  -m, --model <id>              Model to use
  -l, --list                    List recent chats
  -u, --usage                   Show today's usage and limits
  -v, --version                 Print the version
  -h, --help                    Show this help`

function fail(message) {
  process.stderr.write(`duet: ${message}\n`)
  process.exit(1)
}

function parse(argv) {
  const opts = { folder: null, prompt: null, draft: false, provider: null, model: null, list: false, usage: false }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) fail(`${a} needs a value`)
      return argv[++i]
    }
    if (a === '-h' || a === '--help') opts.help = true
    else if (a === '-v' || a === '--version') opts.version = true
    else if (a === '-l' || a === '--list') opts.list = true
    else if (a === '-u' || a === '--usage') opts.usage = true
    else if (a === '-p' || a === '--prompt') opts.prompt = next()
    else if (a === '--draft') {
      opts.prompt = next()
      opts.draft = true
    } else if (a === '--claude') opts.provider = 'claude'
    else if (a === '--codex') opts.provider = 'codex'
    else if (a === '-m' || a === '--model') opts.model = next()
    else if (a.startsWith('-')) fail(`unknown option ${a} (see duet --help)`)
    else rest.push(a)
  }
  // A lone argument that is an existing folder opens it; anything else is a prompt.
  for (const arg of rest) {
    const full = path.resolve(arg)
    if (!opts.folder && fs.existsSync(full) && fs.statSync(full).isDirectory()) opts.folder = full
    else opts.prompt = opts.prompt ? `${opts.prompt} ${arg}` : arg
  }
  return opts
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

function list() {
  let metas = []
  try {
    metas = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'threads', 'index.json'), 'utf8'))
  } catch {
    fail('no chats yet (open Duet once first)')
  }
  const rows = metas
    .filter((m) => m && !m.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 25)
  if (!rows.length) return console.log('No chats yet.')
  for (const m of rows) {
    const agent = m.provider === 'codex' ? 'Codex ' : 'Claude'
    const project = path.basename(m.cwd || '') || '~'
    console.log(`${ago(m.updatedAt).padStart(4)}  ${agent}  ${String(m.title).slice(0, 60).padEnd(60)}  ${project}`)
  }
}

function usage() {
  let s = {}
  try {
    s = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'cache', 'limits.json'), 'utf8'))
  } catch {
    fail('no usage yet (open Duet and send a message first)')
  }
  for (const [provider, windows] of Object.entries(s)) {
    const label = provider === 'codex' ? 'Codex ' : 'Claude'
    const parts = (windows || []).map((w) => `${w.label} ${w.usedPercent}%`)
    console.log(`${label}  ${parts.join(' · ') || 'no limits reported'}`)
  }
}

function open(opts) {
  const params = new URLSearchParams()
  const cwd = opts.folder || process.cwd()
  params.set('cwd', cwd)
  if (opts.prompt) params.set('prompt', opts.prompt)
  if (opts.provider) params.set('provider', opts.provider)
  if (opts.model) params.set('model', opts.model)
  if (opts.prompt && !opts.draft) {
    // Proves the request came from this user's terminal, so Duet may send without asking.
    try {
      params.set('token', fs.readFileSync(path.join(USER_DATA, 'cli-token'), 'utf8').trim())
      params.set('send', '1')
    } catch {
      // No token yet: Duet shows the prompt as a draft instead of sending it.
    }
  }
  const res = spawnSync('open', [`duet://open?${params.toString()}`], { stdio: 'inherit' })
  if (res.status !== 0) fail('could not open Duet (is it in /Applications?)')
}

const opts = parse(process.argv.slice(2))
if (opts.help) console.log(HELP)
else if (opts.version) {
  try {
    const plist = fs.readFileSync(path.join(__dirname, '..', 'Info.plist'), 'utf8')
    console.log((/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist) || [])[1] || 'unknown')
  } catch {
    console.log('unknown')
  }
} else if (opts.list) list()
else if (opts.usage) usage()
else open(opts)
