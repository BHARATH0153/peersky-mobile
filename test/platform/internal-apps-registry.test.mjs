import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  INTERNAL_APPS,
  getRuntimeAppFromUrl,
  getRuntimeAppLaunchSuffix,
  getRuntimeAppTitle,
  getRuntimeAppUrl
} from '../../app/internal-apps-registry.mjs'
import { createPeerTunesPageUrl, isPeerTunesPageRequest } from '../../app/peertunes/peertunes-screen.mjs'

describe('internal app registry', () => {
  test('registers PeerTunes as a p2p app route', () => {
    const app = INTERNAL_APPS.find((item) => item.id === 'peertunes')

    assert.deepEqual(app, {
      id: 'peertunes',
      title: 'PeerTunes',
      url: 'peersky://p2p/peertunes/',
      icon: 'PT'
    })
    assert.equal(getRuntimeAppUrl('peertunes'), 'peersky://p2p/peertunes/')
    assert.equal(getRuntimeAppTitle('peertunes'), 'PeerTunes')
    assert.equal(new Set(INTERNAL_APPS.map((item) => item.id)).size, INTERNAL_APPS.length)
  })

  test('matches app urls with or without a trailing slash, query or fragment', () => {
    assert.equal(getRuntimeAppFromUrl('peersky://p2p/peertunes'), 'peertunes')
    assert.equal(getRuntimeAppFromUrl('peersky://p2p/peertunes/'), 'peertunes')
    assert.equal(getRuntimeAppFromUrl('PEERSKY://P2P/PeerTunes/'), 'peertunes')
    assert.equal(getRuntimeAppFromUrl('peersky://p2p/peertunes/#playlist=hyper%3A%2F%2Fabc%2Fmix%2F'), 'peertunes')
    assert.equal(getRuntimeAppFromUrl('peersky://p2p/peertunes/?src=hyper%3A%2F%2Fabc%2F'), 'peertunes')
    assert.equal(getRuntimeAppFromUrl('peersky://p2p/p2pmd/?x=1'), 'p2pmd')
    assert.equal(getRuntimeAppFromUrl('peersky://hyper'), 'hyper')
    assert.equal(getRuntimeAppFromUrl('peersky://p2p/peertunes-extra/'), null)
    assert.equal(getRuntimeAppFromUrl('https://example.com/#peersky://p2p/peertunes/'), null)
  })

  test('hands share link payloads to the app and drops anything unsafe', () => {
    assert.equal(getRuntimeAppLaunchSuffix('peersky://p2p/peertunes/#playlist=hyper%3A%2F%2Fabc%2Fmix%2F'), '#playlist=hyper%3A%2F%2Fabc%2Fmix%2F')
    assert.equal(getRuntimeAppLaunchSuffix('peersky://p2p/peertunes/?src=hyper%3A%2F%2Fabc%2F'), '?src=hyper%3A%2F%2Fabc%2F')
    assert.equal(getRuntimeAppLaunchSuffix('peersky://p2p/peertunes/'), '')
    assert.equal(getRuntimeAppLaunchSuffix(''), '')
    assert.equal(getRuntimeAppLaunchSuffix('peersky://p2p/peertunes/#a b'), '')
    assert.equal(getRuntimeAppLaunchSuffix('peersky://p2p/peertunes/#<script>'), '')
    assert.equal(getRuntimeAppLaunchSuffix(`peersky://p2p/peertunes/#${'x'.repeat(5000)}`), '')
  })
})

describe('PeerTunes screen helpers', () => {
  test('builds the page url on the loopback origin with the share payload', () => {
    assert.equal(createPeerTunesPageUrl('http://127.0.0.1:47317'), 'http://127.0.0.1:47317/')
    assert.equal(createPeerTunesPageUrl('http://127.0.0.1:47317/', '#playlist=x'), 'http://127.0.0.1:47317/#playlist=x')
    assert.equal(createPeerTunesPageUrl(null, '#playlist=x'), '')
  })

  test('only lets the app origin navigate inside the WebView', () => {
    const localUrl = 'http://127.0.0.1:47317'

    assert.equal(isPeerTunesPageRequest('http://127.0.0.1:47317/', localUrl), true)
    assert.equal(isPeerTunesPageRequest('http://127.0.0.1:47317/#playlist=x', localUrl), true)
    assert.equal(isPeerTunesPageRequest('about:blank', localUrl), true)
    assert.equal(isPeerTunesPageRequest('http://127.0.0.1:47318/', localUrl), false)
    assert.equal(isPeerTunesPageRequest('https://github.com/p2plabsxyz/peertunes', localUrl), false)
    assert.equal(isPeerTunesPageRequest('http://127.0.0.1:47317.evil.com/', localUrl), false)
    assert.equal(isPeerTunesPageRequest('http://127.0.0.1:47317/', null), false)
  })
})
