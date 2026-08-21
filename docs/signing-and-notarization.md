# Signing & Notarization (macOS)

DSH-Desktop needs to be **Developer ID signed and notarized** for two reasons:

1. **System notifications** — macOS only registers a properly signed + notarized app in
   `System Settings → Notifications`. An ad-hoc-signed app (the default when no
   certificate is available) never appears there, so `Notification.show()` is silently
   dropped and the `dsh-desktop-update` plugin's update notification never appears.
2. **Gatekeeper** — a signed + notarized build downloads and launches without the
   right-click → Open / `xattr -dr com.apple.quarantine` workaround.

## Prerequisites

- An [Apple Developer Program](https://developer.apple.com/programs/) membership.
- A **Developer ID Application** certificate installed in the keychain
  (`security find-identity -v -p codesigning` should list it).
- (Optional) An App Store Connect **app-specific password** for notarization.

## Configuration

The electron-builder `mac` options in `package.json` are already set up:

```json
"mac": {
  "icon": "build/icon.icns",
  "extendInfo": { "NSUserNotificationAlertStyle": "alert" },
  "category": "public.app-category.developer-tools",
  "target": ["dmg", "zip"],
  "hardenedRuntime": true,
  "gatekeeperAssess": false,
  "notarize": true
}
```

- `hardenedRuntime: true` is required by Apple for notarization.
- `notarize: true` tells electron-builder to notarize **when credentials are present**.
  If no credentials are set it logs a warning and skips, so local ad-hoc builds still work.

`@electron/notarize` is a `devDependency`.

## Build & notarize

Set the notarization credentials (either Apple ID or an API key) and run `dist:mac`:

### Option A — Apple ID (app-specific password)

```sh
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="ABCDE12345"
npm run dist:mac
```

### Option B — App Store Connect API key

```sh
export APPLE_API_KEY="/path/to/AuthKey_XXXX.p8"
export APPLE_API_KEY_ID="XXXX"
export APPLE_API_ISSUER="00000000-0000-0000-0000-000000000000"
npm run dist:mac
```

## Verify

After a successful build, confirm the app is properly signed and notarized:

```sh
codesign -dv --verbose=4 /Applications/DSH-Desktop.app   # expect Developer ID Application, not "adhoc"
spctl -a -vv /Applications/DSH-Desktop.app               # expect "accepted, source=Notarized Developer ID"
```

Then launch it and check `System Settings → Notifications → DSH-Desktop` — it should now
appear, and update notifications from the `dsh-desktop-update` plugin should show.

## Local dev without signing

For quick local testing, an ad-hoc build still works for most features. Only the OS-level
system notification is unavailable. To test the notification *IPC path* without OS
permission, trigger it from the DSH-Desktop DevTools console:

```js
window.dshDesktop.notify.show({ contributor: 'desktop-update', id: 'test', title: 'Test', body: 'hello' })
```
