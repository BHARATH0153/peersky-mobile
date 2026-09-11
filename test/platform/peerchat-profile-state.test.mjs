import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { mergePeerChatProfile } from '../../app/peerchat/profile-state.mjs'

describe('PeerChat profile state', () => {
  const savedProfile = {
    id: 'local-peer',
    username: 'Alice',
    bio: 'Hello',
    avatar: 'data:image/jpeg;base64,avatar',
    linkPreview: true
  }

  it('does not let an empty poll overwrite an existing profile', () => {
    assert.equal(mergePeerChatProfile(savedProfile, { username: '', bio: '', avatar: null }), savedProfile)
  })

  it('accepts a valid backend profile update', () => {
    const updated = { ...savedProfile, username: 'Alice Mobile', bio: 'Updated' }
    assert.equal(mergePeerChatProfile(savedProfile, updated), updated)
  })

  it('accepts an empty profile when no saved profile exists', () => {
    const empty = { username: '', bio: '', avatar: null }
    assert.equal(mergePeerChatProfile(null, empty), empty)
  })
})
