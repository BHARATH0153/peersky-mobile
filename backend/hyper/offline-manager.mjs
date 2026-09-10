import {
  getHyperOfflineItemId,
  normalizeWantedHyperOfflineItem
} from './offline-core.mjs'
import {
  addWantedHyperOfflineItem,
  listWantedHyperOfflineItems,
  removeWantedHyperOfflineItem
} from './offline-manifest.mjs'
import { withHyperRuntimeForAddress } from './runtime.mjs'
import { parseHyperUrl } from './url.mjs'

const MAX_OFFLINE_SIZE_ENTRIES = 5000

export function createHyperOfflineManager ({
  runWithRuntime,
  addWantedItem,
  listWantedItems,
  removeWantedItem
}) {
  const activeDownloads = new Map()
  const pausedItems = new Set()
  const failedItems = new Map()
  const removingItems = new Set()

  async function keep ({ url, wait = true } = {}) {
    const target = parseHyperUrl(url)
    if (target.error || target.driveAddress === 'default') {
      return { ok: false, error: target.error || 'A Hyperdrive address is required.' }
    }

    let item
    try {
      item = await runWithRuntime(target.driveAddress, async (runtime) => {
        const drive = await runtime.getDrive(target.driveAddress)
        return normalizeWantedHyperOfflineItem({
          driveKey: drive.id,
          path: target.pathname
        })
      })
    } catch (error) {
      return failure(error)
    }

    if (!item) return { ok: false, error: 'Unable to resolve the Hyperdrive key.' }
    const id = getHyperOfflineItemId(item)
    if (removingItems.has(id)) return { ok: false, error: 'Offline folder is being removed.' }
    try {
      if (!await addWantedItem(item)) {
        return { ok: false, error: 'Unable to save the offline download request.' }
      }
    } catch (error) {
      return failure(error)
    }

    const download = start(item)
    return wait === false ? success(item, 'downloading') : download
  }

  async function pause (candidate) {
    let item
    try {
      item = await findWantedItem(candidate)
    } catch (error) {
      return failure(error)
    }
    if (!item) return { ok: false, error: 'Offline folder not found.' }

    const id = getHyperOfflineItemId(item)
    pausedItems.add(id)
    failedItems.delete(id)
    const active = activeDownloads.get(id)
    if (active) {
      active.cancelled = true
      active.download?.destroy()
    }

    return success(item, 'paused')
  }

  async function resume (candidate) {
    let item
    try {
      item = await findWantedItem(candidate)
    } catch (error) {
      return failure(error)
    }
    if (!item) return { ok: false, error: 'Offline folder not found.' }
    const download = start(item)
    return candidate?.wait === false ? success(item, 'downloading') : download
  }

  async function remove (candidate) {
    const normalized = normalizeWantedHyperOfflineItem(candidate)
    if (!normalized) return { ok: false, error: 'Offline folder not found.' }

    const id = getHyperOfflineItemId(normalized)
    if (removingItems.has(id)) return { ok: false, error: 'Offline folder is already being removed.' }
    removingItems.add(id)

    try {
      const item = await findWantedItem(normalized)
      if (!item) return { ok: false, error: 'Offline folder not found.' }

      const active = activeDownloads.get(id)
      if (active) {
        active.cancelled = true
        active.download?.destroy()
        await active.promise
      }

      if (!await removeWantedItem(item)) {
        return { ok: false, error: 'Unable to remove the offline folder.' }
      }

      pausedItems.delete(id)
      failedItems.delete(id)

      try {
        const retainedItems = await listWantedItems()
        const cleared = await clearCachedFolder(runWithRuntime, item, retainedItems)
        return {
          ok: true,
          item: { ...item, status: 'removed' },
          cacheCleared: true,
          ...cleared
        }
      } catch (error) {
        return {
          ok: true,
          item: { ...item, status: 'removed' },
          cacheCleared: false,
          warning: `Offline folder was removed, but cached data could not be cleared. ${normalizeError(error)}`
        }
      }
    } catch (error) {
      return failure(error)
    } finally {
      removingItems.delete(id)
    }
  }

  async function resumeAll ({ allowNetwork = true } = {}) {
    let items
    try {
      items = await listWantedItems()
    } catch (error) {
      return { ...failure(error), items: [] }
    }
    pruneState(items)
    const results = []

    for (const item of items) {
      const id = getHyperOfflineItemId(item)
      if (pausedItems.has(id)) {
        results.push(success(item, 'paused'))
        continue
      }

      const available = await hasItem(item)
      if (available) {
        failedItems.delete(id)
        results.push(success(item, 'available'))
      } else if (!allowNetwork) {
        results.push(success(item, 'waiting-for-wifi'))
      } else {
        results.push(await start(item))
      }
    }

    return { ok: results.every((result) => result.ok), items: results.map(resultItem) }
  }

  async function list ({ allowNetwork = true, driveKey, path } = {}) {
    let items
    try {
      items = await listWantedItems()
    } catch (error) {
      return { ...failure(error), items: [] }
    }
    pruneState(items)
    if (driveKey !== undefined || path !== undefined) {
      const candidate = normalizeWantedHyperOfflineItem({ driveKey, path })
      if (!candidate) return { ok: false, error: 'Invalid offline folder.', items: [] }
      const id = getHyperOfflineItemId(candidate)
      items = items.filter((item) => getHyperOfflineItemId(item) === id)
    }
    const results = []

    for (const item of items) {
      const id = getHyperOfflineItemId(item)
      if (activeDownloads.has(id)) {
        results.push(success(item, 'downloading'))
      } else if (pausedItems.has(id)) {
        results.push(success(item, 'paused'))
      } else if (await hasItem(item)) {
        failedItems.delete(id)
        results.push(success(item, 'available', await getAvailableSize(item)))
      } else if (failedItems.has(id)) {
        results.push({
          ok: false,
          error: failedItems.get(id),
          item: { ...item, status: 'error' }
        })
      } else {
        results.push(success(item, allowNetwork ? 'paused' : 'waiting-for-wifi'))
      }
    }

    return { ok: true, items: results.map(resultItem) }
  }

  async function close () {
    const downloads = [...activeDownloads.values()]
    for (const active of downloads) {
      active.cancelled = true
      active.download?.destroy()
    }
    await Promise.allSettled(downloads.map((active) => active.promise))
    activeDownloads.clear()
  }

  function start (item) {
    const id = getHyperOfflineItemId(item)
    if (removingItems.has(id)) {
      return Promise.resolve({ ok: false, error: 'Offline folder is being removed.' })
    }
    const existing = activeDownloads.get(id)
    if (existing) return existing.promise

    pausedItems.delete(id)
    failedItems.delete(id)
    const active = { cancelled: false, download: null, promise: null }
    active.promise = runWithRuntime(`hyper://${item.driveKey}/`, async (runtime) => {
      const drive = await runtime.getDrive(`hyper://${item.driveKey}/`)
      if (await drive.has(item.path)) return success(item, 'available')
      if (active.cancelled) return success(item, 'paused')

      active.download = drive.download(item.path)
      await active.download.done()
      if (active.cancelled) return success(item, 'paused')
      if (!await drive.has(item.path)) {
        throw new Error('The offline download did not complete.')
      }

      return success(item, 'available')
    }).catch((error) => {
      const message = normalizeError(error)
      if (!active.cancelled) failedItems.set(id, message)
      return active.cancelled
        ? success(item, 'paused')
        : { ok: false, error: message, item: { ...item, status: 'error' } }
    }).finally(() => {
      if (activeDownloads.get(id) === active) activeDownloads.delete(id)
    })

    activeDownloads.set(id, active)
    return active.promise
  }

  async function hasItem (item) {
    try {
      return await runWithRuntime(`hyper://${item.driveKey}/`, async (runtime) => {
        const drive = await runtime.getDrive(`hyper://${item.driveKey}/`, { autoJoin: false })
        return drive.has(item.path)
      })
    } catch {
      return false
    }
  }

  async function getAvailableSize (item) {
    try {
      return await runWithRuntime(`hyper://${item.driveKey}/`, async (runtime) => {
        const drive = await runtime.getDrive(`hyper://${item.driveKey}/`, { autoJoin: false })
        let byteLength = 0
        let entries = 0

        for await (const entry of drive.list(item.path, { wait: false })) {
          entries += 1
          if (entries > MAX_OFFLINE_SIZE_ENTRIES) {
            return { byteLength, sizeTruncated: true }
          }
          if (!entry?.value?.blob) continue
          const entryBytes = Number(entry.value.blob.byteLength)
          if (Number.isSafeInteger(entryBytes) && entryBytes > 0) {
            byteLength = byteLength > Number.MAX_SAFE_INTEGER - entryBytes
              ? Number.MAX_SAFE_INTEGER
              : byteLength + entryBytes
          }
        }

        return { byteLength, sizeTruncated: false }
      })
    } catch {
      return { sizeUnavailable: true }
    }
  }

  async function findWantedItem (candidate) {
    const normalized = normalizeWantedHyperOfflineItem(candidate)
    if (!normalized) return null
    const id = getHyperOfflineItemId(normalized)
    return (await listWantedItems()).find((item) => getHyperOfflineItemId(item) === id) || null
  }

  function pruneState (items) {
    const retainedIds = new Set(items.map(getHyperOfflineItemId))
    for (const id of pausedItems) {
      if (!retainedIds.has(id)) pausedItems.delete(id)
    }
    for (const id of failedItems.keys()) {
      if (!retainedIds.has(id)) failedItems.delete(id)
    }
  }

  return { close, keep, list, pause, remove, resume, resumeAll }
}

const manager = createHyperOfflineManager({
  runWithRuntime: (address, task) => withHyperRuntimeForAddress(address, task),
  addWantedItem: addWantedHyperOfflineItem,
  listWantedItems: listWantedHyperOfflineItems,
  removeWantedItem: removeWantedHyperOfflineItem
})

export const closeHyperOfflineDownloads = manager.close
export const keepHyperOffline = manager.keep
export const listHyperOffline = manager.list
export const pauseHyperOffline = manager.pause
export const removeHyperOffline = manager.remove
export const resumeHyperOffline = manager.resume
export const resumeWantedHyperOffline = manager.resumeAll

function success (item, status, details = {}) {
  return { ok: true, item: { ...item, status, ...details } }
}

function failure (error) {
  return { ok: false, error: normalizeError(error) }
}

function resultItem (result) {
  return result.error ? { ...result.item, error: result.error } : result.item
}

function normalizeError (error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 200)
}

async function clearCachedFolder (runWithRuntime, item, retainedItems) {
  const retainedPaths = retainedItems
    .filter((candidate) => candidate.driveKey === item.driveKey)
    .map((candidate) => candidate.path)
  let clearedFiles = 0
  let clearedBytes = 0

  await runWithRuntime(`hyper://${item.driveKey}/`, async (runtime) => {
    const drive = await runtime.getDrive(`hyper://${item.driveKey}/`, { autoJoin: false })
    for await (const entry of drive.list(item.path, { wait: false })) {
      if (!entry?.value?.blob || retainedPaths.some((path) => entry.key.startsWith(path))) continue
      const result = await drive.clear(entry.key, { diff: true })
      if (!result?.blocks) continue
      clearedFiles += 1
      clearedBytes += Number(entry.value.blob.byteLength) || 0
    }
  })

  return { clearedFiles, clearedBytes }
}
