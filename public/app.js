const state = {
  auth: null,
  games: [],
  accounts: [],
  schedule: { enabled: false, time: '09:00' },
  settings: { maxRetries: 3 },
  scheduler: { nextRunAt: null },
  running: false,
  logs: [],
}

const els = {
  authShell: document.querySelector('#authShell'),
  appShell: document.querySelector('#appShell'),
  setupForm: document.querySelector('#setupForm'),
  setupUsername: document.querySelector('#setupUsername'),
  setupPassword: document.querySelector('#setupPassword'),
  setupPasswordConfirm: document.querySelector('#setupPasswordConfirm'),
  authLoginForm: document.querySelector('#authLoginForm'),
  authUsername: document.querySelector('#authUsername'),
  authPassword: document.querySelector('#authPassword'),
  statusLine: document.querySelector('#statusLine'),
  nextRunText: document.querySelector('#nextRunText'),
  accountCount: document.querySelector('#accountCount'),
  accountsList: document.querySelector('#accountsList'),
  logsList: document.querySelector('#logsList'),
  toast: document.querySelector('#toast'),
  runAllBtn: document.querySelector('#runAllBtn'),
  refreshBtn: document.querySelector('#refreshBtn'),
  refreshLogsBtn: document.querySelector('#refreshLogsBtn'),
  logoutBtn: document.querySelector('#logoutBtn'),
  scheduleForm: document.querySelector('#scheduleForm'),
  scheduleEnabled: document.querySelector('#scheduleEnabled'),
  scheduleTime: document.querySelector('#scheduleTime'),
  maxRetries: document.querySelector('#maxRetries'),
  phone: document.querySelector('#phone'),
  deviceId: document.querySelector('#deviceId'),
  captcha: document.querySelector('#captcha'),
  loginGames: document.querySelector('#loginGames'),
  sendCodeBtn: document.querySelector('#sendCodeBtn'),
  completeLoginBtn: document.querySelector('#completeLoginBtn'),
}

await bootstrap()

els.setupForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  await withBusy(event.submitter, async () => {
    if (els.setupPassword.value !== els.setupPasswordConfirm.value) {
      throw new Error('两次输入的密码不一致')
    }
    const data = await api('/api/auth/setup', {
      method: 'POST',
      body: {
        username: els.setupUsername.value,
        password: els.setupPassword.value,
      },
    })
    await enterApp(data)
    els.setupPassword.value = ''
    els.setupPasswordConfirm.value = ''
    showToast('管理员账号已创建')
  })
})

els.authLoginForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  await withBusy(event.submitter, async () => {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: {
        username: els.authUsername.value,
        password: els.authPassword.value,
      },
    })
    await enterApp(data)
    els.authPassword.value = ''
    showToast('已登录')
  })
})

els.refreshBtn.addEventListener('click', async () => {
  await withBusy(els.refreshBtn, refreshAll)
})
els.refreshLogsBtn.addEventListener('click', async () => {
  await withBusy(els.refreshLogsBtn, refreshLogs)
})
els.logoutBtn.addEventListener('click', async () => {
  await withBusy(els.logoutBtn, async () => {
    await api('/api/auth/logout', { method: 'POST', body: {} })
    state.auth = null
    showAuth('login')
    showToast('已退出')
  })
})

els.scheduleForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  await withBusy(event.submitter, async () => {
    const data = await api('/api/schedule', {
      method: 'PUT',
      body: {
        enabled: els.scheduleEnabled.checked,
        time: els.scheduleTime.value,
        maxRetries: Number(els.maxRetries.value),
      },
    })
    Object.assign(state, data)
    await refreshAll()
    showToast('定时已保存')
  })
})

els.sendCodeBtn.addEventListener('click', async () => {
  await withBusy(els.sendCodeBtn, async () => {
    const data = await api('/api/login/send-code', {
      method: 'POST',
      body: {
        phone: els.phone.value,
        deviceId: els.deviceId.value || undefined,
      },
    })
    els.deviceId.value = data.deviceId
    showToast(`验证码已发送\n设备 ID：${data.deviceId}`)
  })
})

els.completeLoginBtn.addEventListener('click', async () => {
  await withBusy(els.completeLoginBtn, async () => {
    const data = await api('/api/login/complete', {
      method: 'POST',
      body: {
        phone: els.phone.value,
        captcha: els.captcha.value,
        deviceId: els.deviceId.value,
        gameIds: selectedGames(els.loginGames),
      },
    })
    showToast(`账号已保存：${data.account.name}`)
    els.captcha.value = ''
    await refreshAll()
  })
})

els.runAllBtn.addEventListener('click', async () => {
  await withBusy(els.runAllBtn, async () => {
    const data = await api('/api/run', { method: 'POST', body: {} })
    showToast(data.summary)
    await refreshAll()
  })
})

els.accountsList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]')
  if (!button) {
    return
  }

  const item = button.closest('.account-item')
  const id = item.dataset.accountId
  const action = button.dataset.action

  await withBusy(button, async () => {
    if (action === 'save') {
      const data = await api(`/api/accounts/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: {
          gameIds: selectedGames(item.querySelector('[data-field="games"]')),
        },
      })
      showToast(`账号已保存：${data.account.name}`)
      await refreshAll()
      return
    }

    if (action === 'run') {
      const data = await api(`/api/accounts/${encodeURIComponent(id)}/run`, {
        method: 'POST',
        body: {},
      })
      showToast(data.summary)
      await refreshAll()
      return
    }

    if (action === 'delete' && window.confirm(`删除账号 ${id}？`)) {
      await api(`/api/accounts/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      showToast('账号已删除')
      await refreshAll()
    }
  })
})

async function bootstrap() {
  const auth = await api('/api/auth/status')
  if (!auth.configured) {
    showAuth('setup')
    return
  }
  if (!auth.authenticated) {
    showAuth('login')
    return
  }

  await enterApp(auth)
}

async function enterApp(auth) {
  state.auth = auth
  showApp()
  await refreshAll()
}

function showAuth(mode) {
  els.authShell.hidden = false
  els.appShell.hidden = true
  els.setupForm.hidden = mode !== 'setup'
  els.authLoginForm.hidden = mode !== 'login'
  if (mode === 'setup') {
    els.setupUsername.focus()
  }
  else {
    els.authUsername.focus()
  }
}

function showApp() {
  els.authShell.hidden = true
  els.appShell.hidden = false
}

async function refreshAll() {
  const data = await api('/api/state')
  Object.assign(state, data)
  renderState()
  await refreshLogs()
}

async function refreshLogs() {
  const data = await api('/api/logs?limit=50')
  state.logs = data.logs
  renderLogs()
}

function renderState() {
  const userText = state.auth?.username ? `管理员 ${state.auth.username}` : '已登录'
  els.statusLine.textContent = state.running
    ? `签到任务运行中，${userText}，账号 ${state.accounts.length} 个`
    : `${userText}，账号 ${state.accounts.length} 个`
  els.accountCount.textContent = `${state.accounts.length} 个`
  els.runAllBtn.disabled = state.running || state.accounts.length === 0
  els.scheduleEnabled.checked = Boolean(state.schedule.enabled)
  els.scheduleTime.value = state.schedule.time
  els.maxRetries.value = state.settings.maxRetries
  els.nextRunText.textContent = state.scheduler?.nextRunAt
    ? `下次 ${formatDateTime(state.scheduler.nextRunAt)}`
    : '未开启'

  renderLoginGames()
  renderAccounts()
}

function renderLoginGames() {
  if (!els.loginGames.children.length) {
    els.loginGames.innerHTML = gameCheckboxes(state.games.map(game => game.id))
  }
}

function renderAccounts() {
  if (state.accounts.length === 0) {
    els.accountsList.innerHTML = '<div class="empty">暂无账号</div>'
    return
  }

  els.accountsList.innerHTML = state.accounts.map(account => `
    <article class="account-item" data-account-id="${escapeHtml(account.id)}">
      <div class="account-top">
        <div>
          <h3>${escapeHtml(account.name)}</h3>
          <div class="account-meta">
            <span>UID ${escapeHtml(account.uid)}</span>
            <span>角色 ${escapeHtml(account.roleName || account.roleId || '未记录')}</span>
            <span>Token ${account.hasAccessToken ? '已保存' : '待刷新'}</span>
          </div>
        </div>
        <span class="pill">${escapeHtml(account.gameIds.length)} 个游戏</span>
      </div>
      <div class="account-edit">
        <div>
          <div class="field-title">签到游戏</div>
          <div class="game-grid" data-field="games">
            ${gameCheckboxes(account.gameIds)}
          </div>
        </div>
      </div>
      <div class="account-actions">
        <button class="button primary small" type="button" data-action="run">签到</button>
        <button class="button small" type="button" data-action="save">保存</button>
        <button class="button danger small" type="button" data-action="delete">删除</button>
      </div>
    </article>
  `).join('')
}

function renderLogs() {
  if (state.logs.length === 0) {
    els.logsList.innerHTML = '<div class="empty">暂无日志</div>'
    return
  }

  els.logsList.innerHTML = state.logs.map(log => `
    <article class="log-item">
      <div class="log-head">
        <div class="log-title">
          <span class="status ${escapeAttr(log.status)}">${statusText(log.status)}</span>
          <strong>${escapeHtml(triggerText(log.trigger))}</strong>
          <span class="hint">${escapeHtml(formatDateTime(log.finishedAt || log.startedAt))}</span>
        </div>
        <span class="hint">成功 ${Number(log.successCount || 0)} / 失败 ${Number(log.failedCount || 0)}</span>
      </div>
      <pre>${escapeHtml(log.summary || '')}</pre>
    </article>
  `).join('')
}

function gameCheckboxes(selectedIds) {
  const selected = new Set(selectedIds)
  return state.games.map(game => `
    <label>
      <input type="checkbox" value="${escapeAttr(game.id)}" ${selected.has(game.id) ? 'checked' : ''}>
      <span>${escapeHtml(game.name)} (${escapeHtml(game.id)})</span>
    </label>
  `).join('')
}

function selectedGames(container) {
  return [...container.querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value)
}

async function api(path, options = {}) {
  const headers = {
    Accept: 'application/json',
    'X-Taygedo-Requested-With': 'fetch',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
  }
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/auth/')) {
      state.auth = null
      showAuth('login')
    }
    throw new Error(data.error || `HTTP ${response.status}`)
  }
  return data
}

async function withBusy(button, fn) {
  const buttons = [button].filter(Boolean)
  try {
    buttons.forEach(item => {
      item.disabled = true
    })
    await fn()
  }
  catch (error) {
    showToast(error instanceof Error ? error.message : String(error))
  }
  finally {
    buttons.forEach(item => {
      item.disabled = false
    })
  }
}

function showToast(message) {
  els.toast.textContent = message
  els.toast.hidden = false
  window.clearTimeout(showToast.timer)
  showToast.timer = window.setTimeout(() => {
    els.toast.hidden = true
  }, 5200)
}

function formatDateTime(value) {
  if (!value) {
    return ''
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function triggerText(value) {
  return value === 'schedule' ? '定时签到' : '手动签到'
}

function statusText(value) {
  if (value === 'success') {
    return '成功'
  }
  if (value === 'partial') {
    return '部分失败'
  }
  return '失败'
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function escapeAttr(value) {
  return escapeHtml(value)
}
