import { NativeEventEmitter, NativeModules, Platform } from 'react-native'

type PeerChatBackgroundModule = {
  setEnabled: (enabled: boolean) => Promise<void>
  playSound: (kind: 'send' | 'receive') => void
  addListener: (eventName: string) => void
  removeListeners: (count: number) => void
}

const BACKGROUND_TICK_EVENT = 'PeerChatBackgroundTick'

function getPeerChatBackgroundModule () {
  return NativeModules.PeerChatBackground as PeerChatBackgroundModule | undefined
}

export async function setPeerChatBackgroundEnabled (enabled: boolean) {
  if (Platform.OS !== 'android') return
  const module = getPeerChatBackgroundModule()
  if (!module?.setEnabled) throw new Error('PeerChat background service is unavailable in this build.')
  await module.setEnabled(enabled)
}

export function addPeerChatBackgroundTickListener (listener: () => void) {
  if (Platform.OS !== 'android') return { remove () {} }
  const module = getPeerChatBackgroundModule()
  if (!module?.addListener || !module?.removeListeners) return { remove () {} }
  return new NativeEventEmitter(module as never).addListener(BACKGROUND_TICK_EVENT, listener)
}

export function playAndroidPeerChatSound (kind: 'send' | 'receive') {
  if (Platform.OS !== 'android') return false
  const module = getPeerChatBackgroundModule()
  if (!module?.playSound) return false
  module.playSound(kind)
  return true
}
