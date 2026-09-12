import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
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
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(source.url, {
      headers: {
        Accept: 'text/plain',
        'User-Agent': 'PeerSky-Mobile-Content-Blocking-Build/1.0'
      },
      signal: controller.signal
    })
    if (!response.ok) {
      const error = new Error(`${source.title} returned HTTP ${response.status}.`)
      error.retryable = response.status === 403 ||
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500
      error.retryAfterMs = readRetryAfterMs(response.headers.get('retry-after'))
      throw error
    }
    const responseUrl = new URL(response.url)
    if (responseUrl.protocol !== 'https:' || responseUrl.username || responseUrl.password) {
      throw permanentError(`${source.title} redirected to an unsafe URL.`)
    }

    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_FILTER_LIST_BYTES) {
      throw permanentError(`${source.title} exceeds the size limit.`)
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error(`${source.title} did not return a readable body.`)
    const chunks = []
    let byteLength = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > MAX_FILTER_LIST_BYTES) {
        await reader.cancel()
        throw permanentError(`${source.title} exceeds the size limit.`)
      }
      chunks.push(value)
    }

    const bytes = Buffer.concat(chunks, byteLength)
    const validation = validateFilterListSnapshot({
      id: source.id,
      byteLength,
      preamble: bytes.subarray(0, 512).toString('latin1')
    })
    if (!validation.ok) throw permanentError(`${source.title}: ${validation.error}`)
    return bytes
  } finally {
    clearTimeout(timeout)
  }
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
