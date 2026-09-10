import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHyperOfflineManager } from '../../backend/hyper/offline-manager.mjs'

const DRIVE_KEY = 'a'.repeat(64)
const FOLDER_URL = `hyper://${DRIVE_KEY}/docs/`

test('persists intent before downloading and verifies completion with has', async () => {
  const events = []
  const drive = createDrive({
    has: sequence(false, true),
    onDownload: () => events.push('download')
  })
  const harness = createHarness(drive, {
    onAdd: () => events.push('persist')
  })

  const result = await harness.manager.keep({ url: FOLDER_URL })

  assert.equal(result.ok, true)
  assert.equal(result.item.status, 'available')
  assert.deepEqual(events, ['persist', 'download'])
  assert.equal(drive.downloadCalls, 1)
  assert.equal(drive.hasCalls, 2)
})

test('deduplicates concurrent downloads for the same folder', async () => {
  const pending = deferred()
  const drive = createDrive({
    has: sequence(false, true),
    done: () => pending.promise
  })
  const harness = createHarness(drive)

  const first = harness.manager.keep({ url: FOLDER_URL })
  await waitFor(() => drive.downloadCalls === 1)
  const second = harness.manager.keep({ url: FOLDER_URL })
  pending.resolve()

  const results = await Promise.all([first, second])
  assert.equal(results.every((result) => result.item.status === 'available'), true)
  assert.equal(drive.downloadCalls, 1)
})

test('pauses an active download by destroying it', async () => {
  const pending = deferred()
  const drive = createDrive({
    has: () => false,
    done: () => pending.promise,
    onDestroy: () => pending.resolve()
  })
  const harness = createHarness(drive)
  const keeping = harness.manager.keep({ url: FOLDER_URL })
  await waitFor(() => drive.downloadCalls === 1)

  const paused = await harness.manager.pause({ driveKey: DRIVE_KEY, path: '/docs/' })
  const completed = await keeping

  assert.equal(paused.item.status, 'paused')
  assert.equal(completed.item.status, 'paused')
  assert.equal(drive.destroyCalls, 1)
})

test('resumes a paused download without creating another manifest entry', async () => {
  const firstDownload = deferred()
  const drive = createDrive({
    has: sequence(false, false, true),
    done: (call) => call === 1 ? firstDownload.promise : Promise.resolve(),
    onDestroy: () => firstDownload.resolve()
  })
  const harness = createHarness(drive)
  const keeping = harness.manager.keep({ url: FOLDER_URL })
  await waitFor(() => drive.downloadCalls === 1)
  await harness.manager.pause({ driveKey: DRIVE_KEY, path: '/docs/' })
  await keeping

  const resumed = await harness.manager.resume({ driveKey: DRIVE_KEY, path: '/docs/' })

  assert.equal(resumed.item.status, 'available')
  assert.equal(drive.downloadCalls, 2)
  assert.equal(harness.addCalls, 1)
})

test('starts a resumable download without holding the caller open', async () => {
  const pending = deferred()
  const drive = createDrive({
    has: sequence(false, true),
    done: () => pending.promise
  })
  const harness = createHarness(drive, {
    items: [{ driveKey: DRIVE_KEY, path: '/docs/', wantedAt: 1 }]
  })

  const result = await harness.manager.resume({ driveKey: DRIVE_KEY, path: '/docs/', wait: false })

  assert.equal(result.item.status, 'downloading')
  await waitFor(() => drive.downloadCalls === 1)
  assert.equal(drive.downloadCalls, 1)
  pending.resolve()
  await waitFor(() => drive.hasCalls === 2)
})

test('waits for Wi-Fi instead of resuming incomplete folders', async () => {
  const drive = createDrive({ has: () => false })
  const harness = createHarness(drive, {
    items: [{ driveKey: DRIVE_KEY, path: '/docs/', wantedAt: 1 }]
  })

  const result = await harness.manager.resumeAll({ allowNetwork: false })

  assert.equal(result.ok, true)
  assert.equal(result.items[0].status, 'waiting-for-wifi')
  assert.equal(drive.downloadCalls, 0)
})

test('keeps new folders waiting without starting on a blocked network', async () => {
  const drive = createDrive({ has: () => false })
  const harness = createHarness(drive)

  const result = await harness.manager.keep({ url: FOLDER_URL, allowNetwork: false })

  assert.equal(result.ok, true)
  assert.equal(result.item.status, 'waiting-for-wifi')
  assert.equal(harness.items.length, 1)
  assert.equal(drive.downloadCalls, 0)
})

test('stops active automatic downloads when Wi-Fi becomes unavailable', async () => {
  const pending = deferred()
  const drive = createDrive({
    has: () => false,
    done: () => pending.promise,
    onDestroy: () => pending.resolve()
  })
  const harness = createHarness(drive, {
    items: [{ driveKey: DRIVE_KEY, path: '/docs/', wantedAt: 1 }]
  })
  const keeping = harness.manager.resume({ driveKey: DRIVE_KEY, path: '/docs/', wait: false })
  await waitFor(() => drive.downloadCalls === 1)

  const result = await harness.manager.resumeAll({ allowNetwork: false })
  await keeping

  assert.equal(result.items[0].status, 'waiting-for-wifi')
  assert.equal(drive.destroyCalls, 1)
})

test('reports an incomplete download as an error', async () => {
  const drive = createDrive({ has: () => false })
  const harness = createHarness(drive)

  const result = await harness.manager.keep({ url: FOLDER_URL })
  const listed = await harness.manager.list()

  assert.equal(result.ok, false)
  assert.match(result.error, /did not complete/)
  assert.equal(listed.items[0].status, 'error')
})

test('reports the bounded content size of an available offline folder', async () => {
  const drive = createDrive({
    entries: [
      { key: '/docs/one.txt', value: { blob: { byteLength: 10 } } },
      { key: '/docs/two.txt', value: { blob: { byteLength: 20 } } },
      { key: '/docs/link', value: { blob: null } }
    ]
  })
  const harness = createHarness(drive, {
    items: [{ driveKey: DRIVE_KEY, path: '/docs/', wantedAt: 1 }]
  })

  const result = await harness.manager.list()

  assert.equal(result.items[0].status, 'available')
  assert.equal(result.items[0].byteLength, 30)
  assert.equal(result.items[0].sizeTruncated, false)
})

test('limits a status request to one validated offline folder', async () => {
  const otherKey = 'b'.repeat(64)
  const drive = createDrive()
  const harness = createHarness(drive, {
    items: [
      { driveKey: DRIVE_KEY, path: '/docs/', wantedAt: 1 },
      { driveKey: otherKey, path: '/media/', wantedAt: 2 }
    ]
  })

  const result = await harness.manager.list({ driveKey: DRIVE_KEY, path: '/docs/' })
  const invalid = await harness.manager.list({ driveKey: DRIVE_KEY, path: '../docs/' })

  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].path, '/docs/')
  assert.equal(invalid.ok, false)
  assert.deepEqual(invalid.items, [])
})

test('bounds offline size scans even for entries without blobs', async () => {
  const entries = Array.from({ length: 5001 }, (_, index) => ({
    key: `/docs/link-${index}`,
    value: { blob: null }
  }))
  const drive = createDrive({ entries })
  const harness = createHarness(drive, {
    items: [{ driveKey: DRIVE_KEY, path: '/docs/', wantedAt: 1 }]
  })

  const result = await harness.manager.list()

  assert.equal(result.items[0].byteLength, 0)
  assert.equal(result.items[0].sizeTruncated, true)
})

test('closes every in-flight download without clearing wanted items', async () => {
  const pending = deferred()
  const drive = createDrive({
    has: () => false,
    done: () => pending.promise,
    onDestroy: () => pending.resolve()
  })
  const harness = createHarness(drive)
  const keeping = harness.manager.keep({ url: FOLDER_URL })
  await waitFor(() => drive.downloadCalls === 1)

  await harness.manager.close()
  await keeping

  assert.equal(drive.destroyCalls, 1)
  assert.equal(harness.items.length, 1)
})

test('removes an active offline folder after cancelling its download', async () => {
  const pending = deferred()
  const events = []
  const drive = createDrive({
    has: () => false,
    entries: [{ key: '/docs/readme.md', value: { blob: { byteLength: 24 } } }],
    done: () => pending.promise,
    onDestroy: () => {
      events.push('destroy')
      pending.resolve()
    },
    onClear: () => events.push('clear')
  })
  const harness = createHarness(drive, {
    onRemove: () => events.push('remove')
  })
  const keeping = harness.manager.keep({ url: FOLDER_URL })
  await waitFor(() => drive.downloadCalls === 1)

  const removed = await harness.manager.remove({ driveKey: DRIVE_KEY, path: '/docs/' })
  await keeping

  assert.equal(removed.ok, true)
  assert.equal(removed.item.status, 'removed')
  assert.equal(removed.cacheCleared, true)
  assert.equal(removed.clearedFiles, 1)
  assert.equal(removed.clearedBytes, 24)
  assert.deepEqual(events, ['destroy', 'remove', 'clear'])
  assert.equal(harness.items.length, 0)
})

test('preserves cached files covered by another wanted folder', async () => {
  const retained = { driveKey: DRIVE_KEY, path: '/docs/keep/', wantedAt: 2 }
  const removed = { driveKey: DRIVE_KEY, path: '/docs/', wantedAt: 1 }
  const drive = createDrive({
    entries: [
      { key: '/docs/drop.txt', value: { blob: { byteLength: 10 } } },
      { key: '/docs/keep/retained.txt', value: { blob: { byteLength: 20 } } },
      { key: '/outside.txt', value: { blob: { byteLength: 30 } } }
    ]
  })
  const harness = createHarness(drive, { items: [retained, removed] })

  const result = await harness.manager.remove(removed)

  assert.equal(result.ok, true)
  assert.deepEqual(drive.clearPaths, ['/docs/drop.txt'])
  assert.deepEqual(harness.items, [retained])
})

test('does not clear cached files when removing the wanted intent fails', async () => {
  const item = { driveKey: DRIVE_KEY, path: '/docs/', wantedAt: 1 }
  const drive = createDrive({
    entries: [{ key: '/docs/readme.md', value: { blob: { byteLength: 24 } } }]
  })
  const harness = createHarness(drive, { items: [item], removeResult: false })

  const result = await harness.manager.remove(item)

  assert.equal(result.ok, false)
  assert.match(result.error, /Unable to remove/)
  assert.deepEqual(drive.clearPaths, [])
  assert.deepEqual(harness.items, [item])
})

test('reports cache cleanup failure without undoing a removed intent', async () => {
  const item = { driveKey: DRIVE_KEY, path: '/docs/', wantedAt: 1 }
  const drive = createDrive({ listError: new Error('cache unavailable') })
  const harness = createHarness(drive, { items: [item] })

  const result = await harness.manager.remove(item)

  assert.equal(result.ok, true)
  assert.equal(result.item.status, 'removed')
  assert.equal(result.cacheCleared, false)
  assert.match(result.warning, /cache unavailable/)
  assert.deepEqual(harness.items, [])
})

function createHarness (drive, {
  items = [],
  onAdd = () => {},
  onRemove = () => {},
  removeResult = true
} = {}) {
  const wanted = [...items]
  let addCalls = 0
  let removeCalls = 0
  const manager = createHyperOfflineManager({
    runWithRuntime: (_address, task) => task({
      getDrive: async () => drive
    }),
    addWantedItem: async (item) => {
      addCalls += 1
      onAdd(item)
      const index = wanted.findIndex((value) => value.driveKey === item.driveKey && value.path === item.path)
      if (index !== -1) wanted.splice(index, 1)
      wanted.unshift(item)
      return true
    },
    listWantedItems: async () => [...wanted],
    removeWantedItem: async (item) => {
      removeCalls += 1
      onRemove(item)
      if (!removeResult) return false
      const index = wanted.findIndex((value) => value.driveKey === item.driveKey && value.path === item.path)
      if (index !== -1) wanted.splice(index, 1)
      return true
    }
  })

  return {
    manager,
    items: wanted,
    get addCalls () { return addCalls },
    get removeCalls () { return removeCalls }
  }
}

function createDrive ({
  has = () => true,
  done = () => Promise.resolve(),
  entries = [],
  listError = null,
  onDownload = () => {},
  onDestroy = () => {},
  onClear = () => {}
} = {}) {
  return {
    id: DRIVE_KEY,
    downloadCalls: 0,
    destroyCalls: 0,
    hasCalls: 0,
    clearPaths: [],
    async has (path) {
      this.hasCalls += 1
      return has(this.hasCalls, path)
    },
    download (path) {
      this.downloadCalls += 1
      const call = this.downloadCalls
      onDownload(path)
      return {
        done: () => done(call, path),
        destroy: () => {
          this.destroyCalls += 1
          onDestroy(call, path)
        }
      }
    },
    async * list (path) {
      if (listError) throw listError
      for (const entry of entries) {
        if (entry.key.startsWith(path)) yield entry
      }
    },
    async clear (path) {
      this.clearPaths.push(path)
      onClear(path)
      return { blocks: 1 }
    }
  }
}

function sequence (...values) {
  return (call) => values[Math.min(call - 1, values.length - 1)]
}

function deferred () {
  let resolvePromise
  const promise = new Promise((resolve) => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

async function waitFor (condition) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('Timed out waiting for test condition.')
}
