import { useCallback, useEffect, useRef, useState } from 'react'
import { File, Paths } from 'expo-file-system'
import { AppState } from 'react-native'

import { RPC_PEERCHAT_ROOMS } from '../../backend/rpc/commands.mjs'
import {
  collectPeerChatNotificationCandidates,
  DEFAULT_PEERCHAT_NOTIFICATION_PREFERENCES,
  parsePeerChatNotificationPreferences,
  PEERCHAT_NOTIFICATION_PREFERENCES_MAX_BYTES,
  serializePeerChatNotificationPreferences,
  shouldEnablePeerChatBackground,
  shouldHandlePeerChatNotificationInApp
} from './notification-state.mjs'
import {
  hasPeerChatNotificationPermission,
  addPeerChatNotificationResponseListener,
  presentPeerChatNotification,
  preparePeerChatNotifications,
  requestPeerChatNotificationPermission,
  setPeerChatBadgeCount
} from './notifications'
import { playPeerChatSound } from './sounds'
import { addPeerChatBackgroundTickListener, setPeerChatBackgroundEnabled } from './background-service'

type NotificationRoom = {
  roomKey: string
  name?: string
  isMuted?: boolean
  unreadCount?: number
  lastMessage?: {
    sender?: string
    senderName?: string
    message?: string
    timestamp?: number
  } | null
}

type NotificationRpcResponse = {
  ok: boolean
  error?: string
  rooms?: NotificationRoom[]
  unreadTotal?: number
}

type NotificationPreferences = {
  notifications: boolean
  sounds: boolean
}

const POLL_INTERVAL_MS = 5000
const PREFERENCES_FILE = new File(Paths.document, 'peerchat-notifications.json')
const RECEIVE_SOUND = require('../../assets/sounds/peerchat/receive.mp3')

export function usePeerChatNotifications ({
  isPeerChatVisible,
  isRuntimeReady,
  onOpenRoom,
  onCallRpc
}: {
  isPeerChatVisible: boolean
  isRuntimeReady: boolean
  onOpenRoom: (roomKey: string) => void
  onCallRpc: (command: number, data?: object) => Promise<NotificationRpcResponse>
}) {
  const [preferences, setPreferences] = useState<NotificationPreferences>({
    ...DEFAULT_PEERCHAT_NOTIFICATION_PREFERENCES
  })
  const [isReady, setIsReady] = useState(false)
  const [unreadTotal, setUnreadTotal] = useState(0)
  const [roomCount, setRoomCount] = useState(0)
  const callRpcRef = useRef(onCallRpc)
  const openRoomRef = useRef(onOpenRoom)
  const isPeerChatVisibleRef = useRef(isPeerChatVisible)
  const preferencesRef = useRef(preferences)
  const previousRoomsRef = useRef<NotificationRoom[] | null>(null)
  const pollInFlightRef = useRef(false)
  const warnedRef = useRef(false)
  const badgeCountRef = useRef(-1)
  const badgeWarningRef = useRef(false)

  callRpcRef.current = onCallRpc
  openRoomRef.current = onOpenRoom
  isPeerChatVisibleRef.current = isPeerChatVisible
  preferencesRef.current = preferences

  useEffect(() => {
    const subscription = addPeerChatNotificationResponseListener((roomKey) => openRoomRef.current(roomKey))
    return () => subscription.remove()
  }, [])

  useEffect(() => {
    try {
      if (PREFERENCES_FILE.exists &&
          PREFERENCES_FILE.size != null &&
          PREFERENCES_FILE.size <= PEERCHAT_NOTIFICATION_PREFERENCES_MAX_BYTES) {
        setPreferences(parsePeerChatNotificationPreferences(PREFERENCES_FILE.textSync()))
      }
    } catch (error) {
      console.warn('Unable to load PeerChat notification preferences:', error)
    } finally {
      setIsReady(true)
    }
  }, [])

  const persistPreferences = useCallback((nextPreferences: NotificationPreferences) => {
    try {
      if (!PREFERENCES_FILE.exists) PREFERENCES_FILE.create({ intermediates: true })
      PREFERENCES_FILE.write(serializePeerChatNotificationPreferences(nextPreferences))
      return true
    } catch (error) {
      console.warn('Unable to save PeerChat notification preferences:', error)
      return false
    }
  }, [])

  const setNotificationsEnabled = useCallback(async (enabled: boolean) => {
    if (enabled && !await requestPeerChatNotificationPermission()) {
      const deniedPreferences = { ...preferencesRef.current, notifications: false }
      if (persistPreferences(deniedPreferences)) {
        preferencesRef.current = deniedPreferences
        setPreferences(deniedPreferences)
      }
      return false
    }
    const nextPreferences = { ...preferencesRef.current, notifications: enabled }
    if (!persistPreferences(nextPreferences)) return false
    preferencesRef.current = nextPreferences
    setPreferences(nextPreferences)
    return true
  }, [persistPreferences])

  const setSoundsEnabled = useCallback((enabled: boolean) => {
    const nextPreferences = { ...preferencesRef.current, sounds: enabled }
    if (!persistPreferences(nextPreferences)) return false
    preferencesRef.current = nextPreferences
    setPreferences(nextPreferences)
    return true
  }, [persistPreferences])

  useEffect(() => {
    if (!isReady) return
    void setPeerChatBackgroundEnabled(shouldEnablePeerChatBackground({
      isRuntimeReady,
      notificationsEnabled: preferences.notifications,
      roomCount
    })).catch((error) => {
      console.warn('Unable to update PeerChat background service:', error)
    })
  }, [isReady, isRuntimeReady, preferences.notifications, roomCount])

  useEffect(() => {
    if (!isReady || isRuntimeReady) return
    previousRoomsRef.current = null
    badgeCountRef.current = 0
    setRoomCount(0)
    setUnreadTotal(0)
    void setPeerChatBadgeCount(0).catch((error) => {
      if (!badgeWarningRef.current) {
        badgeWarningRef.current = true
        console.warn('Unable to clear PeerChat badge:', error)
      }
    })
  }, [isReady, isRuntimeReady])

  useEffect(() => {
    if (!isReady || !isRuntimeReady) {
      previousRoomsRef.current = null
      return
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const poll = async () => {
      if (cancelled || pollInFlightRef.current) return
      if (AppState.currentState !== 'active' && !preferencesRef.current.notifications) return
      pollInFlightRef.current = true
      try {
        const response = await callRpcRef.current(RPC_PEERCHAT_ROOMS, {})
        if (!response.ok) throw new Error(response.error || 'Unable to check PeerChat messages.')
        if (cancelled) return

        const nextRooms = Array.isArray(response.rooms) ? response.rooms : []
        setRoomCount(nextRooms.length)
        const nextUnreadTotal = normalizeUnreadTotal(response.unreadTotal, nextRooms)
        setUnreadTotal(nextUnreadTotal)
        if (badgeCountRef.current !== nextUnreadTotal) {
          badgeCountRef.current = nextUnreadTotal
          try {
            await setPeerChatBadgeCount(nextUnreadTotal)
            badgeWarningRef.current = false
          } catch (error) {
            if (!badgeWarningRef.current) {
              badgeWarningRef.current = true
              console.warn('Unable to update PeerChat badge:', error)
            }
          }
        }
        const previousRooms = previousRoomsRef.current
        previousRoomsRef.current = nextRooms
        warnedRef.current = false
        if (!previousRooms) return
        const candidates = collectPeerChatNotificationCandidates(previousRooms, nextRooms)
        if (candidates.length === 0) return
        if (shouldHandlePeerChatNotificationInApp(
          isPeerChatVisibleRef.current,
          AppState.currentState
        )) {
          if (preferencesRef.current.sounds) playPeerChatSound('receive', RECEIVE_SOUND)
          return
        }
        if (!preferencesRef.current.notifications || !await hasPeerChatNotificationPermission()) return

        for (const candidate of candidates) {
          if (cancelled) return
          await presentPeerChatNotification({
            ...candidate,
            sounds: preferencesRef.current.sounds
          })
        }
      } catch (error) {
        if (!cancelled && !warnedRef.current) {
          warnedRef.current = true
          console.warn('Unable to check PeerChat notifications:', error)
        }
      } finally {
        pollInFlightRef.current = false
      }
    }

    const schedule = () => {
      if (!cancelled) timer = setTimeout(async () => {
        await poll()
        schedule()
      }, POLL_INTERVAL_MS)
    }
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void poll()
    })
    const backgroundTickSubscription = addPeerChatBackgroundTickListener(() => {
      if (preferencesRef.current.notifications) void poll()
    })

    void preparePeerChatNotifications().catch((error) => {
      console.warn('Unable to prepare PeerChat notifications:', error)
    })
    void poll().finally(schedule)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      subscription.remove()
      backgroundTickSubscription.remove()
    }
  }, [isReady, isRuntimeReady])

  return {
    isReady,
    notificationsEnabled: preferences.notifications,
    setNotificationsEnabled,
    setSoundsEnabled,
    soundsEnabled: preferences.sounds,
    unreadTotal
  }
}

function normalizeUnreadTotal (value: unknown, rooms: NotificationRoom[]) {
  if (Number.isSafeInteger(value) && Number(value) >= 0) return Math.min(Number(value), 9999)
  return Math.min(9999, rooms.reduce((total, room) => {
    const unread = Number.isSafeInteger(room.unreadCount) && Number(room.unreadCount) > 0
      ? Number(room.unreadCount)
      : 0
    return total + unread
  }, 0))
}
