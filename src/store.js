import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DEFAULT_STATE, normalizeState } from './state.js'

export class LocalStore {
  constructor(dataDir = join(process.cwd(), 'data')) {
    this.dataDir = dataDir
    this.statePath = join(dataDir, 'state.json')
    this.logPath = join(dataDir, 'logs.jsonl')
    this.authPath = join(dataDir, 'auth.json')
    this.loginAttemptsPath = join(dataDir, 'login-attempts.json')
    this.queue = Promise.resolve()
    this.authQueue = Promise.resolve()
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true })
    await this.getState()
  }

  async getState() {
    try {
      const text = await readFile(this.statePath, 'utf8')
      return normalizeState(JSON.parse(text))
    }
    catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error
      }
      const state = normalizeState(DEFAULT_STATE)
      await this.saveState(state)
      return state
    }
  }

  async saveState(state) {
    const normalized = normalizeState(state)
    await mkdir(dirname(this.statePath), { recursive: true })
    const tempPath = `${this.statePath}.${process.pid}.tmp`
    await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    await rename(tempPath, this.statePath)
    return normalized
  }

  async updateState(updater) {
    const run = async () => {
      const current = await this.getState()
      const next = await updater(current)
      return await this.saveState(next)
    }

    this.queue = this.queue.then(run, run)
    return await this.queue
  }

  async appendLog(entry) {
    await mkdir(dirname(this.logPath), { recursive: true })
    await appendFile(this.logPath, `${JSON.stringify(entry)}\n`, 'utf8')
  }

  async listLogs(limit = 50) {
    try {
      const text = await readFile(this.logPath, 'utf8')
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line)
          }
          catch {
            return null
          }
        })
        .filter(Boolean)
        .reverse()
        .slice(0, limit)
    }
    catch (error) {
      if (error?.code === 'ENOENT') {
        return []
      }
      throw error
    }
  }

  async getAuthConfig() {
    try {
      const text = await readFile(this.authPath, 'utf8')
      const config = JSON.parse(text)
      return isRecord(config) ? config : null
    }
    catch (error) {
      if (error?.code === 'ENOENT') {
        return null
      }
      throw error
    }
  }

  async setAuthConfig(config) {
    const run = async () => {
      await mkdir(dirname(this.authPath), { recursive: true })
      const tempPath = `${this.authPath}.${process.pid}.tmp`
      await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
      await rename(tempPath, this.authPath)
      return config
    }

    this.authQueue = this.authQueue.then(run, run)
    return await this.authQueue
  }

  async getLoginAttempt(key) {
    const attempts = await this.readLoginAttempts()
    const attempt = attempts[key]
    return isRecord(attempt) ? attempt : null
  }

  async setLoginAttempt(key, attempt) {
    const run = async () => {
      const attempts = await this.readLoginAttempts()
      attempts[key] = attempt
      await this.writeLoginAttempts(pruneLoginAttempts(attempts))
      return attempt
    }

    this.authQueue = this.authQueue.then(run, run)
    return await this.authQueue
  }

  async deleteLoginAttempt(key) {
    const run = async () => {
      const attempts = await this.readLoginAttempts()
      delete attempts[key]
      await this.writeLoginAttempts(attempts)
    }

    this.authQueue = this.authQueue.then(run, run)
    await this.authQueue
  }

  async readLoginAttempts() {
    try {
      const text = await readFile(this.loginAttemptsPath, 'utf8')
      const attempts = JSON.parse(text)
      return isRecord(attempts) ? attempts : {}
    }
    catch (error) {
      if (error?.code === 'ENOENT') {
        return {}
      }
      throw error
    }
  }

  async writeLoginAttempts(attempts) {
    await mkdir(dirname(this.loginAttemptsPath), { recursive: true })
    const tempPath = `${this.loginAttemptsPath}.${process.pid}.tmp`
    await writeFile(tempPath, `${JSON.stringify(attempts, null, 2)}\n`, 'utf8')
    await rename(tempPath, this.loginAttemptsPath)
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pruneLoginAttempts(attempts) {
  const now = Date.now()
  return Object.fromEntries(
    Object.entries(attempts).filter(([, attempt]) => {
      if (!isRecord(attempt)) {
        return false
      }
      const updatedAt = Number(attempt.updatedAt ?? 0)
      const lockedUntil = Number(attempt.lockedUntil ?? 0)
      return lockedUntil > now || now - updatedAt < 24 * 60 * 60 * 1000
    }),
  )
}
