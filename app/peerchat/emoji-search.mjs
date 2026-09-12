export const PEERCHAT_EMOJI_SEARCH_MAX_CHARACTERS = 64

export function createPeerChatEmojiEntries (emojiKeywords) {
  if (!emojiKeywords || typeof emojiKeywords !== 'object' || Array.isArray(emojiKeywords)) return []

  return Object.entries(emojiKeywords)
    .filter(([emoji, keywords]) => emoji && Array.isArray(keywords))
    .map(([emoji, keywords]) => ({
      emoji,
      keywords: keywords.filter((keyword) => typeof keyword === 'string')
    }))
}

export function filterPeerChatEmojiEntries (entries, query) {
  if (!Array.isArray(entries)) return []
  const normalizedQuery = typeof query === 'string'
    ? query.trim().toLowerCase().slice(0, PEERCHAT_EMOJI_SEARCH_MAX_CHARACTERS)
    : ''
  if (!normalizedQuery) return entries

  return entries.filter(({ emoji, keywords }) => (
    emoji === normalizedQuery || keywords.some((keyword) => keyword.toLowerCase().includes(normalizedQuery))
  ))
}
