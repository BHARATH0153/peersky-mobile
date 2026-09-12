import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { connectWithAdvertisedLoopbackPort } from '../../backend/p2pmd/connect.mjs'

describe('p2pmd room connection', () => {
  it('prefers the host-advertised Holesail port', async () => {
    const calls = []
    const expected = { ok: true }

    const result = await connectWithAdvertisedLoopbackPort({
      key: 'hs://room',
      udp: false,
      log: false,
      connect: async (options) => {
        calls.push(options)
        return expected
      }
    })

    assert.equal(result, expected)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].preferRemotePort, true)
    assert.equal(Object.hasOwn(calls[0], 'port'), false)
  })

  it('does not change ports when binding the advertised port throws', async () => {
    const calls = []

    await assert.rejects(
      connectWithAdvertisedLoopbackPort({
        key: 'hs://room',
        udp: false,
        log: false,
        connect: async (options) => {
          calls.push(options)
          throw new Error('Port already in use')
        }
      }),
      /Port already in use/
    )

    assert.equal(calls.length, 1)
    assert.equal(calls[0].preferRemotePort, true)
    assert.equal(Object.hasOwn(calls[0], 'port'), false)
  })

  it('preserves an advertised-port error result without retrying', async () => {
    const calls = []
    const expected = { ok: false, error: 'Advertised port unavailable' }

    const result = await connectWithAdvertisedLoopbackPort({
      key: 'hs://room',
      udp: false,
      log: false,
      connect: async (options) => {
        calls.push(options)
        return expected
      }
    })

    assert.equal(result, expected)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].preferRemotePort, true)
    assert.equal(Object.hasOwn(calls[0], 'port'), false)
  })
})
