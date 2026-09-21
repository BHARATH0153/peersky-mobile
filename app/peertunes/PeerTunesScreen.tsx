import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from 'react-native'
import { WebView } from 'react-native-webview'

import { createPeerTunesPageUrl, isPeerTunesPageRequest } from './peertunes-screen.mjs'

type Props = {
  error: string | null
  isDark: boolean
  launchSuffix: string
  localUrl: string | null
  onEnsureServer: () => void
  onOpenUrl: (url: string) => void
  onStatus: (message: string) => void
}

export function PeerTunesScreen ({
  error,
  isDark,
  launchSuffix,
  localUrl,
  onEnsureServer,
  onOpenUrl,
  onStatus
}: Props) {
  // Android kills a backgrounded WebView's render process under memory
  // pressure and leaves an empty view behind. Remounting on that signal is
  // what stops the player going blank until the tab is closed and reopened.
  const [reloadNonce, setReloadNonce] = useState(0)
  const webViewRef = useRef<WebView | null>(null)

  const recover = useCallback((reason: string) => {
    onStatus(`PeerTunes reloaded after ${reason}`)
    onEnsureServer()
    setReloadNonce((value) => value + 1)
  }, [onEnsureServer, onStatus])

  // The loopback server lives in the Bare worklet, which can be torn down
  // while the app sits in the background. Re-check it whenever we come back.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') onEnsureServer()
    })
    return () => subscription.remove()
  }, [onEnsureServer])

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={[styles.message, isDark ? styles.messageDark : null]}>{error}</Text>
        <Pressable
          accessibilityRole='button'
          onPress={() => recover('a retry')}
          style={styles.retry}
        >
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    )
  }

  if (!localUrl) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size='small' />
        <Text style={[styles.message, isDark ? styles.messageDark : null]}>Starting PeerTunes...</Text>
      </View>
    )
  }

  const pageUrl = createPeerTunesPageUrl(localUrl, launchSuffix)

  return (
    <WebView
      key={`${pageUrl}:${reloadNonce}`}
      ref={webViewRef}
      source={{ uri: pageUrl }}
      allowsInlineMediaPlayback={true}
      allowsProtectedMedia={true}
      androidLayerType='hardware'
      cacheEnabled={false}
      domStorageEnabled={true}
      mediaCapturePermissionGrantType='prompt'
      mediaPlaybackRequiresUserAction={false}
      setBuiltInZoomControls={false}
      textZoom={100}
      style={styles.webView}
      onShouldStartLoadWithRequest={(request) => {
        if (isPeerTunesPageRequest(request.url, localUrl)) return true
        // Only a real top-frame navigation should leave PeerTunes. A subframe
        // pointing elsewhere used to take the whole tab with it and stop the
        // music, without the user touching anything.
        if (request.isTopFrame === false) return false
        onOpenUrl(request.url)
        return false
      }}
      onOpenWindow={(event) => onOpenUrl(event.nativeEvent.targetUrl)}
      onRenderProcessGone={() => recover('a renderer restart')}
      onContentProcessDidTerminate={() => recover('a renderer restart')}
      onError={(event) => {
        recover(`a load failure (${event.nativeEvent.description})`)
      }}
    />
  )
}

const styles = StyleSheet.create({
  centered: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    padding: 24
  },
  message: {
    color: '#1f2027',
    fontSize: 15,
    textAlign: 'center'
  },
  messageDark: {
    color: '#e6e6ea'
  },
  retry: {
    alignItems: 'center',
    backgroundColor: '#2f6fed',
    borderRadius: 10,
    justifyContent: 'center',
    marginTop: 16,
    minHeight: 44,
    paddingHorizontal: 24
  },
  retryText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700'
  },
  webView: {
    backgroundColor: '#0a0b0d',
    flex: 1
  }
})
