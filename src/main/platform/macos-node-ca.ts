/**
 * Electron 43 + macOS 26: a Node TLS SecureContext created *after*
 * NSApplication is running reads the keychain (`SetRootCerts`) and
 * SIGSEGVs. Overlay windows trip this because Electron lazily imports
 * `https` on the GUI thread without our CA list.
 *
 * Pin bundled Mozilla roots, build one context before `whenReady`, and
 * wrap `createSecureContext` so later lazy loads never hit the system store.
 */
import https from 'node:https'
import tls from 'node:tls'

const setDefault = (tls as { setDefaultCACertificates?: (certs: readonly string[]) => void })
  .setDefaultCACertificates

if (process.platform === 'darwin') {
  const ca = [...tls.rootCertificates]
  if (typeof setDefault === 'function') {
    setDefault(ca)
  }
  https.globalAgent.options.ca = ca
  const original = tls.createSecureContext.bind(tls)
  tls.createSecureContext = ((options?: tls.SecureContextOptions) =>
    original({ ...options, ca: options?.ca ?? ca })) as typeof tls.createSecureContext
  tls.createSecureContext({ ca })
}
