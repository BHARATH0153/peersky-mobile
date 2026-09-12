export function canUseNetworkForOfflineHyper ({ downloadOnlyOnWifi, isConnected, type }) {
  if (!downloadOnlyOnWifi) return true
  return isConnected === true && type === 'WIFI'
}
