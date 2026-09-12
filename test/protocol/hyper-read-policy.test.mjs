import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { create as createSDK } from 'hyper-sdk'
import {
  configureHyperReadTimeout,
  DEFAULT_HYPER_READ_TIMEOUT_MS
} from '../../backend/hyper/read-policy.mjs'

test('configures current and future Hyperdrive cores with a bounded read timeout', () => {
  let blobsListener
  const drive = {
    core: { timeout: 0 },
    once (event, listener) {
      assert.equal(event, 'blobs')
      blobsListener = listener
    }
  }

  configureHyperReadTimeout(drive)
  assert.equal(drive.core.timeout, DEFAULT_HYPER_READ_TIMEOUT_MS)

  const blobs = { core: { timeout: 0 } }
  blobsListener(blobs)
  assert.equal(blobs.core.timeout, DEFAULT_HYPER_READ_TIMEOUT_MS)
})

test('reads cached blocks after restart and bounds missing offline reads', { timeout: 10000 }, async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'peersky-offline-read-'))
  let sdk = null

  try {
    sdk = await createSDK({
      storage,
      swarmOpts: { bootstrap: [], port: 0 }
    })
    let drive = await sdk.getDrive('offline-read-test')
    await drive.put('/cached.txt', Buffer.from('available offline'))
    await drive.put('/missing.txt', Buffer.from('remove this block'))
    await drive.getBlobs()
    await drive.clear('/missing.txt')
    await sdk.close()

    sdk = await createSDK({
      storage,
      swarmOpts: { bootstrap: [], port: 0 }
    })
    drive = await sdk.getDrive('offline-read-test')
    configureHyperReadTimeout(drive, { timeoutMs: 100 })

    assert.equal(await drive.has('/cached.txt'), true)
    assert.equal((await drive.get('/cached.txt')).toString(), 'available offline')
    assert.equal(await drive.has('/missing.txt'), false)

    const startedAt = Date.now()
    await assert.rejects(
      drive.get('/missing.txt'),
      (error) => error?.code === 'REQUEST_TIMEOUT'
    )
    assert.equal(Date.now() - startedAt < 2000, true)
  } finally {
    await sdk?.close().catch(() => {})
    await rm(storage, { recursive: true, force: true })
  }
})
