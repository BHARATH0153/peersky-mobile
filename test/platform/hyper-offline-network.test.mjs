import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canUseNetworkForOfflineHyper } from '../../app/hyperdrive/offline-network.mjs'

test('allows every network when the Wi-Fi-only preference is disabled', () => {
  assert.equal(canUseNetworkForOfflineHyper({
    downloadOnlyOnWifi: false,
    isConnected: true,
    type: 'CELLULAR'
  }), true)
})

test('allows offline downloads only on a connected Wi-Fi network', () => {
  assert.equal(canUseNetworkForOfflineHyper({
    downloadOnlyOnWifi: true,
    isConnected: true,
    type: 'WIFI'
  }), true)
  assert.equal(canUseNetworkForOfflineHyper({
    downloadOnlyOnWifi: true,
    isConnected: true,
    type: 'CELLULAR'
  }), false)
  assert.equal(canUseNetworkForOfflineHyper({
    downloadOnlyOnWifi: true,
    isConnected: undefined,
    type: undefined
  }), false)
})
