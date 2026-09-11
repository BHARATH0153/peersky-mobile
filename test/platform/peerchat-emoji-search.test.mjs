import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createPeerChatEmojiEntries,
  filterPeerChatEmojiEntries,
  PEERCHAT_EMOJI_SEARCH_MAX_CHARACTERS
} from '../../app/peerchat/emoji-search.mjs'

describe('PeerChat emoji search', () => {
  const entries = createPeerChatEmojiEntries({
    '😀': ['grinning_face', 'happy'],
    '🐱': ['cat_face', 'animal', 'kitten'],
    invalid: 'not-an-array'
  })

  it('builds entries only from valid keyword arrays', () => {
    assert.deepEqual(entries, [
      { emoji: '😀', keywords: ['grinning_face', 'happy'] },
      { emoji: '🐱', keywords: ['cat_face', 'animal', 'kitten'] }
    ])
  })

  it('matches keywords case-insensitively and returns all entries for an empty query', () => {
    assert.deepEqual(filterPeerChatEmojiEntries(entries, 'KIT'), [entries[1]])
    assert.equal(filterPeerChatEmojiEntries(entries, ''), entries)
  })

  it('bounds user-controlled search queries', () => {
    const query = `${'x'.repeat(PEERCHAT_EMOJI_SEARCH_MAX_CHARACTERS)}kitten`
    assert.deepEqual(filterPeerChatEmojiEntries(entries, query), [])
  })
})
