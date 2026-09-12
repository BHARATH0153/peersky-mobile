import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  MAX_HYPER_OFFLINE_ENTRIES,
  parseHyperOfflineManifest,
  recordWantedHyperOfflineItem,
  removeWantedHyperOfflineItem,
  serializeHyperOfflineManifest
} from '../../backend/hyper/offline-core.mjs'
import {
  addWantedHyperOfflineItem,
  clearWantedHyperOfflineItems,
  listWantedHyperOfflineItems,
  removeWantedHyperOfflineItem as removePersistedHyperOfflineItem
} from '../../backend/hyper/offline-manifest.mjs'

const DRIVE_A = 'a'.repeat(64)
const DRIVE_B = 'b'.repeat(64)

test('normalizes and deduplicates wanted offline folders', () => {
  let items = recordWantedHyperOfflineItem([], {
    driveKey: DRIVE_A.toUpperCase(),
    path: '/docs'
  }, 10)

  items = recordWantedHyperOfflineItem(items, {
    driveKey: DRIVE_A,
    path: '/docs/'
  }, 20)

  assert.deepEqual(items, [{
    driveKey: DRIVE_A,
    path: '/docs/',
    wantedAt: 20
  }])
})

test('rejects malformed keys and unsafe paths', () => {
  const parsed = parseHyperOfflineManifest(JSON.stringify({
    items: [
      { driveKey: 'invalid', path: '/', wantedAt: 1 },
      { driveKey: DRIVE_A, path: '/../private/', wantedAt: 2 },
      { driveKey: DRIVE_A, path: '/docs/?query=yes', wantedAt: 3 },
      { driveKey: DRIVE_B, path: '/safe/./folder', wantedAt: 4 }
    ]
  }))

  assert.deepEqual(parsed, [{
    driveKey: DRIVE_B,
    path: '/safe/folder/',
    wantedAt: 4
  }])
})

test('bounds manifest growth and removes one exact folder', () => {
  let items = []
  for (let index = 0; index < MAX_HYPER_OFFLINE_ENTRIES + 20; index += 1) {
    items = recordWantedHyperOfflineItem(items, {
      driveKey: DRIVE_A,
      path: `/folder-${index}/`
    }, index + 1)
  }

  assert.equal(items.length, MAX_HYPER_OFFLINE_ENTRIES)
  assert.equal(items[0].path, `/folder-${MAX_HYPER_OFFLINE_ENTRIES + 19}/`)
  assert.equal(
    removeWantedHyperOfflineItem(items, {
      driveKey: DRIVE_A,
      path: items[0].path
    }).length,
    MAX_HYPER_OFFLINE_ENTRIES - 1
  )
})

test('round trips a normalized manifest', () => {
  const serialized = serializeHyperOfflineManifest([
    { driveKey: DRIVE_A, path: '/', wantedAt: 1 },
    { driveKey: DRIVE_A, path: '/', wantedAt: 2 },
    { driveKey: DRIVE_B, path: '/media', wantedAt: 3 }
  ])

  assert.deepEqual(parseHyperOfflineManifest(serialized), [
    { driveKey: DRIVE_A, path: '/', wantedAt: 1 },
    { driveKey: DRIVE_B, path: '/media/', wantedAt: 3 }
  ])
})

test('persists wanted folders atomically and clears them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'peersky-hyper-offline-'))
  const storagePath = join(directory, 'hyper-sdk')

  try {
    assert.equal(await addWantedHyperOfflineItem({
      driveKey: 'invalid',
      path: '/docs/'
    }, storagePath), false)
    assert.equal(await addWantedHyperOfflineItem({
      driveKey: DRIVE_A,
      path: '/docs/'
    }, storagePath), true)
    assert.equal(await addWantedHyperOfflineItem({
      driveKey: DRIVE_B,
      path: '/media/'
    }, storagePath), true)

    assert.deepEqual(
      (await listWantedHyperOfflineItems(storagePath)).map((item) => item.path),
      ['/media/', '/docs/']
    )

    assert.equal(await removePersistedHyperOfflineItem({
      driveKey: DRIVE_A,
      path: '/docs/'
    }, storagePath), true)
    assert.deepEqual(
      (await listWantedHyperOfflineItems(storagePath)).map((item) => item.path),
      ['/media/']
    )

    assert.equal(await clearWantedHyperOfflineItems(storagePath), true)
    assert.deepEqual(await listWantedHyperOfflineItems(storagePath), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
