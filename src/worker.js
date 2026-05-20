import { createDeviceId, GAMES, normalizeGameIds, sanitizeAccount, upsertAccount } from './accounts.js'
import { runAttendanceJob } from './attendance.js'
import {
  assertTrustedApiRequest,
  clearSessionCookie,
  createSessionCookie,
  getClientRateLimitKey,
  getHeader,
  getSessionUser,
  httpError,
  loginAuth,
  securityHeaders,
  setupAuth,
} from './auth.js'
import { DEFAULT_STATE, normalizeSettings, normalizeState, normalizeTime } from './state.js'
import { TaygedoApi } from './taygedoApi.js'

const WORKER_TIME_ZONE = 'Asia/Shanghai'
const MAX_LOGS = 200
const BODY_LIMIT_BYTES = 64 * 1024

let activeRun = null

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env)
    }
    catch (error) {
      return sendError(error)
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(handleScheduled(env))
  },
}

async function handleRequest(request, env) {
  const url = new URL(request.url)
  const path = decodeURIComponent(url.pathname)

  if (!path.startsWith('/api/')) {
    return await serveAsset(request, env)
  }

  assertTrustedApiRequest(request.method, request.headers)

  const store = new WorkerStore(env.TAYGEDO_KV)
  await store.init()
  const authResponse = await handleAuthRequest(request, store, url)
  if (authResponse) {
    return authResponse
  }

  const session = await getSessionUser(store, getHeader(request.headers, 'cookie'))
  if (!session) {
    return sendJson({ error: '请先登录' }, 401)
  }

  const api = new TaygedoApi()

  if (request.method === 'GET' && path === '/api/state') {
    const state = await store.getState()
    return sendJson({
      games: GAMES,
      schedule: state.schedule,
      settings: state.settings,
      scheduler: {
        nextRunAt: state.schedule.enabled ? getNextWorkerRunAt(state.schedule.time) : null,
        timeZone: WORKER_TIME_ZONE,
      },
      running: Boolean(activeRun),
      accounts: state.accounts.map(sanitizeAccount),
    })
  }

  if (request.method === 'GET' && path === '/api/logs') {
    const limit = Number(url.searchParams.get('limit') ?? '50')
    return sendJson({
      logs: await store.listLogs(Number.isFinite(limit) ? limit : 50),
    })
  }

  if (request.method === 'POST' && path === '/api/login/send-code') {
    const body = await readJsonBody(request)
    const phone = requireString(body, 'phone')
    const deviceId = optionalString(body, 'deviceId') ?? createDeviceId()
    await api.sendCaptcha(phone, deviceId)
    return sendJson({ deviceId })
  }

  if (request.method === 'POST' && path === '/api/login/complete') {
    const body = await readJsonBody(request)
    const phone = requireString(body, 'phone')
    const captcha = requireString(body, 'captcha')
    const deviceId = requireString(body, 'deviceId')
    const accountId = requireString(body, 'accountId')
    const accountName = optionalString(body, 'accountName') ?? accountId
    const gameIds = normalizeGameIds(body.gameIds)

    await api.checkCaptcha(phone, captcha, deviceId)
    const loginResult = await api.loginWithCaptcha(phone, captcha, deviceId)
    const session = await api.userCenterLogin(loginResult.token, loginResult.userId, deviceId)
    const role = await tryGetBindRole(api, session.accessToken, session.uid)
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
    return sendJson({
      account: sanitizeAccount(state.accounts.find(item => item.id === accountId)),
    })
  }

  if (request.method === 'PUT' && path === '/api/schedule') {
    const body = await readJsonBody(request)
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
    return sendJson({
      schedule: state.schedule,
      settings: state.settings,
      scheduler: {
        nextRunAt: state.schedule.enabled ? getNextWorkerRunAt(state.schedule.time) : null,
        timeZone: WORKER_TIME_ZONE,
      },
    })
  }

  if (request.method === 'POST' && path === '/api/run') {
    const body = await readJsonBody(request, true)
    const result = await runWithLock(store, api, {
      trigger: 'manual',
      accountIds: Array.isArray(body.accountIds) ? body.accountIds.map(String) : undefined,
    })
    return sendJson({ summary: result.summary, log: result.log })
  }

  const accountRunMatch = path.match(/^\/api\/accounts\/([^/]+)\/run$/)
  if (request.method === 'POST' && accountRunMatch) {
    const accountId = accountRunMatch[1]
    const result = await runWithLock(store, api, {
      trigger: 'manual',
      accountIds: [accountId],
    })
    return sendJson({ summary: result.summary, log: result.log })
  }

  const accountMatch = path.match(/^\/api\/accounts\/([^/]+)$/)
  if (accountMatch && request.method === 'PATCH') {
    const accountId = accountMatch[1]
    const body = await readJsonBody(request)
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

    return sendJson({
      account: sanitizeAccount(state.accounts.find(account => account.id === accountId)),
    })
  }

  if (accountMatch && request.method === 'DELETE') {
    const accountId = accountMatch[1]
    await store.updateState(current => ({
      ...current,
      accounts: current.accounts.filter(account => account.id !== accountId),
    }))
    return sendJson({ ok: true })
  }

  throw httpError(404, 'Not Found')
}

async function handleAuthRequest(request, store, url) {
  const secure = url.protocol === 'https:'

  if (request.method === 'GET' && url.pathname === '/api/auth/status') {
    const config = await store.getAuthConfig()
    const session = await getSessionUser(store, getHeader(request.headers, 'cookie'))
    return sendJson({
      configured: Boolean(config),
      authenticated: Boolean(session),
      username: session?.username,
    })
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/setup') {
    const body = await readJsonBody(request)
    const config = await setupAuth(store, body)
    const cookie = await createSessionCookie(config, { secure })
    return sendJson({
      configured: true,
      authenticated: true,
      username: config.username,
    }, 201, {
      'Set-Cookie': cookie,
    })
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readJsonBody(request)
    const rateLimitKey = getClientRateLimitKey(request.headers)
    const config = await loginAuth(store, body, rateLimitKey)
    const cookie = await createSessionCookie(config, { secure })
    return sendJson({
      configured: true,
      authenticated: true,
      username: config.username,
    }, 200, {
      'Set-Cookie': cookie,
    })
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    return sendJson({ ok: true }, 200, {
      'Set-Cookie': clearSessionCookie({ secure }),
    })
  }

  return null
}

async function handleScheduled(env) {
  const store = new WorkerStore(env.TAYGEDO_KV)
  await store.init()
  const state = await store.getState()
  if (!await shouldRunScheduled(store, state)) {
    return
  }

  await store.setMeta('schedule:lastRunDate', getZonedParts(new Date()).date)
  await runWithLock(store, new TaygedoApi(), { trigger: 'schedule' })
}

async function runWithLock(store, api, params) {
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

async function tryGetBindRole(api, accessToken, uid) {
  try {
    return await api.getBindRole(accessToken, uid)
  }
  catch {
    return {}
  }
}

async function serveAsset(request, env) {
  if (!env.ASSETS) {
    throw httpError(404, 'Not Found')
  }

  const response = await env.ASSETS.fetch(request)
  const headers = new Headers(response.headers)
  for (const [key, value] of Object.entries(securityHeaders())) {
    headers.set(key, value)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

async function readJsonBody(request, optional = false) {
  const text = await request.text()
  if (text.length > BODY_LIMIT_BYTES) {
    throw httpError(413, '请求体过大')
  }
  if (!text.trim()) {
    return optional ? {} : {}
  }

  try {
    return JSON.parse(text)
  }
  catch {
    throw httpError(400, '请求体不是合法 JSON')
  }
}

function sendJson(data, statusCode = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status: statusCode,
    headers: {
      ...securityHeaders('application/json; charset=utf-8'),
      ...headers,
    },
  })
}

function sendError(error) {
  const statusCode = error?.statusCode ?? 500
  const message = error instanceof Error ? error.message : String(error)
  return sendJson({ error: message }, statusCode)
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

async function shouldRunScheduled(store, state) {
  if (!state.schedule.enabled) {
    return false
  }

  const parts = getZonedParts(new Date())
  const [targetHour, targetMinute] = state.schedule.time.split(':').map(Number)
  const nowMinuteOfDay = parts.hour * 60 + parts.minute
  const targetMinuteOfDay = targetHour * 60 + targetMinute
  if (nowMinuteOfDay < targetMinuteOfDay) {
    return false
  }

  const lastRunDate = await store.getMeta('schedule:lastRunDate')
  return lastRunDate !== parts.date
}

function getNextWorkerRunAt(time, now = new Date()) {
  const parts = getZonedParts(now)
  const [hour, minute] = time.split(':').map(Number)
  let next = Date.UTC(parts.year, parts.month - 1, parts.day, hour - 8, minute, 0, 0)
  if (next <= now.getTime()) {
    next += 24 * 60 * 60 * 1000
  }
  return new Date(next).toISOString()
}

function getZonedParts(date) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: WORKER_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).map(part => [part.type, part.value]))

  const year = Number(values.year)
  const month = Number(values.month)
  const day = Number(values.day)
  return {
    year,
    month,
    day,
    hour: Number(values.hour),
    minute: Number(values.minute),
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  }
}

class WorkerStore {
  constructor(kv) {
    if (!kv) {
      throw httpError(500, '缺少 Cloudflare KV 绑定 TAYGEDO_KV')
    }
    this.kv = kv
  }

  async init() {
    await this.getState()
  }

  async getState() {
    const text = await this.kv.get('state')
    if (!text) {
      const state = normalizeState(DEFAULT_STATE)
      await this.saveState(state)
      return state
    }
    return normalizeState(JSON.parse(text))
  }

  async saveState(state) {
    const normalized = normalizeState(state)
    await this.kv.put('state', JSON.stringify(normalized))
    return normalized
  }

  async updateState(updater) {
    const current = await this.getState()
    const next = await updater(current)
    return await this.saveState(next)
  }

  async appendLog(entry) {
    const logs = await this.listLogs(MAX_LOGS - 1)
    await this.kv.put('logs', JSON.stringify([entry, ...logs].slice(0, MAX_LOGS)))
  }

  async listLogs(limit = 50) {
    const text = await this.kv.get('logs')
    if (!text) {
      return []
    }
    try {
      const logs = JSON.parse(text)
      return Array.isArray(logs) ? logs.slice(0, limit) : []
    }
    catch {
      return []
    }
  }

  async getAuthConfig() {
    const text = await this.kv.get('auth')
    if (!text) {
      return null
    }
    const config = JSON.parse(text)
    return isRecord(config) ? config : null
  }

  async setAuthConfig(config) {
    await this.kv.put('auth', JSON.stringify(config))
    return config
  }

  async getLoginAttempt(key) {
    const text = await this.kv.get(loginAttemptKey(key))
    if (!text) {
      return null
    }
    const attempt = JSON.parse(text)
    return isRecord(attempt) ? attempt : null
  }

  async setLoginAttempt(key, attempt) {
    await this.kv.put(loginAttemptKey(key), JSON.stringify(attempt), {
      expirationTtl: 24 * 60 * 60,
    })
    return attempt
  }

  async deleteLoginAttempt(key) {
    await this.kv.delete(loginAttemptKey(key))
  }

  async getMeta(key) {
    return await this.kv.get(`meta:${key}`)
  }

  async setMeta(key, value) {
    await this.kv.put(`meta:${key}`, String(value))
  }
}

function loginAttemptKey(key) {
  return `login-attempt:${key}`
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
