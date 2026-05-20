import { normalizeTime } from './state.js'

export class DailyScheduler {
  constructor({ store, runJob }) {
    this.store = store
    this.runJob = runJob
    this.timer = null
    this.nextRunAt = null
  }

  async start() {
    await this.reschedule()
  }

  async reschedule() {
    this.stop()
    const state = await this.store.getState()
    if (!state.schedule.enabled) {
      return null
    }

    const nextRunAt = getNextRunAt(state.schedule.time)
    this.nextRunAt = nextRunAt.toISOString()
    const delay = Math.max(0, nextRunAt.getTime() - Date.now())
    this.timer = setTimeout(async () => {
      try {
        await this.runJob({ trigger: 'schedule' })
      }
      catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
      }
      finally {
        await this.reschedule()
      }
    }, delay)
    return this.nextRunAt
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.nextRunAt = null
  }

  status() {
    return {
      nextRunAt: this.nextRunAt,
    }
  }
}

export function getNextRunAt(time, now = new Date()) {
  const normalized = normalizeTime(time)
  const [hourText, minuteText] = normalized.split(':')
  const next = new Date(now)
  next.setHours(Number(hourText), Number(minuteText), 0, 0)
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1)
  }
  return next
}
