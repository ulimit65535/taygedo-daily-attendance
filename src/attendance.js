import { DEFAULT_GAME_IDS, mergeUpdatedAccounts } from './accounts.js'
import { TaygedoApi } from './taygedoApi.js'

export async function runAttendanceForAccounts(accounts, options = {}) {
  const api = options.api ?? new TaygedoApi()
  const updatedAccounts = []
  const summaries = []
  const maxRetries = options.maxRetries ?? 3

  for (const account of accounts) {
    try {
      const result = await withRetries(async () => await runAccount(api, account), maxRetries)
      updatedAccounts.push(result.updatedAccount)
      summaries.push(result.summary)
    }
    catch (error) {
      updatedAccounts.push({ ...account })
      summaries.push({
        id: account.id,
        name: account.name,
        success: false,
        appSignin: null,
        gameSignins: [],
        error: formatError(error),
      })
    }
  }

  const successCount = summaries.filter(summary => summary.success).length
  const failedCount = summaries.length - successCount
  return {
    updatedAccounts,
    summaries,
    successCount,
    failedCount,
    summary: buildSummary(summaries),
  }
}

export async function runAttendanceJob({ store, accountIds, trigger = 'manual', api }) {
  const startedAt = new Date().toISOString()
  const state = await store.getState()
  const idSet = Array.isArray(accountIds) && accountIds.length ? new Set(accountIds) : null
  const selectedAccounts = idSet ? state.accounts.filter(account => idSet.has(account.id)) : state.accounts

  if (selectedAccounts.length === 0) {
    throw statusError(400, idSet ? '没有找到要签到的账号' : '还没有登录任何账号')
  }

  try {
    const result = await runAttendanceForAccounts(selectedAccounts, {
      api,
      maxRetries: state.settings.maxRetries,
    })

    await store.updateState(current => ({
      ...current,
      accounts: mergeUpdatedAccounts(current.accounts, result.updatedAccounts),
    }))

    const log = {
      id: createLogId(),
      trigger,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: result.failedCount === 0 ? 'success' : 'partial',
      accountIds: selectedAccounts.map(account => account.id),
      successCount: result.successCount,
      failedCount: result.failedCount,
      summary: result.summary,
    }
    await store.appendLog(log)

    return {
      ...result,
      log,
    }
  }
  catch (error) {
    const log = {
      id: createLogId(),
      trigger,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'failed',
      accountIds: selectedAccounts.map(account => account.id),
      successCount: 0,
      failedCount: selectedAccounts.length,
      summary: formatError(error),
    }
    await store.appendLog(log)
    throw error
  }
}

async function runAccount(api, account) {
  if (account.accessToken) {
    try {
      return await signWithSession(api, account, account.accessToken, false)
    }
    catch (error) {
      if (!isAuthError(error)) {
        throw error
      }
    }
  }

  const session = await refreshOrRebuildSession(api, account)
  return await signWithSession(api, session.account, session.accessToken, true)
}

async function refreshOrRebuildSession(api, account) {
  try {
    const refreshed = await api.refreshToken(account.refreshToken, account.deviceId)
    const updatedAccount = withSession(account, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      uid: refreshed.uid,
    })
    return {
      account: updatedAccount,
      accessToken: refreshed.accessToken,
    }
  }
  catch (error) {
    if (!isRefreshRejected(error) || !account.laohuToken || !account.laohuUserId || typeof api.userCenterLogin !== 'function') {
      throw error
    }
  }

  const rebuilt = await api.userCenterLogin(account.laohuToken, account.laohuUserId, account.deviceId)
  const updatedAccount = withSession(account, {
    accessToken: rebuilt.accessToken,
    refreshToken: rebuilt.refreshToken,
    uid: rebuilt.uid,
  })
  return {
    account: updatedAccount,
    accessToken: rebuilt.accessToken,
  }
}

async function signWithSession(api, account, accessToken, shouldUpdateSecret) {
  const gameIds = account.gameIds ?? DEFAULT_GAME_IDS
  const gameRoles = await getAllGameRoles(api, accessToken, account.uid, account.deviceId, gameIds)
  const firstRole = gameRoles[0]
  const roleId = firstRole?.roleId ?? account.roleId

  const appSignin = await api.appSignin(accessToken, account.uid, account.deviceId)
  const gameSignins = []
  for (const role of gameRoles) {
    const signinState = await api.getSigninState(accessToken, role.gameId)
    const signinRewards = await api.getSigninRewards(accessToken, role.gameId)
    await api.gameSignin(accessToken, role.roleId, role.gameId)
    gameSignins.push({
      gameId: role.gameId,
      roleName: role.roleName ?? role.roleId,
      days: signinState.days,
      reward: signinRewards[signinState.days - 1],
      success: true,
    })
  }

  const updatedAccount = { ...account }
  if (roleId) {
    updatedAccount.roleId = roleId
  }
  if (firstRole?.roleName ?? account.roleName) {
    updatedAccount.roleName = firstRole?.roleName ?? account.roleName
  }

  return {
    updatedAccount,
    shouldUpdateSecret,
    summary: {
      id: account.id,
      name: account.name,
      success: true,
      appSignin,
      gameSignins,
      selectedGameIds: gameIds,
    },
  }
}

function withSession(account, session) {
  return {
    ...account,
    uid: session.uid ?? account.uid,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    tokenUpdatedAt: new Date().toISOString(),
  }
}

async function getAllGameRoles(api, accessToken, uid, deviceId, gameIds) {
  const roles = []
  const seenRoleIds = new Set()

  for (const gameId of gameIds) {
    const gameRoleList = await api.getGameRoles(accessToken, uid, deviceId, gameId)
    for (const role of gameRoleList.roles) {
      if (!role.roleId || seenRoleIds.has(role.roleId)) {
        continue
      }
      seenRoleIds.add(role.roleId)
      roles.push({
        gameId,
        roleId: role.roleId,
        roleName: role.roleName,
      })
    }
  }

  return roles
}

async function withRetries(fn, maxRetries) {
  const attempts = Math.max(1, Number(maxRetries) || 1)
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    }
    catch (error) {
      lastError = error
      if (attempt === attempts) {
        break
      }
      await sleep(Math.min(500 * attempt, 2_000))
    }
  }
  throw lastError
}

function buildSummary(accounts) {
  const successCount = accounts.filter(account => account.success).length
  const failedCount = accounts.length - successCount
  const lines = [
    '塔吉多每日签到结果',
    `总账号：${accounts.length}，成功：${successCount}，失败：${failedCount}`,
    '',
  ]

  for (const account of accounts) {
    lines.push(`${account.name}（${account.id}）：${account.success ? '成功' : '失败'}`)
    if (account.appSignin) {
      lines.push(`- APP 签到：获得 ${account.appSignin.goldCoin} 金币，${account.appSignin.exp} 经验`)
    }
    for (const gameSignin of account.gameSignins) {
      const reward = gameSignin.reward ? `，奖励 ${gameSignin.reward.name} x${gameSignin.reward.num}` : ''
      const days = gameSignin.days === undefined ? '' : `，本月第 ${gameSignin.days} 天`
      lines.push(`- 游戏 ${gameSignin.gameId} / ${gameSignin.roleName}：签到成功${days}${reward}`)
    }
    if (account.success && account.selectedGameIds?.length === 0) {
      lines.push('- 游戏签到：未配置')
    }
    if (account.error) {
      lines.push(`- 失败原因：${account.error}`)
    }
    lines.push('')
  }

  return lines.join('\n').trim()
}

function isRefreshRejected(error) {
  return error instanceof Error && error.message.includes('REFRESH_REJECTED_402')
}

function isAuthError(error) {
  return error instanceof Error && /AUTH_EXPIRED|HTTP 40[123]|登录|token|未授权|请先|过期|失效|invalid_token/i.test(error.message)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function createLogId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error)
}

function statusError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}
