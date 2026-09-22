// Backend to app pushes. The app polls PeerChat as a safety net, but a poll
// means a message can sit for a second before it shows, which reads as lag.
// This lets the backend say "something changed" the moment it happens.
let send = null

export function setAppNotifier (notifier) {
  send = typeof notifier === 'function' ? notifier : null
}

export function notifyApp (command, payload = {}) {
  if (!send) return
  try {
    send(command, payload)
  } catch (error) {
    console.error('[rpc] Unable to notify the app:', error)
  }
}
