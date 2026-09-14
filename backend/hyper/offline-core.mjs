import { parseHyperUrl } from './url.mjs'

export const MAX_HYPER_OFFLINE_ENTRIES = 100
const MAX_OFFLINE_PATH_LENGTH = 2048
const Z32_DRIVE_KEY = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/
const HEX_DRIVE_KEY = /^[a-f0-9]{64}$/

export function parseHyperOfflineManifest (value) {
  if (typeof value !== 'string' || !value) return []

  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed?.items)) return []
    return normalizeEntries(parsed.items)
  } catch {
    return []
  }
}

export function serializeHyperOfflineManifest (items) {
  return JSON.stringify({ items: normalizeEntries(items) })
}

export function recordWantedHyperOfflineItem (items, candidate, now = Date.now()) {
  const entry = normalizeWantedHyperOfflineItem({ ...candidate, wantedAt: now })
  if (!entry) return items

  const id = getHyperOfflineItemId(entry)
  return [
    entry,
    ...normalizeEntries(items).filter((item) => getHyperOfflineItemId(item) !== id)
  ].slice(0, MAX_HYPER_OFFLINE_ENTRIES)
}

export function removeWantedHyperOfflineItem (items, candidate) {
  const entry = normalizeWantedHyperOfflineItem(candidate)
  if (!entry) return normalizeEntries(items)

  const id = getHyperOfflineItemId(entry)
  return normalizeEntries(items).filter((item) => getHyperOfflineItemId(item) !== id)
}

export function getHyperOfflineItemId ({ driveKey, path }) {
  return `${driveKey}:${path}`
}

export function normalizeWantedHyperOfflineItem (value) {
  if (!value || typeof value !== 'object') return null

  const driveKey = normalizeDriveKey(value.driveKey)
  const path = normalizeFolderPath(value.path, driveKey)
  if (!driveKey || !path) return null

  const wantedAt = Number(value.wantedAt)
  return {
    driveKey,
    path,
    wantedAt: Number.isSafeInteger(wantedAt) && wantedAt > 0 ? wantedAt : Date.now()
  }
}

function normalizeEntries (items) {
  const normalized = []
  const seen = new Set()

  for (const value of Array.isArray(items) ? items : []) {
    const entry = normalizeWantedHyperOfflineItem(value)
    if (!entry) continue

    const id = getHyperOfflineItemId(entry)
    if (seen.has(id)) continue
    seen.add(id)
    normalized.push(entry)
    if (normalized.length >= MAX_HYPER_OFFLINE_ENTRIES) break
  }

  return normalized
}

function normalizeDriveKey (value) {
  if (typeof value !== 'string') return null
  const key = value.trim().toLowerCase()
  return Z32_DRIVE_KEY.test(key) || HEX_DRIVE_KEY.test(key) ? key : null
}

function normalizeFolderPath (value, driveKey) {
  if (!driveKey || typeof value !== 'string' || value.length > MAX_OFFLINE_PATH_LENGTH) return null
  if (!value.startsWith('/') || value.includes('?') || value.includes('#')) return null

  const target = parseHyperUrl(`hyper://${driveKey}${value}`)
  if (target.error) return null
  return target.pathname === '/' || target.pathname.endsWith('/')
    ? target.pathname
    : `${target.pathname}/`
}
