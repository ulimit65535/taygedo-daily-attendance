import { randomBytes } from 'node:crypto'

export const GAMES = [
  { id: '1256', name: '幻塔' },
  { id: '1257', name: '未知游戏' },
  { id: '1289', name: '异环' },
]

export const DEFAULT_GAME_IDS = GAMES.map(game => game.id)

const GAME_ID_SET = new Set(DEFAULT_GAME_IDS)

export function createDeviceId() {
  return randomBytes(16).toString('hex')
}

export function normalizeGameIds(value, fallback = DEFAULT_GAME_IDS) {
  const source = value === undefined ? fallback : value
  if (!Array.isArray(source)) {
    throw new Error('gameIds must be an array')
  }

  const unique = []
  for (const item of source) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error('gameIds must contain non-empty strings')
    }
    if (!GAME_ID_SET.has(item)) {
      throw new Error(`Unsupported game id: ${item}`)
    }
    if (!unique.includes(item)) {
      unique.push(item)
    }
  }
  return unique
}

export function normalizeAccount(account) {
  if (!isRecord(account)) {
    throw new Error('Account must be an object')
  }

  const normalized = {
    id: requireString(account, 'id'),
    name: requireString(account, 'name'),
    uid: requireString(account, 'uid'),
    deviceId: requireString(account, 'deviceId'),
    refreshToken: requireString(account, 'refreshToken'),
    gameIds: normalizeGameIds(account.gameIds),
  }

  assignOptionalString(normalized, account, 'accessToken')
  assignOptionalString(normalized, account, 'laohuToken')
  assignOptionalString(normalized, account, 'laohuUserId')
  assignOptionalString(normalized, account, 'tokenUpdatedAt')
  assignOptionalString(normalized, account, 'roleId')
  assignOptionalString(normalized, account, 'roleName')

  return normalized
}

export function normalizeAccounts(accounts) {
  if (!Array.isArray(accounts)) {
    throw new Error('accounts must be an array')
  }

  const ids = new Set()
  return accounts.map((account) => {
    const normalized = normalizeAccount(account)
    if (ids.has(normalized.id)) {
      throw new Error(`Duplicate account id: ${normalized.id}`)
    }
    ids.add(normalized.id)
    return normalized
  })
}

export function sanitizeAccount(account) {
  return {
    id: account.id,
    name: account.name,
    uid: account.uid,
    deviceId: account.deviceId,
    tokenUpdatedAt: account.tokenUpdatedAt,
    roleId: account.roleId,
    roleName: account.roleName,
    gameIds: account.gameIds ?? DEFAULT_GAME_IDS,
    hasAccessToken: Boolean(account.accessToken),
    hasLaohuCredential: Boolean(account.laohuToken && account.laohuUserId),
  }
}

export function upsertAccount(accounts, nextAccount) {
  const normalized = normalizeAccount(nextAccount)
  const index = accounts.findIndex(account => account.id === normalized.id)
  if (index === -1) {
    return [...accounts, normalized]
  }

  const copied = accounts.slice()
  copied[index] = normalized
  return copied
}

export function mergeUpdatedAccounts(accounts, updatedAccounts) {
  const updatedById = new Map(updatedAccounts.map(account => [account.id, normalizeAccount(account)]))
  return accounts.map(account => updatedById.get(account.id) ?? account)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(record, field) {
  const value = record[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Account is missing required field ${field}`)
  }
  return value
}

function optionalString(record, field) {
  const value = record[field]
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Optional field ${field} must be a non-empty string when provided`)
  }
  return value
}

function assignOptionalString(target, record, field) {
  const value = optionalString(record, field)
  if (value) {
    target[field] = value
  }
}
