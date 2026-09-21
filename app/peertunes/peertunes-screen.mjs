// The app page lives on the loopback PeerTunes server. A share link's
// query or fragment rides along so the page can pick up the playlist.
export function createPeerTunesPageUrl (localUrl, launchSuffix = '') {
  const base = String(localUrl || '').replace(/\/+$/, '')
  if (!base) return ''
  return `${base}/${launchSuffix || ''}`
}

// Only the app's own origin may navigate inside the WebView. Anything else,
// such as the GitHub link in the About screen, goes back to the browser.
export function isPeerTunesPageRequest (requestUrl, localUrl) {
  const value = String(requestUrl || '')
  if (value === 'about:blank') return true

  const base = String(localUrl || '').replace(/\/+$/, '')
  if (!base) return false

  // Compare parsed origins rather than string prefixes. A prefix test rejects
  // same-origin URLs that carry only a query or a fragment, which ejected the
  // user out of the app, and it is fussy about scheme case.
  try {
    const target = new URL(value)
    const expected = new URL(base)
    return target.protocol === expected.protocol &&
      target.hostname === expected.hostname &&
      target.port === expected.port
  } catch {
    return false
  }
}
