import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDeviceId, GAMES, normalizeGameIds, sanitizeAccount, upsertAccount } from './accounts.js'
import { runAttendanceJob } from './attendance.js'
import {
  assertTrustedApiRequest,
  clearSessionCookie,
  createSessionCookie,
  getClientRateLimitKey,
  getHeader,
  getSessionUser,
  loginAuth,
  securityHeaders,
  setupAuth,
} from './auth.js'
import { DailyScheduler } from './scheduler.js'
import { normalizeSettings, normalizeTime } from './state.js'
import { LocalStore } from './store.js'
import { TaygedoApi } from './taygedoApi.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const publicDir = join(__dirname, '..', 'public')
const port = 3000

const store = new LocalStore()
const api = new TaygedoApi()
let activeRun = null

const scheduler = new DailyScheduler({
  store,
  runJob: params => runWithLock(params),
})

const server = createServer(async (req, res) => {
  try {
    await handleRequest(req, res)
  }
  catch (error) {
    sendError(res, error)
  }
})

await store.init()
await scheduler.start()

server.listen(port, () => {
  console.log(`Taygedo local web is running at http://localhost:${port}`)
})

async function handleRequest(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = decodeURIComponent(url.pathname)

  if (path.startsWith('/api/')) {
    assertTrustedApiRequest(req.method, req.headers)
    const handledAuth = await handleAuthRequest(req, res, path)
    if (handledAuth) {
      return
    }

    const session = await getSessionUser(store, getHeader(req.headers, 'cookie'))
    if (!session) {
      return sendJson(res, { error: '请先登录' }, 401)
    }
  }

  if (req.method === 'GET' && path === '/api/state') {
    const state = await store.getState()
    return sendJson(res, {
      games: GAMES,
      schedule: state.schedule,
      settings: state.settings,
      scheduler: scheduler.status(),
      running: Boolean(activeRun),
      accounts: state.accounts.map(sanitizeAccount),
    })
  }

  if (req.method === 'GET' && path === '/api/logs') {
    const limit = Number(url.searchParams.get('limit') ?? '50')
    return sendJson(res, {
      logs: await store.listLogs(Number.isFinite(limit) ? limit : 50),
    })
  }

  if (req.method === 'POST' && path === '/api/login/send-code') {
    const body = await readJsonBody(req)
    const phone = requireString(body, 'phone')
    const deviceId = optionalString(body, 'deviceId') ?? createDeviceId()
    await api.sendCaptcha(phone, deviceId)
    return sendJson(res, { deviceId })
  }

  if (req.method === 'POST' && path === '/api/login/complete') {
    const body = await readJsonBody(req)
    const phone = requireString(body, 'phone')
    const captcha = requireString(body, 'captcha')
    const deviceId = requireString(body, 'deviceId')
    const accountId = requireString(body, 'accountId')
    const accountName = optionalString(body, 'accountName') ?? accountId
    const gameIds = normalizeGameIds(body.gameIds)

    await api.checkCaptcha(phone, captcha, deviceId)
    const loginResult = await api.loginWithCaptcha(phone, captcha, deviceId)
    const session = await api.userCenterLogin(loginResult.token, loginResult.userId, deviceId)
    const role = await tryGetBindRole(session.accessToken, session.uid)
    const account = {
      id: accountId,
      name: accountName,
      uid: session.uid,
      deviceId,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      laohuToken: loginResult.token,
      laohuUserId: loginResult.userId,
      tokenUpdatedAt: new Date().toISOString(),
      gameIds,
    }
    if (role.roleId) {
      account.roleId = String(role.roleId)
    }
    if (role.roleName) {
      account.roleName = role.roleName
    }

    const state = await store.updateState(current => ({
      ...current,
      accounts: upsertAccount(current.accounts, account),
    }))
    return sendJson(res, {
      account: sanitizeAccount(state.accounts.find(item => item.id === accountId)),
    })
  }

  if (req.method === 'PUT' && path === '/api/schedule') {
    const body = await readJsonBody(req)
    const time = normalizeTime(String(body.time ?? '09:00'))
    const enabled = Boolean(body.enabled)
    const settings = normalizeSettings({
      maxRetries: body.maxRetries,
    })

    const state = await store.updateState(current => ({
      ...current,
      schedule: { enabled, time },
      settings,
    }))
    await scheduler.reschedule()
    return sendJson(res, {
      schedule: state.schedule,
      settings: state.settings,
      scheduler: scheduler.status(),
    })
  }

  if (req.method === 'POST' && path === '/api/run') {
    const body = await readJsonBody(req, true)
    const result = await runWithLock({
      trigger: 'manual',
      accountIds: Array.isArray(body.accountIds) ? body.accountIds.map(String) : undefined,
    })
    return sendJson(res, { summary: result.summary, log: result.log })
  }

  const accountRunMatch = path.match(/^\/api\/accounts\/([^/]+)\/run$/)
  if (req.method === 'POST' && accountRunMatch) {
    const accountId = accountRunMatch[1]
    const result = await runWithLock({
      trigger: 'manual',
      accountIds: [accountId],
    })
    return sendJson(res, { summary: result.summary, log: result.log })
  }

  const accountMatch = path.match(/^\/api\/accounts\/([^/]+)$/)
  if (accountMatch && req.method === 'PATCH') {
    const accountId = accountMatch[1]
    const body = await readJsonBody(req)
    const state = await store.updateState((current) => {
      const index = current.accounts.findIndex(account => account.id === accountId)
      if (index === -1) {
        throw httpError(404, '账号不存在')
      }

      const accounts = current.accounts.slice()
      const nextAccount = { ...accounts[index] }
      if (body.name !== undefined) {
        nextAccount.name = requireString(body, 'name')
      }
      if (body.gameIds !== undefined) {
        nextAccount.gameIds = normalizeGameIds(body.gameIds, [])
      }
      accounts[index] = nextAccount
      return {
        ...current,
        accounts,
      }
    })

    return sendJson(res, {
      account: sanitizeAccount(state.accounts.find(account => account.id === accountId)),
    })
  }

  if (accountMatch && req.method === 'DELETE') {
    const accountId = accountMatch[1]
    await store.updateState(current => ({
      ...current,
      accounts: current.accounts.filter(account => account.id !== accountId),
    }))
    return sendJson(res, { ok: true })
  }

  if (req.method === 'GET') {
    return await serveStatic(path, res)
  }

  throw httpError(404, 'Not Found')
}

async function handleAuthRequest(req, res, path) {
  if (req.method === 'GET' && path === '/api/auth/status') {
    const config = await store.getAuthConfig()
    const session = await getSessionUser(store, getHeader(req.headers, 'cookie'))
    sendJson(res, {
      configured: Boolean(config),
      authenticated: Boolean(session),
      username: session?.username,
    })
    return true
  }

  if (req.method === 'POST' && path === '/api/auth/setup') {
    const body = await readJsonBody(req)
    const config = await setupAuth(store, body)
    const cookie = await createSessionCookie(config, { secure: isSecureRequest(req) })
    sendJson(res, {
      configured: true,
      authenticated: true,
      username: config.username,
    }, 201, {
      'Set-Cookie': cookie,
    })
    return true
  }

  if (req.method === 'POST' && path === '/api/auth/login') {
    const body = await readJsonBody(req)
    const rateLimitKey = getClientRateLimitKey(req.headers, getClientIp(req))
    const config = await loginAuth(store, body, rateLimitKey)
    const cookie = await createSessionCookie(config, { secure: isSecureRequest(req) })
    sendJson(res, {
      configured: true,
      authenticated: true,
      username: config.username,
    }, 200, {
      'Set-Cookie': cookie,
    })
    return true
  }

  if (req.method === 'POST' && path === '/api/auth/logout') {
    sendJson(res, { ok: true }, 200, {
      'Set-Cookie': clearSessionCookie({ secure: isSecureRequest(req) }),
    })
    return true
  }

  return false
}

async function runWithLock(params) {
  if (activeRun) {
    throw httpError(409, '已有签到任务正在运行')
  }

  activeRun = runAttendanceJob({
    store,
    api,
    ...params,
  }).finally(() => {
    activeRun = null
  })

  return await activeRun
}

async function tryGetBindRole(accessToken, uid) {
  try {
    return await api.getBindRole(accessToken, uid)
  }
  catch {
    return {}
  }
}

async function serveStatic(path, res) {
  const root = resolve(publicDir)
  const filePath = path === '/' ? join(root, 'index.html') : resolve(root, `.${path}`)
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    throw httpError(404, 'Not Found')
  }

  try {
    const content = await readFile(filePath)
    res.writeHead(200, {
      ...securityHeaders(contentType(filePath)),
    })
    res.end(content)
  }
  catch (error) {
    if (error?.code === 'ENOENT') {
      throw httpError(404, 'Not Found')
    }
    throw error
  }
}

async function readJsonBody(req, optional = false) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) {
      throw httpError(413, '请求体过大')
    }
    chunks.push(chunk)
  }

  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) {
    return optional ? {} : {}
  }

  try {
    return JSON.parse(text)
  }
  catch {
    throw httpError(400, '请求体不是合法 JSON')
  }
}

function sendJson(res, data, statusCode = 200, headers = {}) {
  res.writeHead(statusCode, {
    ...securityHeaders('application/json; charset=utf-8'),
    ...headers,
  })
  res.end(JSON.stringify(data))
}

function sendError(res, error) {
  const statusCode = error?.statusCode ?? 500
  const message = error instanceof Error ? error.message : String(error)
  sendJson(res, { error: message }, statusCode)
}

function requireString(record, field) {
  const value = record?.[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw httpError(400, `${field} 不能为空`)
  }
  return value.trim()
}

function optionalString(record, field) {
  const value = record?.[field]
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value !== 'string') {
    throw httpError(400, `${field} 必须是字符串`)
  }
  return value.trim()
}

function httpError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function contentType(filePath) {
  switch (extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.js':
      return 'application/javascript; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}

function isSecureRequest(req) {
  return Boolean(req.socket?.encrypted) || getHeader(req.headers, 'x-forwarded-proto') === 'https'
}

function getClientIp(req) {
  const address = req.socket?.remoteAddress
  return typeof address === 'string' && address ? address : 'local'
}
