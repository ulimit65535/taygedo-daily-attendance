import { normalizeAccounts } from './accounts.js'

export const DEFAULT_STATE = {
  accounts: [],
  schedule: {
    enabled: false,
    time: '09:00',
  },
  settings: {
    maxRetries: 3,
  },
}

export function normalizeState(value) {
  const source = isRecord(value) ? value : DEFAULT_STATE
  return {
    accounts: normalizeAccounts(source.accounts ?? []),
    schedule: normalizeSchedule(source.schedule ?? DEFAULT_STATE.schedule),
    settings: normalizeSettings(source.settings ?? DEFAULT_STATE.settings),
  }
}

export function normalizeSchedule(value) {
  const source = isRecord(value) ? value : DEFAULT_STATE.schedule
  return {
    enabled: Boolean(source.enabled),
    time: normalizeTime(source.time ?? DEFAULT_STATE.schedule.time),
  }
}

export function normalizeSettings(value) {
  const source = isRecord(value) ? value : DEFAULT_STATE.settings
  const maxRetries = Number(source.maxRetries ?? DEFAULT_STATE.settings.maxRetries)
  return {
    maxRetries: Number.isFinite(maxRetries) && maxRetries >= 1 ? Math.min(Math.floor(maxRetries), 10) : 3,
  }
}

export function normalizeTime(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) {
    throw new Error('time must use HH:mm format')
  }

  const [hourText, minuteText] = value.split(':')
  const hour = Number(hourText)
  const minute = Number(minuteText)
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error('time must be a valid local time')
  }
  return value
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
