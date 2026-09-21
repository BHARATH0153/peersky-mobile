import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, AppState, StyleSheet, Text, View } from 'react-native'
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
      </View>
    )
  }

  if (!localUrl) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size='small' />
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
        onOpenUrl(request.url)
        return false
      }}
      onOpenWindow={(event) => onOpenUrl(event.nativeEvent.targetUrl)}
      onRenderProcessGone={() => recover('a renderer restart')}
      onContentProcessDidTerminate={() => recover('a renderer restart')}
      onError={(event) => {
        onStatus(`PeerTunes failed to load: ${event.nativeEvent.description}`)
        onEnsureServer()
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
  webView: {
    backgroundColor: '#0a0b0d',
    flex: 1
  }
})
