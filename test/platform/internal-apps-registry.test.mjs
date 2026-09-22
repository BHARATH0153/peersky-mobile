import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  INTERNAL_APPS,
  getRuntimeAppFromUrl,
  getRuntimeAppLaunchSuffix,
  getRuntimeAppTitle,
  getRuntimeAppUrl
} from '../../app/internal-apps-registry.mjs'
import {
  createPeerTunesPageUrl,
  isPeerTunesPageRequest,
  parsePeerTunesScanRequest,
  serializeScanResult
} from '../../app/peertunes/peertunes-screen.mjs'
import { buildPeerChatInviteUrl, parsePeerChatInvite } from '../../app/peerchat/peerchat-invite.mjs'

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

test('treats a same-origin URL as a PeerTunes page whatever shape it takes', () => {
  const base = 'http://127.0.0.1:47317'

  // A prefix test used to reject these and eject the user out of the app.
  assert.equal(isPeerTunesPageRequest(`${base}?x=1`, base), true)
  assert.equal(isPeerTunesPageRequest(`${base}#frag`, base), true)
  assert.equal(isPeerTunesPageRequest(`${base}/`, base), true)
  assert.equal(isPeerTunesPageRequest('HTTP://127.0.0.1:47317/', base), true)
  assert.equal(isPeerTunesPageRequest('about:blank', base), true)

  // And it must still refuse anything that only looks like the origin.
  assert.equal(isPeerTunesPageRequest('http://127.0.0.1:47317.evil.com/', base), false)
  assert.equal(isPeerTunesPageRequest('http://127.0.0.1:47318/', base), false)
  assert.equal(isPeerTunesPageRequest('https://127.0.0.1:47317/', base), false)
  assert.equal(isPeerTunesPageRequest('https://evil.example/', base), false)
})

test('only accepts scan requests the bridge itself sent', () => {
  const good = JSON.stringify({ type: 'peertunes-scan-qr', requestId: 'scan-123-abc' })
  assert.equal(parsePeerTunesScanRequest(good), 'scan-123-abc')

  // Anything else the page posts must not open the camera.
  assert.equal(parsePeerTunesScanRequest(JSON.stringify({ type: 'other', requestId: 'scan-1' })), null)
  assert.equal(parsePeerTunesScanRequest(JSON.stringify({ type: 'peertunes-scan-qr' })), null)
  assert.equal(parsePeerTunesScanRequest(JSON.stringify({ type: 'peertunes-scan-qr', requestId: 'x'.repeat(200) })), null)
  assert.equal(parsePeerTunesScanRequest('not json'), null)
  assert.equal(parsePeerTunesScanRequest(''), null)
})

test('escapes scanned text before it goes back into the page', () => {
  // Whatever was on the QR code is injected as a JavaScript literal, so it has
  // to survive quotes and the two separators that are legal JSON but not legal
  // inside a JavaScript string.
  assert.equal(serializeScanResult('hyper://abc/Classic/'), '"hyper://abc/Classic/"')
  assert.equal(serializeScanResult(null), 'null')
  assert.equal(serializeScanResult('a"b'), '"a\\"b"')
  assert.equal(serializeScanResult('a\u2028b'), '"a\\u2028b"')
  assert.equal(serializeScanResult('a\u2029b'), '"a\\u2029b"')
})

test('round-trips PeerChat invite links and refuses anything else', () => {
  const key = 'a1b2c3d4'.repeat(8)
  const link = buildPeerChatInviteUrl(key)

  assert.equal(link, `peersky://p2p/peerchat/#room=${key}`)
  assert.equal(parsePeerChatInvite(link), key)

  // A scanned QR may hold the bare key rather than a link, and case varies.
  assert.equal(parsePeerChatInvite(key.toUpperCase()), key)
  assert.equal(parsePeerChatInvite(`#room=${key.toUpperCase()}`), key)

  // The browser shell hands PeerChat the fragment as a launch suffix.
  assert.equal(getRuntimeAppFromUrl(link), 'peerchat')
  assert.equal(parsePeerChatInvite(getRuntimeAppLaunchSuffix(link)), key)

  for (const bad of ['', 'peersky://p2p/peerchat/', 'peersky://p2p/peerchat/#room=nope', 'https://evil.example/#room=' + key.slice(0, 63), 'not a link']) {
    assert.equal(parsePeerChatInvite(bad), '', `${bad} should not parse`)
  }
  assert.equal(buildPeerChatInviteUrl('short'), '')
})
