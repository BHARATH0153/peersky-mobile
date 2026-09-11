import { headersToObject } from './assets.mjs'

export const DEFAULT_HYPER_DISCOVERY_RETRIES = 5
export const DEFAULT_HYPER_DISCOVERY_RETRY_DELAY = 250
export const DEFAULT_HYPER_DISCOVERY_MAX_RETRY_DELAY = 2000

export async function withHyperRetry ({
  fetch,
  url,
  retries,
  retryDelay,
  maxRetryDelay,
  backoffFactor,
  beforeRetry,
  readResponse
}) {
  let attempt = 0
  let currentDelay = retryDelay

  while (true) {
    try {
      const response = await fetch(url)
      const headers = headersToObject(response.headers)

      if (!response.ok) {
        let text = ''
        try {
          text = await response.text()
        } catch (_) {}

        const responseError = text || response.statusText || `Request failed with status ${response.status}`
        const isRetryable = !isHyperRequestTimeout(responseError) &&
          (isPeerDiscoveryError(text) || response.status === 502)
        if (isRetryable && attempt < retries) {
          attempt++
          await runBeforeRetry(beforeRetry)
          await delay(currentDelay)
          currentDelay = Math.min(maxRetryDelay, Math.floor(currentDelay * backoffFactor))
          continue
        }

        return {
          ok: false,
          status: response.status,
          statusText: response.statusText,
          url: response.url || url,
          headers,
          error: normalizeHyperFetchError(responseError)
        }
      }

      return await readResponse(response, headers)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      const isRetryable = isPeerDiscoveryError(errorMsg)

      if (isRetryable && attempt < retries) {
        attempt++
        await runBeforeRetry(beforeRetry)
        await delay(currentDelay)
        currentDelay = Math.min(maxRetryDelay, Math.floor(currentDelay * backoffFactor))
        continue
      }

      return {
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        url,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        error: normalizeHyperFetchError(error)
      }
    }
  }
}

async function runBeforeRetry (beforeRetry) {
  if (typeof beforeRetry !== 'function') return
  try {
    await beforeRetry()
  } catch {}
}

export function isPeerDiscoveryError (message) {
  return /\bpeers?\s+not\s+found\b/i.test(message) ||
    /could not find data in drive[^\n]*peers online/i.test(message)
}

export function normalizeHyperFetchError (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (isHyperRequestTimeout(error)) {
    return 'Hyper content is unavailable. Connect to the network or wait for a peer, then try again.'
  }
  return message
}

function isHyperRequestTimeout (error) {
  const message = error instanceof Error ? error.message : String(error)
  const code = error && typeof error === 'object' ? error.code : null
  return code === 'REQUEST_TIMEOUT' || /\brequest(?:_|\s+)timeout\b|request timed out/i.test(message)
}

function delay (milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
