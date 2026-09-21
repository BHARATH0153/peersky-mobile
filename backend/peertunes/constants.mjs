export const PEERTUNES_LOOPBACK_HOST = '127.0.0.1'

// Fixed on purpose. The WebView origin is host:port, and the music library
// lives in that origin's IndexedDB, so a stable port is what keeps the
// library across app launches.
export const PEERTUNES_LOOPBACK_PORT = 47317
