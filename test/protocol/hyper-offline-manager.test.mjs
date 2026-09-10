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

test('reports an incomplete download as an error', async () => {
  const drive = createDrive({ has: () => false })
  const harness = createHarness(drive)

  const result = await harness.manager.keep({ url: FOLDER_URL })
  const listed = await harness.manager.list()

  assert.equal(result.ok, false)
  assert.match(result.error, /did not complete/)
  assert.equal(listed.items[0].status, 'error')
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

function createHarness (drive, { items = [], onAdd = () => {} } = {}) {
  const wanted = [...items]
  let addCalls = 0
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
    listWantedItems: async () => [...wanted]
  })

  return {
    manager,
    items: wanted,
    get addCalls () { return addCalls }
  }
}

function createDrive ({
  has = () => true,
  done = () => Promise.resolve(),
  onDownload = () => {},
  onDestroy = () => {}
} = {}) {
  return {
    id: DRIVE_KEY,
    downloadCalls: 0,
    destroyCalls: 0,
    hasCalls: 0,
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
