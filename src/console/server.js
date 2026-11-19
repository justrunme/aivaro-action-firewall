/**
 * JustRunMe Console (T27): a local HTTP server on 127.0.0.1, built on node:http only.
 *
 * Who can talk to it:
 *   - every /api request needs `Authorization: Bearer <token>`; the token is random per
 *     start and reaches the browser in the URL fragment, which is never sent to a server;
 *   - the Host header must name this server (127.0.0.1 or localhost on our port), which
 *     defeats DNS rebinding;
 *   - a POST must carry an Origin of this server and a JSON body, so another web page
 *     cannot submit a form to it.
 * The static page holds no data; a strict Content-Security-Policy allows only our own
 * script and style. Writes are serialised: one approve, deny or undo at a time.
 * One Console serves every mission of its workspace (GET /api/missions); a call names one.
 */

import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createApi, InputError } from './api.js'

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/ui.js': ['ui.js', 'text/javascript; charset=utf-8'],
  '/model.js': ['model.js', 'text/javascript; charset=utf-8'],
  '/screens.js': ['screens.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
}
const STATIC_DIR = new URL('./static/', import.meta.url)
const MAX_BODY = 16 * 1024

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(data) })
  res.end(data)
}

const fail = (res, status, code, message) => send(res, status, { ok: false, error: { code, message } })

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (b) => {
      size += b.length
      if (size > MAX_BODY) {
        reject(new InputError('BODY_TOO_LARGE', 'request body too large'))
        req.destroy()
      } else chunks.push(b)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Constant-time comparison of the presented token. */
function tokenMatches(header, token) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(header ?? '')
  if (!m || m[1].length !== token.length) return false
  return timingSafeEqual(Buffer.from(m[1]), Buffer.from(token))
}

/**
 * @param {{ repoDir: string, mission?: string, port?: number, token?: string, cliPath?: string, env?: NodeJS.ProcessEnv }} cfg
 * @returns {Promise<{ url: string, port: number, token: string, close: () => Promise<void> }>}
 */
export async function startConsole({ repoDir, mission, port = 0, token = randomBytes(32).toString('hex'), cliPath, env }) {
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('the console token must be 64 hex characters')
  const api = createApi({ repoDir, mission, cliPath, env })
  let actual = port
  let busy = false
  const hosts = () => new Set([`127.0.0.1:${actual}`, `localhost:${actual}`])
  const origins = () => new Set([`http://127.0.0.1:${actual}`, `http://localhost:${actual}`])

  // GET routes take the mission from `?mission=<id>`; POST routes from the body. The API checks it.
  const routes = {
    'GET /api/missions': () => api.missions(),
    'GET /api/state': (q) => api.state(q.get('mission')),
    'GET /api/replay': (q) => api.replay(q.get('mission')),
    'POST /api/approve': (body) => api.approve(body),
    'POST /api/deny': (body) => api.deny(body),
    'POST /api/undo': (body) => api.undo(body),
  }

  async function handle(req, res) {
    if (!hosts().has(req.headers.host ?? '')) return fail(res, 403, 'BAD_HOST', 'this server answers only to 127.0.0.1 or localhost on its own port')
    // Only an origin-relative path: "//host/x" or an absolute URL is not ours to parse.
    if (!/^\/(?!\/)/.test(req.url ?? '')) return fail(res, 400, 'BAD_PATH', 'bad request path')
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname]
      return send(res, 200, await readFile(new URL(file, STATIC_DIR)), type)
    }
    if (!url.pathname.startsWith('/api/')) return fail(res, 404, 'NOT_FOUND', 'not found')
    if (!tokenMatches(req.headers.authorization, token)) return fail(res, 401, 'UNAUTHORIZED', 'a valid console token is required')

    if (req.method === 'POST') {
      if (!origins().has(req.headers.origin ?? '')) return fail(res, 403, 'BAD_ORIGIN', 'a POST must come from this console')
      if (!/^application\/json(;|$)/.test(req.headers['content-type'] ?? '')) return fail(res, 415, 'JSON_REQUIRED', 'a POST must have a JSON body')
    } else if (req.method !== 'GET') {
      return fail(res, 405, 'METHOD_NOT_ALLOWED', 'only GET and POST')
    }

    const one = /^\/api\/(approvals|receipt)\/([^/]+)$/.exec(url.pathname)
    const q = url.searchParams
    if (req.method === 'GET' && one) return send(res, 200, one[1] === 'approvals' ? await api.approval(one[2], q.get('mission')) : await api.receipt(one[2], q.get('mission')))
    const route = routes[`${req.method} ${url.pathname}`]
    if (!route) return fail(res, 404, 'NOT_FOUND', 'not found')
    if (req.method === 'GET') return send(res, 200, await route(q))

    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch (err) {
      if (err instanceof InputError) throw err
      throw new InputError('BAD_JSON', 'the body is not valid JSON')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('BAD_JSON', 'the body must be a JSON object')
    if (busy) return fail(res, 409, 'BUSY', 'another approve, deny or undo is running')
    busy = true
    try {
      return send(res, 200, await route(body))
    } finally {
      busy = false
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.destroy()
      if (err instanceof InputError) return fail(res, 400, err.code, err.message)
      fail(res, 500, 'INTERNAL', 'internal error')
    })
  })
  server.headersTimeout = 10_000
  server.requestTimeout = 15 * 60_000
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  actual = server.address().port
  return {
    url: `http://127.0.0.1:${actual}/#token=${token}`,
    port: actual,
    token,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}
