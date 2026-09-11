export function mergePeerChatProfile (currentProfile, incomingProfile) {
  if (!incomingProfile || typeof incomingProfile !== 'object' || Array.isArray(incomingProfile)) {
    return currentProfile || null
  }

  const currentUsername = typeof currentProfile?.username === 'string'
    ? currentProfile.username.trim()
    : ''
  const incomingUsername = typeof incomingProfile.username === 'string'
    ? incomingProfile.username.trim()
    : ''

  // A transient empty backend snapshot must not erase a profile already shown to the user.
  if (currentUsername && !incomingUsername) return currentProfile
  return incomingProfile
}
