const SESSION_COOKIE = 'taygedo_session'
const REQUEST_HEADER = 'x-taygedo-requested-with'
const REQUEST_HEADER_VALUE = 'fetch'
const PASSWORD_ITERATIONS = 310_000
const PASSWORD_BYTES = 32
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
const MAX_FAILED_ATTEMPTS = 5
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000
const LOCKOUT_MS = 15 * 60 * 1000
const MAX_PASSWORD_LENGTH = 256

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export const AUTH_REQUEST_HEADER = REQUEST_HEADER
export const AUTH_REQUEST_HEADER_VALUE = REQUEST_HEADER_VALUE

export async function setupAuth(store, credentials) {
  const existing = await store.getAuthConfig()
  if (existing) {
    throw httpError(409, '管理员账号已初始化')
  }

  const username = normalizeUsername(credentials?.username)
  const password = normalizePassword(credentials?.password)
  const salt = randomBase64Url(16)
  const passwordHash = await derivePasswordHash(password, salt, PASSWORD_ITERATIONS)
  const now = new Date().toISOString()
  const config = {
    version: 1,
    username,
    password: {
      algorithm: 'PBKDF2-SHA-256',
      iterations: PASSWORD_ITERATIONS,
      salt,
      hash: passwordHash,
    },
    sessionSecret: randomBase64Url(32),
    sessionVersion: 1,
    createdAt: now,
    updatedAt: now,
  }

  await store.setAuthConfig(config)
  return config
}

export async function loginAuth(store, credentials, rateLimitKey) {
  const config = await store.getAuthConfig()
  if (!config) {
    throw httpError(409, '请先初始化管理员账号')
  }

  await assertNotLocked(store, rateLimitKey)

  const username = typeof credentials?.username === 'string' ? credentials.username.trim() : ''
  const password = typeof credentials?.password === 'string' ? credentials.password : ''
  const verified = username === config.username && await verifyPassword(config, password)

  if (!verified) {
    await recordFailedLogin(store, rateLimitKey)
    throw httpError(401, '用户名或密码错误')
  }

  await store.deleteLoginAttempt(rateLimitKey)
  return config
}

export async function getSessionUser(store, cookieHeader) {
  const config = await store.getAuthConfig()
  if (!config) {
    return null
  }

  const session = readCookie(cookieHeader, SESSION_COOKIE)
  if (!session) {
    return null
  }

  const [payloadText, signature] = session.split('.')
  if (!payloadText || !signature) {
    return null
  }

  const expectedSignature = await signSession(config, payloadText)
  if (!timingSafeEqual(base64UrlToBytes(signature), base64UrlToBytes(expectedSignature))) {
    return null
  }

  try {
    const payload = JSON.parse(textDecoder.decode(base64UrlToBytes(payloadText)))
    if (payload.u !== config.username || payload.sv !== (config.sessionVersion ?? 1)) {
      return null
    }
    if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) {
      return null
    }
    return {
      username: payload.u,
      expiresAt: new Date(payload.exp).toISOString(),
    }
  }
  catch {
    return null
  }
}

export async function createSessionCookie(config, options = {}) {
  const now = Date.now()
  const payload = bytesToBase64Url(textEncoder.encode(JSON.stringify({
    u: config.username,
    iat: now,
    exp: now + SESSION_TTL_SECONDS * 1000,
    sv: config.sessionVersion ?? 1,
  })))
  const signature = await signSession(config, payload)
  return serializeCookie(SESSION_COOKIE, `${payload}.${signature}`, {
    httpOnly: true,
    secure: Boolean(options.secure),
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  })
}

export function clearSessionCookie(options = {}) {
  return serializeCookie(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: Boolean(options.secure),
    sameSite: 'Lax',
    path: '/',
    maxAge: 0,
  })
}

export function assertTrustedApiRequest(method, headers) {
  if (!isUnsafeMethod(method)) {
    return
  }

  if (getHeader(headers, REQUEST_HEADER) !== REQUEST_HEADER_VALUE) {
    throw httpError(403, '请求缺少安全校验头')
  }
}

export function getClientRateLimitKey(headers, fallback = 'local') {
  const cfIp = getHeader(headers, 'cf-connecting-ip')
  if (cfIp) {
    return `ip:${cfIp}`
  }

  const forwarded = getHeader(headers, 'x-forwarded-for')
  if (forwarded) {
    return `ip:${forwarded.split(',')[0].trim()}`
  }

  return `ip:${fallback}`
}

export function getHeader(headers, name) {
  if (!headers) {
    return undefined
  }
  if (typeof headers.get === 'function') {
    return headers.get(name) ?? undefined
  }
  const value = headers[name.toLowerCase()] ?? headers[name]
  if (Array.isArray(value)) {
    return value[0]
  }
  return value
}

export function securityHeaders(contentType) {
  return {
    ...(contentType ? { 'Content-Type': contentType } : {}),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "img-src 'self' data:",
      "style-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
    ].join('; '),
  }
}

export function httpError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function normalizeUsername(value) {
  if (typeof value !== 'string') {
    throw httpError(400, '用户名不能为空')
  }
  const username = value.trim()
  if (!/^[a-zA-Z0-9_.@-]{3,64}$/.test(username)) {
    throw httpError(400, '用户名需为 3-64 位字母、数字或 ._@-')
  }
  return username
}

function normalizePassword(value) {
  if (typeof value !== 'string') {
    throw httpError(400, '密码不能为空')
  }
  if (value.length < 12) {
    throw httpError(400, '管理员密码至少需要 12 位')
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    throw httpError(400, `管理员密码不能超过 ${MAX_PASSWORD_LENGTH} 位`)
  }
  return value
}

async function assertNotLocked(store, key) {
  const attempt = await store.getLoginAttempt(key)
  const lockedUntil = Number(attempt?.lockedUntil ?? 0)
  if (lockedUntil > Date.now()) {
    const minutes = Math.ceil((lockedUntil - Date.now()) / 60_000)
    throw httpError(429, `登录失败次数过多，请 ${minutes} 分钟后再试`)
  }
}

async function recordFailedLogin(store, key) {
  const now = Date.now()
  const previous = await store.getLoginAttempt(key)
  const windowStartedAt = Number(previous?.windowStartedAt ?? 0)
  const inWindow = now - windowStartedAt <= ATTEMPT_WINDOW_MS
  const failedCount = inWindow ? Number(previous?.failedCount ?? 0) + 1 : 1
  const lockedUntil = failedCount >= MAX_FAILED_ATTEMPTS ? now + LOCKOUT_MS : 0

  await store.setLoginAttempt(key, {
    failedCount,
    windowStartedAt: inWindow ? windowStartedAt : now,
    lockedUntil,
    updatedAt: now,
  })
}

async function verifyPassword(config, password) {
  if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) {
    return false
  }

  const passwordConfig = config.password
  if (passwordConfig?.algorithm !== 'PBKDF2-SHA-256') {
    return false
  }

  const candidate = await derivePasswordHash(password, passwordConfig.salt, Number(passwordConfig.iterations))
  return timingSafeEqual(base64UrlToBytes(candidate), base64UrlToBytes(passwordConfig.hash))
}

async function derivePasswordHash(password, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: base64UrlToBytes(salt),
      iterations,
    },
    keyMaterial,
    PASSWORD_BYTES * 8,
  )
  return bytesToBase64Url(new Uint8Array(bits))
}

async function signSession(config, payloadText) {
  const key = await crypto.subtle.importKey(
    'raw',
    base64UrlToBytes(config.sessionSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(payloadText))
  return bytesToBase64Url(new Uint8Array(signature))
}

function readCookie(cookieHeader, name) {
  if (!cookieHeader) {
    return undefined
  }
  const prefix = `${name}=`
  return cookieHeader
    .split(';')
    .map(item => item.trim())
    .find(item => item.startsWith(prefix))
    ?.slice(prefix.length)
}

function serializeCookie(name, value, options) {
  const parts = [`${name}=${value}`]
  parts.push(`Path=${options.path}`)
  parts.push(`SameSite=${options.sameSite}`)
  parts.push(`Max-Age=${options.maxAge}`)
  if (options.httpOnly) {
    parts.push('HttpOnly')
  }
  if (options.secure) {
    parts.push('Secure')
  }
  return parts.join('; ')
}

function randomBase64Url(size) {
  const bytes = new Uint8Array(size)
  crypto.getRandomValues(bytes)
  return bytesToBase64Url(bytes)
}

function bytesToBase64Url(bytes) {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function base64UrlToBytes(value) {
  if (typeof value !== 'string') {
    return new Uint8Array()
  }
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  try {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  }
  catch {
    return new Uint8Array()
  }
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) {
    return false
  }

  let mismatch = 0
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left[index] ^ right[index]
  }
  return mismatch === 0
}

function isUnsafeMethod(method) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method).toUpperCase())
}
