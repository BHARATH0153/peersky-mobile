export async function connectWithAdvertisedLoopbackPort ({
  connect,
  key,
  host,
  udp,
  log
}) {
  // Omitting port makes Holesail bind the port advertised by the room host.
  return connect({
    key,
    host,
    preferRemotePort: true,
    udp,
    log
  })
}
