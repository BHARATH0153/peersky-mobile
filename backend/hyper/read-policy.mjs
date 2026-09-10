export const DEFAULT_HYPER_READ_TIMEOUT_MS = 5000

const configuredDrives = new WeakSet()

export function configureHyperReadTimeout (
  drive,
  { timeoutMs = DEFAULT_HYPER_READ_TIMEOUT_MS } = {}
) {
  if (!drive || configuredDrives.has(drive)) return drive

  const timeout = normalizeTimeout(timeoutMs)
  configuredDrives.add(drive)
  setCoreTimeout(drive.core, timeout)

  if (drive.blobs) {
    setCoreTimeout(drive.blobs.core, timeout)
  } else if (typeof drive.once === 'function') {
    drive.once('blobs', (blobs) => setCoreTimeout(blobs?.core, timeout))
  }

  return drive
}

function setCoreTimeout (core, timeout) {
  if (core) core.timeout = timeout
}

function normalizeTimeout (timeoutMs) {
  return Number.isSafeInteger(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, 30000)
    : DEFAULT_HYPER_READ_TIMEOUT_MS
}
