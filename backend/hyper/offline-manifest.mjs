import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import b4a from 'b4a'
import {
  normalizeWantedHyperOfflineItem,
  parseHyperOfflineManifest,
  recordWantedHyperOfflineItem,
  removeWantedHyperOfflineItem as removeWantedHyperOfflineItemFromList,
  serializeHyperOfflineManifest
} from './offline-core.mjs'
import { getHyperStoragePath } from './runtime.mjs'

const OFFLINE_FILE_SUFFIX = '-offline.json'
const OFFLINE_TEMP_SUFFIX = '.temporary'
const MAX_OFFLINE_FILE_BYTES = 64 * 1024
let manifestTransition = Promise.resolve()

export function listWantedHyperOfflineItems (storagePath = getHyperStoragePath()) {
  return withManifestTransition(() => readManifest(storagePath))
}

export function addWantedHyperOfflineItem (
  candidate,
  storagePath = getHyperStoragePath()
) {
  return withManifestTransition(() => {
    if (!storagePath) return false
    if (!normalizeWantedHyperOfflineItem(candidate)) return false
    return writeManifest(
      storagePath,
      recordWantedHyperOfflineItem(readManifest(storagePath), candidate)
    )
  })
}

export function removeWantedHyperOfflineItem (
  candidate,
  storagePath = getHyperStoragePath()
) {
  return withManifestTransition(() => {
    if (!storagePath) return false
    return writeManifest(
      storagePath,
      removeWantedHyperOfflineItemFromList(readManifest(storagePath), candidate)
    )
  })
}

export function clearWantedHyperOfflineItems (storagePath = getHyperStoragePath()) {
  return withManifestTransition(() => {
    if (!storagePath) return false
    removeFile(getManifestFile(storagePath))
    removeFile(getManifestFile(storagePath) + OFFLINE_TEMP_SUFFIX)
    return true
  })
}

function readManifest (storagePath) {
  if (!storagePath) return []
  const file = getManifestFile(storagePath)
  if (!existsSync(file)) return []

  try {
    if (statSync(file).size > MAX_OFFLINE_FILE_BYTES) return []
    return parseHyperOfflineManifest(String(readFileSync(file, 'utf8')))
  } catch {
    return []
  }
}

function writeManifest (storagePath, items) {
  const serialized = serializeHyperOfflineManifest(items)
  if (b4a.byteLength(serialized) > MAX_OFFLINE_FILE_BYTES) return false

  const file = getManifestFile(storagePath)
  const temporary = file + OFFLINE_TEMP_SUFFIX
  mkdirSync(getDirName(file), { recursive: true })
  writeFileSync(temporary, serialized)
  renameSync(temporary, file)
  return true
}

function getManifestFile (storagePath) {
  return `${String(storagePath).replace(/[/\\]+$/, '')}${OFFLINE_FILE_SUFFIX}`
}

function getDirName (filepath) {
  const separatorIndex = Math.max(filepath.lastIndexOf('/'), filepath.lastIndexOf('\\'))
  return separatorIndex === -1 ? '.' : filepath.slice(0, separatorIndex) || '.'
}

function removeFile (filepath) {
  try {
    unlinkSync(filepath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function withManifestTransition (task) {
  const next = manifestTransition.then(task, task)
  manifestTransition = next.catch(() => {})
  return next
}
