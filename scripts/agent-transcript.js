#!/usr/bin/env node
/**
 * Condense a `kiro-cli chat --output-format stream-json` log (ACP events, one per
 * line) into a readable transcript: the agent's text, each tool call with its
 * status, and for JustRunMe tools the status/verdict/next_action they returned.
 * Local paths are replaced by placeholders. Used for KIRO_LOG and the T25 records.
 *
 *   node scripts/agent-transcript.js <run.jsonl> [--workspace <dir>]
 */

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { workspace: { type: 'string' } } })
const scrub = (s) => {
  let out = String(s)
  if (values.workspace) out = out.split(values.workspace).join('$WS').split('/private' + values.workspace).join('$WS')
  return out.replace(/\/(Users|home)\/[^/\s"]+/g, '~')
}

const calls = new Map()
const order = []
let text = ''
const flushText = () => {
  if (text.trim()) order.push({ kind: 'text', text: text.trim() })
  text = ''
}

for (const line of readFileSync(positionals[0], 'utf8').split('\n')) {
  if (!line.trim()) continue
  let ev
  try {
    ev = JSON.parse(line)
  } catch {
    continue
  }
  if (ev.type === 'runError') {
    flushText()
    order.push({ kind: 'error', text: ev.data?.message })
  }
  const u = ev.data?.update
  if (!u) continue
  if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') text += u.content.text
  if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
    const id = u.toolCallId
    if (!calls.has(id)) {
      flushText()
      calls.set(id, { kind: 'tool', id, title: u.title, status: u.status, input: u.rawInput, output: null })
      order.push(calls.get(id))
    }
    const c = calls.get(id)
    if (u.title) c.title = u.title
    if (u.status) c.status = u.status
    if (u.rawInput) c.input = u.rawInput
    const content = (u.content ?? []).map((x) => x.content?.text ?? x.text ?? '').join('')
    if (u.rawOutput !== undefined) c.output = typeof u.rawOutput === 'string' ? u.rawOutput : JSON.stringify(u.rawOutput)
    else if (content) c.output = content
  }
}
flushText()

const summarize = (c) => {
  let parsed = null
  try {
    const raw = JSON.parse(c.output)
    const t = typeof raw?.response === 'string' ? raw.response : raw?.content?.[0]?.text ?? raw?.items?.[0]?.Json?.content?.[0]?.text
    parsed = typeof t === 'string' ? JSON.parse(t) : raw
  } catch {
    try {
      parsed = JSON.parse(c.output)
    } catch {
      parsed = null
    }
  }
  if (parsed && typeof parsed === 'object' && (parsed.status || parsed.verdict)) {
    const keys = ['status', 'verdict', 'reason', 'plan_id', 'request_id', 'next_action', 'matches_rehearsal', 'capture_id']
    const bits = keys.filter((k) => parsed[k] !== undefined && parsed[k] !== null).map((k) => `${k}=${parsed[k]}`)
    if (parsed.error?.code) bits.push(`error=${parsed.error.code}`)
    if (parsed.impact?.rows_lost) bits.push(`rows_lost=${JSON.stringify(parsed.impact.rows_lost)}`)
    return bits.join(' ')
  }
  return scrub(String(c.output ?? '').slice(0, 200)).replace(/\s+/g, ' ')
}

// No trailing whitespace: the transcript is committed and `git diff --check` must pass.
const print = (s) => console.log(s.split('\n').map((l) => l.trimEnd()).join('\n'))
for (const item of order) {
  if (item.kind === 'text') print(`AGENT: ${scrub(item.text)}\n`)
  else if (item.kind === 'error') print(`ERROR: ${scrub(item.text)}\n`)
  else {
    const input = item.input ? scrub(JSON.stringify(item.input)).slice(0, 300) : ''
    print(`TOOL ${item.title} [${item.status ?? '?'}] ${input}`)
    if (item.output) print(`  -> ${summarize(item)}`)
    print('')
  }
}
