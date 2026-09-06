export const DEFAULT_HYPER_NETWORK_REFRESH_TIMEOUT_MS = 3000

const refreshes = new WeakMap()

export function refreshHyperRuntimeNetwork (
  runtime,
  { timeoutMs = DEFAULT_HYPER_NETWORK_REFRESH_TIMEOUT_MS } = {}
) {
  if (!runtime || (typeof runtime !== 'object' && typeof runtime !== 'function')) {
    return Promise.resolve({ resumed: false, discoveries: 0, timedOut: false })
  }

  const activeRefresh = refreshes.get(runtime)
  if (activeRefresh) return activeRefresh

  const refresh = runRefresh(runtime, normalizeTimeout(timeoutMs))
    .finally(() => refreshes.delete(runtime))
  refreshes.set(runtime, refresh)
  return refresh
}

async function runRefresh (runtime, timeoutMs) {
  let discoveries = []
  const refresh = async () => {
    if (typeof runtime.resume === 'function') {
      await Promise.resolve().then(() => runtime.resume()).catch(() => {})
    }

    discoveries = getDiscoveries(runtime)
    await Promise.allSettled(discoveries.map((discovery) => (
      typeof discovery?.refresh === 'function'
        ? Promise.resolve().then(() => discovery.refresh())
        : Promise.resolve()
    )))
  }

  const result = await settleWithin(refresh(), timeoutMs)
  return {
    resumed: typeof runtime.resume === 'function',
    discoveries: discoveries.length,
    timedOut: result.timedOut
  }
}

function getDiscoveries (runtime) {
  try {
    const topics = runtime?.swarm?.topics?.()
    return topics ? Array.from(topics).slice(0, 256) : []
  } catch {
    return []
  }
}

function settleWithin (promise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ timedOut: true })
    }, timeoutMs)

    promise.then(() => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ timedOut: false })
    })
  })
}

function normalizeTimeout (timeoutMs) {
  return Number.isSafeInteger(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, 10000)
    : DEFAULT_HYPER_NETWORK_REFRESH_TIMEOUT_MS
}
