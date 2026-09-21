import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import * as commands from '../../backend/rpc/commands.mjs'
import {
  HYPER_BRIDGE_SCRIPT,
  createPeerTunesHttpServer,
  injectHyperBridge,
  resolveStaticAsset
} from '../../backend/peertunes/server.mjs'

const SONG_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])

describe('PeerTunes loopback server with injectable Node server', () => {
  let server
  let localUrl
  let fetchCalls

  beforeEach(async () => {
    fetchCalls = []
    server = createPeerTunesHttpServer({ httpImpl: http, fetch: createFakeHyperFetch(fetchCalls) })
    localUrl = await listen(server)
  })

  afterEach(async () => {
    await closeServer(server)
  })

  it('serves the app page with the hyper bridge injected right after <head>', async () => {
    const response = await fetch(`${localUrl}/`)
    const html = await response.text()

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.match(html, /<title>PeerTunes<\/title>/)
    assert.ok(html.includes(HYPER_BRIDGE_SCRIPT))
    assert.ok(html.indexOf(HYPER_BRIDGE_SCRIPT) < html.indexOf('<meta charset'))
    assert.ok(html.indexOf('<head>') < html.indexOf(HYPER_BRIDGE_SCRIPT))

    const aliasResponse = await fetch(`${localUrl}/index.html`)
    assert.equal(aliasResponse.status, 200)
    assert.equal(await aliasResponse.text(), html)
  })

  it('serves scripts, styles and svg assets with their content types', async () => {
    const cases = [
      ['/js/main.js', 'text/javascript; charset=utf-8', /window\.PT/],
      ['/css/style.css', 'text/css; charset=utf-8', /\.clickwheel/],
      ['/assets/default-cover.svg', 'image/svg+xml', /<svg/],
      ['/manifest.webmanifest', 'application/manifest+json', /"PeerTunes"/]
    ]

    for (const [path, contentType, pattern] of cases) {
      const response = await fetch(`${localUrl}${path}`)
      const body = await response.text()

      assert.equal(response.status, 200, path)
      assert.equal(response.headers.get('content-type'), contentType, path)
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path)
      assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(body), path)
      assert.match(body, pattern, path)
    }
  })

  it('answers HEAD with headers only', async () => {
    const response = await fetch(`${localUrl}/js/wheel.js`, { method: 'HEAD' })

    assert.equal(response.status, 200)
    assert.ok(Number(response.headers.get('content-length')) > 0)
    assert.equal(await response.text(), '')
  })

  it('refuses unknown files and every path that leaves the bundle', async () => {
    for (const path of ['/nope.js', '/js/', '/js/../package.json', '/%2e%2e/package.json', '/js/main.js/', '/LICENSE', '/manifest.json']) {
      const response = await rawRequest(localUrl, path)
      assert.equal(response.status, 404, path)
    }

    // Dot segments are collapsed by the URL parser first, so this lands on a
    // bundled file and is fine to serve.
    const normalized = await rawRequest(localUrl, '/assets/../js/main.js')
    assert.equal(normalized.status, 200)
  })

  it('rejects writes, so the in-app publish probe fails cleanly', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await fetch(`${localUrl}/?key=peertunes`, { method, body: 'x' })
      assert.equal(response.status, 405, method)
    }

    const assetWrite = await fetch(`${localUrl}/hyper/asset?url=hyper://abc/song.mp3`, { method: 'PUT', body: 'x' })
    assert.equal(assetWrite.status, 405)

    const preflight = await fetch(`${localUrl}/`, { method: 'OPTIONS' })
    assert.equal(preflight.status, 204)
  })

  it('validates the hyper asset url before touching the network', async () => {
    const missing = await fetch(`${localUrl}/hyper/asset`)
    assert.equal(missing.status, 400)

    const wrongScheme = await fetch(`${localUrl}/hyper/asset?url=${encodeURIComponent('https://example.com/song.mp3')}`)
    assert.equal(wrongScheme.status, 400)
    assert.match(await wrongScheme.text(), /Only hyper:\/\/ URLs are supported/)

    const badPath = await fetch(`${localUrl}/hyper/asset?url=${encodeURIComponent('hyper://abc/..%2F..%2Fetc')}`)
    assert.equal(badPath.status, 400)

    assert.equal(fetchCalls.length, 0)
  })

  it('forwards Accept for folder listings so hypercore-fetch answers with JSON', async () => {
    const response = await fetch(`${localUrl}/hyper/asset?url=${encodeURIComponent('hyper://abc/music/')}`, {
      headers: { Accept: 'application/json' }
    })
    const listing = await response.json()

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
    assert.deepEqual(listing, ['01 Song.mp3', 'covers/'])
    assert.equal(fetchCalls.length, 1)
    assert.equal(fetchCalls[0].url, 'hyper://abc/music/')
    assert.equal(fetchCalls[0].options.headers.accept, 'application/json')
  })

  it('streams song bytes and honours range requests', async () => {
    const full = await fetch(`${localUrl}/hyper/asset?url=${encodeURIComponent('hyper://abc/music/01 Song.mp3')}`)
    const fullBytes = new Uint8Array(await full.arrayBuffer())

    assert.equal(full.status, 200)
    assert.equal(full.headers.get('content-type'), 'audio/mpeg')
    assert.equal(full.headers.get('accept-ranges'), 'bytes')
    assert.deepEqual(fullBytes, SONG_BYTES)

    const partial = await fetch(`${localUrl}/hyper/asset?url=${encodeURIComponent('hyper://abc/music/01 Song.mp3')}`, {
      headers: { Range: 'bytes=0-3' }
    })
    const partialBytes = new Uint8Array(await partial.arrayBuffer())

    assert.equal(partial.status, 206)
    assert.equal(partial.headers.get('content-range'), `bytes 0-3/${SONG_BYTES.length}`)
    assert.deepEqual(partialBytes, SONG_BYTES.subarray(0, 4))
    assert.equal(fetchCalls[1].options.headers.get('range'), 'bytes=0-3')
  })

  it('maps upstream failures to an error status without crashing', async () => {
    const response = await fetch(`${localUrl}/hyper/asset?url=${encodeURIComponent('hyper://abc/missing.mp3')}`)
    assert.equal(response.status, 404)
  })
})

describe('PeerTunes server helpers', () => {
  it('resolves only bundled files', () => {
    assert.equal(resolveStaticAsset('/').key, 'index.html')
    assert.equal(resolveStaticAsset('/js/ui.js').key, 'js/ui.js')
    assert.equal(resolveStaticAsset('/js/../index.html'), null)
    assert.equal(resolveStaticAsset('/./index.html'), null)
    assert.equal(resolveStaticAsset('/js\\ui.js'), null)
    assert.equal(resolveStaticAsset('/%E0%A4%A'), null)
    assert.equal(resolveStaticAsset('/README.md'), null)
    assert.equal(resolveStaticAsset('/LICENSE'), null)
  })

  it('injects the bridge after <head>, or first when there is no head', () => {
    assert.equal(
      injectHyperBridge('<html><head lang="en"><meta></head></html>'),
      `<html><head lang="en">${HYPER_BRIDGE_SCRIPT}<meta></head></html>`
    )
    assert.equal(injectHyperBridge('<p>hi</p>'), `${HYPER_BRIDGE_SCRIPT}<p>hi</p>`)
  })

  it('keeps the bridge path relative so no proxy token reaches the page', () => {
    assert.ok(!/token/i.test(HYPER_BRIDGE_SCRIPT))
    assert.match(HYPER_BRIDGE_SCRIPT, /"\/hyper\/asset\?url="/)
  })
})

describe('PeerTunes RPC command', () => {
  it('uses a command id that no other RPC shares', () => {
    const ids = Object.entries(commands)
      .filter(([name]) => name.startsWith('RPC_'))
      .map(([, value]) => value)

    assert.equal(commands.RPC_PEERTUNES_START, 70)
    assert.equal(new Set(ids).size, ids.length)
  })
})

function createFakeHyperFetch (calls) {
  return async (url, options = {}) => {
    calls.push({ url, options })

    if (url === 'hyper://abc/music/') {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
        text: async () => JSON.stringify(['01 Song.mp3', 'covers/'])
      }
    }

    if (url === 'hyper://abc/music/01 Song.mp3') {
      const rangeHeader = readHeader(options.headers, 'range')
      const range = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader || '')
      const start = range ? Number(range[1]) : 0
      const end = range ? (range[2] ? Number(range[2]) : SONG_BYTES.length - 1) : SONG_BYTES.length - 1
      const chunk = SONG_BYTES.subarray(start, end + 1)
      const headers = {
        'content-type': 'audio/mpeg',
        'content-length': String(chunk.byteLength),
        'accept-ranges': 'bytes'
      }
      if (range) headers['content-range'] = `bytes ${start}-${end}/${SONG_BYTES.length}`

      return {
        ok: true,
        status: range ? 206 : 200,
        statusText: 'OK',
        headers: new Headers(headers),
        body: (async function * () { yield chunk })()
      }
    }

    return {
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Headers(),
      text: async () => 'not found'
    }
  }
}

function readHeader (headers, name) {
  if (!headers) return null
  if (typeof headers.get === 'function') return headers.get(name)
  return headers[name] || headers[name.toLowerCase()] || null
}

function rawRequest (baseUrl, path) {
  const { hostname, port } = new URL(baseUrl)
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname, port, path, method: 'GET' }, (response) => {
      response.resume()
      response.on('end', () => resolve({ status: response.statusCode }))
    })
    request.on('error', reject)
    request.end()
  })
}

function listen (instance) {
  return new Promise((resolve, reject) => {
    instance.once('error', reject)
    instance.listen(0, '127.0.0.1', () => {
      const address = instance.address()
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function closeServer (instance) {
  return new Promise((resolve) => {
    instance.close(() => resolve())
  })
}
