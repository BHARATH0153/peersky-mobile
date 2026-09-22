export const INTERNAL_APPS = [
  {
    id: 'hyper',
    title: 'Hyperdrive',
    url: 'peersky://p2p/hyperdrive/',
    icon: 'H'
  },
  {
    id: 'p2pmd',
    title: 'P2PMD',
    url: 'peersky://p2p/p2pmd/',
    icon: 'MD'
  },
  {
    id: 'peerchat',
    title: 'PeerChat',
    url: 'peersky://p2p/peerchat/',
    icon: 'PC'
  },
  {
    id: 'peertunes',
    title: 'PeerTunes',
    url: 'peersky://p2p/peertunes/',
    icon: 'PT'
  },
  {
    id: 'holesail',
    title: 'Holesail',
    url: 'peersky://holesail/',
    icon: 'HS'
  }
]

const LEGACY_INTERNAL_APP_ROUTES = new Map([
  ['peersky://hyper', 'hyper'],
  ['peersky://hyperdrive', 'hyper']
])

// Share links keep their payload in the query or fragment, for example
// peersky://p2p/peertunes/#playlist=hyper%3A%2F%2F... The tail is passed to
// the app page untouched, so it is capped and kept free of markup characters.
const MAX_LAUNCH_SUFFIX_LENGTH = 4096

export function getRuntimeAppUrl (app) {
  const match = INTERNAL_APPS.find((item) => item.id === app)
  return match?.url || 'peersky://p2p/p2pmd/'
}

export function getRuntimeAppFromUrl (targetUrl) {
  const normalizedUrl = normalizeInternalAppUrl(targetUrl)
  return INTERNAL_APPS.find((app) => normalizeInternalAppUrl(app.url) === normalizedUrl)?.id ||
    LEGACY_INTERNAL_APP_ROUTES.get(normalizedUrl) || null
}

export function getRuntimeAppTitle (app) {
  return INTERNAL_APPS.find((item) => item.id === app)?.title || 'P2PMD'
}

export function getRuntimeAppLaunchSuffix (targetUrl) {
  const value = String(targetUrl || '')
  const index = value.search(/[?#]/)
  if (index === -1) return ''

  const suffix = value.slice(index)
  if (suffix.length > MAX_LAUNCH_SUFFIX_LENGTH) return ''
  if (/[\s<>"'`\\]/.test(suffix)) return ''

  return suffix
}

export function canUseP2pAppPageActions (app, targetUrl) {
  const registeredUrl = getRuntimeAppUrl(app)
  return registeredUrl.startsWith('peersky://p2p/') &&
    normalizeInternalAppUrl(registeredUrl) === normalizeInternalAppUrl(targetUrl)
}

function normalizeInternalAppUrl (targetUrl) {
  return String(targetUrl || '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}
