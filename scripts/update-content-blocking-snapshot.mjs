import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FILTER_LIST_SOURCES,
  MAX_FILTER_LIST_BYTES,
  validateFilterListSnapshot
} from '../app/privacy/filter-lists.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = path.join(projectRoot, 'assets', 'content-blocking')
const temporaryDirectory = `${outputDirectory}.tmp`
const backupDirectory = `${outputDirectory}.previous`
const timeoutMs = 30_000
const retryDelaysMs = [2_000, 8_000, 20_000]
const maxRetryAfterMs = 60_000

await rm(temporaryDirectory, { force: true, recursive: true })
await rm(backupDirectory, { force: true, recursive: true })
await mkdir(temporaryDirectory, { recursive: true })

let previousSnapshotMoved = false
try {
  await copyFile(
    path.join(outputDirectory, 'LICENSE'),
    path.join(temporaryDirectory, 'LICENSE')
  )
  const lists = []
  for (const source of FILTER_LIST_SOURCES) {
    const bytes = await downloadBoundedList(source)
    const filename = `${source.id}.txt`
    await writeFile(path.join(temporaryDirectory, filename), bytes)
    lists.push({
      id: source.id,
      title: source.title,
      url: source.url,
      filename,
      byteLength: bytes.byteLength,
      version: readListVersion(bytes)
    })
  }

  const generatedAt = new Date().toISOString()
  await writeFile(path.join(temporaryDirectory, 'manifest.json'), `${JSON.stringify({
    generatedAt,
    lists
  }, null, 2)}\n`)
  try {
    await rename(outputDirectory, backupDirectory)
    previousSnapshotMoved = true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await rename(temporaryDirectory, outputDirectory)
  await rm(backupDirectory, { force: true, recursive: true })
  previousSnapshotMoved = false
  console.log(`Updated bundled content-blocking snapshot (${generatedAt}).`)
} catch (error) {
  await rm(temporaryDirectory, { force: true, recursive: true })
  if (previousSnapshotMoved) {
    await rm(outputDirectory, { force: true, recursive: true })
    await rename(backupDirectory, outputDirectory)
  }
  throw error
}

async function downloadBoundedList (source) {
  let lastError
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    try {
      return await downloadBoundedListOnce(source)
    } catch (error) {
      lastError = error
      if (error?.retryable === false || attempt === retryDelaysMs.length) throw error

      const retryAfterMs = Number.isFinite(error?.retryAfterMs)
        ? Math.min(maxRetryAfterMs, Math.max(0, error.retryAfterMs))
        : 0
      const jitterMs = Math.floor(Math.random() * 1_000)
      const delayMs = Math.max(retryDelaysMs[attempt], retryAfterMs) + jitterMs
      console.warn(`${source.title} download failed (${error.message}); retrying in ${delayMs}ms (${attempt + 2}/${retryDelaysMs.length + 1}).`)
      await delay(delayMs)
    }
  }
  throw lastError
}

async function downloadBoundedListOnce (source) {
  const bytes = await downloadListUrl(source.url, {
    title: source.title,
    timeoutMs,
    maxBytes: MAX_FILTER_LIST_BYTES,
    maxRedirects: 5
  })

  const validation = validateFilterListSnapshot({
    id: source.id,
    byteLength: bytes.byteLength,
    preamble: bytes.subarray(0, 512).toString('latin1')
  })
  if (!validation.ok) throw permanentError(`${source.title}: ${validation.error}`)
  return bytes
}

function downloadListUrl (url, { title, timeoutMs, maxBytes, maxRedirects, maxRedirectsRemaining }) {
  const remaining = maxRedirectsRemaining === undefined ? maxRedirects : maxRedirectsRemaining

  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch {
      reject(new Error(`${title} has an invalid download URL.`))
      return
    }
    if (target.protocol !== 'https:' || target.username || target.password) {
      reject(permanentError(`${title} resolved to an unsafe URL.`))
      return
    }

    const request = httpsRequest(target, {
      headers: {
        Accept: 'text/plain',
        'User-Agent': 'PeerSky-Mobile-Content-Blocking-Build/1.0'
      }
    })

    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error?.retryable === undefined) error.retryable = true
      reject(error)
    }
    const finish = (bytes) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(bytes)
    }

    const timer = setTimeout(() => {
      request.destroy(new Error(`${title} timed out after ${timeoutMs}ms.`))
    }, timeoutMs)

    request.once('error', fail)
    request.once('response', (response) => {
      clearTimeout(timer)

      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.resume()
        const location = response.headers.location
        response.destroy()
        if (remaining <= 0) {
          fail(permanentError(`${title} redirected too many times.`))
          return
        }
        if (!location) {
          fail(permanentError(`${title} redirected without a location header.`))
          return
        }
        let redirected
        try {
          redirected = new URL(location, target).toString()
        } catch {
          fail(permanentError(`${title} redirected to an invalid URL.`))
          return
        }
        resolve(downloadListUrl(redirected, { title, timeoutMs, maxBytes, maxRedirects, maxRedirectsRemaining: remaining - 1 }))
        return
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume()
        const status = response.statusCode
        const error = new Error(`${title} returned HTTP ${status}.`)
        error.retryable = status === 403 ||
          status === 408 ||
          status === 425 ||
          status === 429 ||
          status >= 500
        error.retryAfterMs = readRetryAfterMs(firstHeader(response.headers['retry-after']))
        response.destroy()
        fail(error)
        return
      }

      const declaredLength = Number(response.headers['content-length'])
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        response.destroy()
        fail(permanentError(`${title} exceeds the size limit.`))
        return
      }

      const chunks = []
      let byteLength = 0
      response.on('data', (chunk) => {
        byteLength += chunk.byteLength
        if (byteLength > maxBytes) {
          response.destroy()
          fail(permanentError(`${title} exceeds the size limit.`))
          return
        }
        chunks.push(chunk)
      })
      response.once('end', () => finish(Buffer.concat(chunks, byteLength)))
      response.once('error', fail)
    })

    request.end()
  })
}

function firstHeader (value) {
  return Array.isArray(value) ? value[0] : value
}

function permanentError (message) {
  const error = new Error(message)
  error.retryable = false
  return error
}

function readRetryAfterMs (value) {
  if (!value) return 0
  if (/^[0-9]+$/.test(value.trim())) return Number(value.trim()) * 1_000
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0
}

function delay (milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function readListVersion (bytes) {
  const header = bytes.subarray(0, 16 * 1024).toString('utf8')
  const match = /^!\s*(?:Version|Last modified):\s*(.+)$/im.exec(header)
  return match?.[1]?.trim() || 'unreported'
}
