import { NativeModules, Platform } from 'react-native'

type PeerChatBackgroundModule = {
  setEnabled: (enabled: boolean) => Promise<void>
}

export async function setPeerChatBackgroundEnabled (enabled: boolean) {
  if (Platform.OS !== 'android') return
  const module = NativeModules.PeerChatBackground as PeerChatBackgroundModule | undefined
  if (!module?.setEnabled) throw new Error('PeerChat background service is unavailable in this build.')
  await module.setEnabled(enabled)
}
