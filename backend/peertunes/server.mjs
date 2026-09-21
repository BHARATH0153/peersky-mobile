import b4a from 'b4a'
import { streamHyperAsset } from '../hyper/asset-server-core.mjs'
import { headersToObject } from '../hyper/assets.mjs'
import { parseHyperUrl } from '../hyper/url.mjs'
import { PEERTUNES_LOOPBACK_HOST, PEERTUNES_LOOPBACK_PORT } from './constants.mjs'
import peertunesAssets from './peertunes-runtime.mjs'

// Only this machine may talk to the server. Binding 127.0.0.1 is not enough on
// its own: a DNS name that resolves to loopback would still reach us, so the
// Host header has to name loopback too.
const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

// A folder listing or playlist manifest is a small document. Anything larger is
// either the wrong branch or an attempt to exhaust the worklet's heap, so it is
// refused rather than buffered.
const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024

// Content types the proxy will hand back as-is. Everything else is forced to
// application/octet-stream, because a hyper drive is untrusted input and the
// PeerTunes origin is fixed and holds the user's library.
const PROXYABLE_CONTENT_TYPES = /^(?:audio|video)\/|^image\/(?!svg\b)|^text\/plain\b|^application\/json\b/i

const STATIC_CONTENT_TYPES = {
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  png: 'image/png',
  svg: 'image/svg+xml',
  webmanifest: 'application/manifest+json'
}

// PeerTunes looks for this global and sends its hyper:// reads through it,
// because the WebView cannot fetch hyper:// on its own. The path is relative,
// so the page never handles a proxy token.
export const HYPER_BRIDGE_SCRIPT = '<script>window.peerskyHyperAsset=function(url){return"/hyper/asset?url="+encodeURIComponent(String(url))}</script>'

let server = null
let serverInfo = null
let serverTransition = Promise.resolve()
let bareHttp = null
let hyperFetchModule = null

export async function startPeerTunesServer () {
  return withServerTransition(async () => {
    if (server && serverInfo) {
      return {
        ok: true,
        running: true,
        ...serverInfo
      }
    }

    const httpImpl = await getBareHttp()
    const { ensureFetchGlobals, routedHyperFetch, routedHyperRangeFetch } = await getHyperFetchModule()
    const options = {
      httpImpl,
      fetch: routedHyperFetch,
      fetchRange: routedHyperRangeFetch,
      ensureGlobals: ensureFetchGlobals
    }

    let bound
    let usingFallbackPort = false
    try {
      bound = await bindServer(options, PEERTUNES_LOOPBACK_PORT)
    } catch (error) {
      // Something else holds the fixed port. The app still works, but the
      // library lives in the origin's IndexedDB, so a different port means the
      // user opens an empty library. Say so rather than letting it look like
      // their music vanished.
      console.warn('[peertunes] Fixed loopback port unavailable, using a random port:', error?.message || error)
      bound = await bindServer(options, 0)
      usingFallbackPort = true
    }

    server = bound.instance
    serverInfo = {
      host: PEERTUNES_LOOPBACK_HOST,
      port: bound.port,
      localUrl: `http://${PEERTUNES_LOOPBACK_HOST}:${bound.port}`,
      usingFallbackPort
    }

    return {
      ok: true,
      running: true,
      ...serverInfo
    }
  })
}

export async function stopPeerTunesServer () {
  return withServerTransition(async () => {
    if (!server) {
      serverInfo = null
      return {
        ok: true,
        running: false
      }
    }

    const existing = server
    try {
      await closeServer(existing)
    } finally {
      server = null
      serverInfo = null
    }

    return {
      ok: true,
      running: false
    }
  })
}

export function createPeerTunesHttpServer ({ httpImpl, fetch, fetchRange, ensureGlobals = () => {} } = {}) {
  if (!httpImpl?.createServer) {
    throw new Error('PeerTunes HTTP server requires an HTTP implementation.')
  }
  if (typeof fetch !== 'function') {
    throw new Error('PeerTunes HTTP server requires a Hyper fetch implementation.')
  }

  return httpImpl.createServer((req, res) => {
    handleRequest(req, res, { fetch, fetchRange, ensureGlobals })
  })
}

// Only paths that name a bundled file resolve. Dot segments, backslashes and
// broken encoding are refused before the lookup.
export function resolveStaticAsset (pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(String(pathname || '/'))
  } catch {
    return null
  }

  if (decoded.includes('\\') || decoded.includes('\0')) return null

  const key = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const segments = key.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  if (!Object.prototype.hasOwnProperty.call(peertunesAssets, key)) return null

  return { key, ...peertunesAssets[key] }
}

export function injectHyperBridge (html) {
  const source = String(html || '')
  const match = /<head[^>]*>/i.exec(source)
  if (!match) return `${HYPER_BRIDGE_SCRIPT}${source}`

  const insertAt = match.index + match[0].length
  return `${source.slice(0, insertAt)}${HYPER_BRIDGE_SCRIPT}${source.slice(insertAt)}`
}

function handleRequest (req, res, { fetch, fetchRange, ensureGlobals }) {
  const requestUrl = parseRequestUrl(req.url)
  if (!requestUrl) {
    sendText(res, 400, 'Bad request')
    return
  }

  if (!isLocalRequest(req)) {
    sendText(res, 403, 'Forbidden')
    return
  }

  if (req.method === 'OPTIONS') {
    sendEmpty(res, 204)
    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method not allowed')
    return
  }

  if (requestUrl.pathname === '/hyper/asset') {
    serveHyperAsset(req, res, { fetch, fetchRange, ensureGlobals }, requestUrl.searchParams.get('url'))
      .catch((error) => sendError(req, res, error))
    return
  }

  const asset = resolveStaticAsset(requestUrl.pathname)
  if (!asset) {
    sendText(res, 404, 'Not found')
    return
  }

  sendStaticAsset(req, res, asset)
}

async function serveHyperAsset (req, res, { fetch, fetchRange, ensureGlobals }, assetUrl) {
  if (!assetUrl) {
    sendText(res, 400, 'Missing asset url')
    return
  }

  const parsed = parseHyperUrl(assetUrl)
  if (parsed.error) {
    sendText(res, 400, parsed.error)
    return
  }

  ensureGlobals()

  // Folder listings and playlist manifests are small documents. Forwarding
  // Accept lets hypercore-fetch answer a folder with its JSON listing.
  if (wantsJson(req)) {
    const response = await fetch(assetUrl, { headers: { accept: 'application/json' } })
    if (!response.ok) {
      throw createHttpError(response.status || 502, response.statusText || 'Unable to fetch Hyper listing')
    }

    const headers = headersToObject(response.headers)
    const declaredLength = Number.parseInt(headers['content-length'] || '', 10)
    if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
      throw createHttpError(413, 'Hyper listing is too large')
    }

    const body = await readTextWithLimit(response, MAX_JSON_BODY_BYTES)
    sendText(res, 200, body, headers['content-type'] || 'application/json; charset=utf-8')
    return
  }

  await streamHyperAsset(fetch, fetchRange, assetUrl, req, guardProxyResponse(res), null)
}

function sendStaticAsset (req, res, asset) {
  const extension = asset.key.slice(asset.key.lastIndexOf('.') + 1).toLowerCase()
  const content = asset.key === 'index.html' ? injectHyperBridge(asset.content) : asset.content
  const body = asset.encoding === 'base64' ? b4a.from(content, 'base64') : b4a.from(content)

  res.statusCode = 200
  res.setHeader('Content-Type', STATIC_CONTENT_TYPES[extension] || 'application/octet-stream')
  res.setHeader('Content-Length', String(body.byteLength))
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Connection', 'close')

  if (req.method === 'HEAD') {
    res.end()
    return
  }

  res.end(body)
}

async function bindServer (options, port) {
  const instance = createPeerTunesHttpServer(options)

  try {
    const address = await listen(instance, port)
    const boundPort = typeof address === 'object' && address ? address.port : null

    if (!Number.isInteger(boundPort) || boundPort < 1) {
      throw new Error('PeerTunes server started without a valid port')
    }

    return { instance, port: boundPort }
  } catch (error) {
    try {
      instance.close()
    } catch {}

    throw error
  }
}

function listen (instance, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      instance.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      instance.off('error', onError)
      resolve(instance.address())
    }

    instance.once('error', onError)
    instance.once('listening', onListening)
    instance.listen(port, PEERTUNES_LOOPBACK_HOST)
  })
}

function closeServer (instance) {
  return new Promise((resolve, reject) => {
    instance.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function withServerTransition (task) {
  const run = serverTransition.then(task, task)
  serverTransition = run.catch(() => {})
  return run
}

async function getBareHttp () {
  if (!bareHttp) {
    const module = await import('bare-http1')
    bareHttp = module.default || module
  }

  return bareHttp
}

// Loaded lazily so tests can drive the server with a fake fetch and Node's
// http module without pulling the Hyper SDK into the process.
async function getHyperFetchModule () {
  if (!hyperFetchModule) {
    hyperFetchModule = await import('../hyper/fetch.mjs')
  }

  return hyperFetchModule
}

function wantsJson (req) {
  return /\bapplication\/json\b/i.test(getRequestHeader(req, 'accept') || '')
}

function getRequestHeader (req, name) {
  const headers = req.headers || {}
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || null
}

function isLocalRequest (req) {
  const host = getRequestHeader(req, 'host')
  if (host) {
    const hostname = String(host).replace(/:\d+$/, '').toLowerCase()
    if (!ALLOWED_HOSTNAMES.has(hostname)) return false
  }

  // A same-origin GET sends no Origin, so anything that does send one is
  // another site asking. Sec-Fetch-Site catches the no-cors loads an Origin
  // header would miss, such as <audio src> pointed at us from a web page.
  const origin = getRequestHeader(req, 'origin')
  if (origin && !isLoopbackOrigin(origin)) return false

  const fetchSite = String(getRequestHeader(req, 'sec-fetch-site') || '').toLowerCase()
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false

  return true
}

function isLoopbackOrigin (origin) {
  try {
    return ALLOWED_HOSTNAMES.has(new URL(String(origin)).hostname.toLowerCase())
  } catch {
    return false
  }
}

// The proxy carries bytes from an untrusted hyper drive. Two things must not
// escape: the wildcard CORS the shared asset streamer sets, which would let any
// website read the response, and a renderable content type, which would let a
// drive run scripts on the PeerTunes origin.
function guardProxyResponse (res) {
  return new Proxy(res, {
    get (target, property) {
      if (property === 'setHeader') {
        return (name, value) => {
          const header = String(name).toLowerCase()
          if (header.startsWith('access-control-')) return target
          if (header === 'content-type') {
            return target.setHeader(name, safeProxyContentType(value))
          }
          return target.setHeader(name, value)
        }
      }

      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

function safeProxyContentType (value) {
  const contentType = String(value || '')
  return PROXYABLE_CONTENT_TYPES.test(contentType) ? contentType : 'application/octet-stream'
}

async function readTextWithLimit (response, limit) {
  const body = response.body
  const decoder = new TextDecoder()
  let text = ''
  let seen = 0

  const push = (chunk) => {
    if (!chunk || !chunk.byteLength) return
    seen += chunk.byteLength
    if (seen > limit) throw createHttpError(413, 'Hyper listing is too large')
    text += decoder.decode(chunk, { stream: true })
  }

  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        push(value)
      }
    } finally {
      if (reader.releaseLock) reader.releaseLock()
    }
    return text + decoder.decode()
  }

  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) push(chunk)
    return text + decoder.decode()
  }

  const whole = await response.text()
  if (b4a.byteLength(whole) > limit) throw createHttpError(413, 'Hyper listing is too large')
  return whole
}

function parseRequestUrl (rawUrl) {
  try {
    return new URL(String(rawUrl || '/'), `http://${PEERTUNES_LOOPBACK_HOST}`)
  } catch {
    return null
  }
}

function sendText (res, statusCode, message, contentType = 'text/plain; charset=utf-8') {
  const body = String(message || '')
  res.statusCode = statusCode
  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Length', String(b4a.byteLength(body)))
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Connection', 'close')
  res.end(body)
}

function sendEmpty (res, statusCode) {
  res.statusCode = statusCode
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Connection', 'close')
  res.end()
}

export function sendError (req, res, error) {
  // A client that walked away is not an error worth reporting. Skipping a track
  // disconnects mid-stream, and without this guard that lands below.
  if (req?.aborted || res.destroyed) return

  if (res.headersSent) {
    // Passing a late stream error through Bare's native HTTP callback can abort
    // the JS worklet, taking hyper and PeerChat down with it. Closing the
    // incomplete response is enough for the client.
    res.destroy()
    return
  }

  sendText(res, error?.statusCode || 502, error?.message || 'PeerTunes request failed')
}

function createHttpError (statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}
