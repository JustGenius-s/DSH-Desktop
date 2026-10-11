import type { Session, WebContents } from 'electron'

interface MicrophoneSource {
  webContents: WebContents | null
  mainWebContents: WebContents
  dshOrigin: string | null
  requestingUrl?: string
  securityOrigin?: string
}

function hasOrigin(url: string | undefined, origin: string): boolean {
  if (!url) return false
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

/** Chromium passes the top-level WebContents for subframes, so verify the frame origin too. */
export function isDshMicrophoneSource(source: MicrophoneSource): boolean {
  const { webContents, mainWebContents, dshOrigin, requestingUrl, securityOrigin } = source
  if (webContents !== mainWebContents || mainWebContents.isDestroyed() || dshOrigin === null)
    return false
  if (!hasOrigin(mainWebContents.getURL(), dshOrigin)) return false
  if (!hasOrigin(securityOrigin ?? requestingUrl, dshOrigin)) return false
  return requestingUrl === undefined || hasOrigin(requestingUrl, dshOrigin)
}

/**
 * Grant audio capture only to the running DSH page. Electron's default session is also
 * used by splash/recovery windows; media requests from those windows must not inherit
 * the main window's access. Other permission types retain Electron's prior behavior.
 */
export function installDshMicrophonePermission(
  ses: Session,
  mainWebContents: WebContents,
  getDshOrigin: () => string | null,
  platform: NodeJS.Platform,
  askForMicrophone: () => Promise<boolean>,
): void {
  let pendingMacRequest: Promise<boolean> | undefined

  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (permission !== 'media') return true
    return (
      details.mediaType === 'audio' &&
      isDshMicrophoneSource({
        webContents,
        mainWebContents,
        dshOrigin: getDshOrigin(),
        requestingUrl: details.requestingUrl,
        securityOrigin: details.securityOrigin ?? requestingOrigin,
      })
    )
  })

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission !== 'media') {
      callback(true)
      return
    }
    const media = details as Electron.MediaAccessPermissionRequest
    const source = (): boolean =>
      isDshMicrophoneSource({
        webContents,
        mainWebContents,
        dshOrigin: getDshOrigin(),
        requestingUrl: media.requestingUrl,
        securityOrigin: media.securityOrigin,
      })
    if (media.mediaTypes?.length !== 1 || media.mediaTypes[0] !== 'audio' || !source()) {
      callback(false)
      return
    }
    if (platform !== 'darwin') {
      callback(true)
      return
    }

    // Only ask after the page requests audio. Share an in-flight macOS prompt, and
    // recheck the origin after it resolves in case the window navigated or closed.
    pendingMacRequest ??= askForMicrophone().finally(() => {
      pendingMacRequest = undefined
    })
    void pendingMacRequest.then(
      (granted) => callback(granted && source()),
      (error: unknown) => {
        console.warn('[DSH-Desktop] macOS microphone permission request failed', error)
        callback(false)
      },
    )
  })
}
