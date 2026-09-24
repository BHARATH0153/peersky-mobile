// Invite links for PeerChat rooms, matching the desktop format so a link
// shared from either side opens on the other.
//
//   peersky://p2p/peerchat/#room=<64 hex room key>
//
// The key rides in the fragment rather than the path, so the browser shell
// treats it as a launch suffix on the built-in app instead of a new route.
export const PEERCHAT_INVITE_BASE = 'peersky://p2p/peerchat/'

const ROOM_KEY_RE = /^[a-f0-9]{64}$/i

export function buildPeerChatInviteUrl (roomKey) {
  const key = String(roomKey || '')
  if (!ROOM_KEY_RE.test(key)) return ''
  return `${PEERCHAT_INVITE_BASE}#room=${key.toLowerCase()}`
}

// Accepts a full invite link, a bare fragment, or a plain room key, so the same
// function handles a pasted link and a scanned QR code.
export function parsePeerChatInvite (input) {
  const value = String(input || '').trim()
  if (!value) return ''
  if (ROOM_KEY_RE.test(value)) return value.toLowerCase()

  const tail = value.match(/[#?](.*)$/)?.[1] ?? ''
  if (!tail) return ''

  let key = ''
  try {
    key = new URLSearchParams(tail).get('room') || ''
  } catch {
    return ''
  }

  return ROOM_KEY_RE.test(key) ? key.toLowerCase() : ''
}
