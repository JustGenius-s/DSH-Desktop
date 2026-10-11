const test = require('node:test')
const assert = require('node:assert/strict')
const { installDshMicrophonePermission } = require('../dist/main/platform/microphone.js')

const origin = 'http://127.0.0.1:43123'

function setup(platform = 'linux', askForMicrophone = async () => true) {
  const mainWebContents = {
    currentUrl: `${origin}/?token=secret`,
    destroyed: false,
    getURL() {
      return this.currentUrl
    },
    isDestroyed() {
      return this.destroyed
    },
  }
  const ses = {
    setPermissionCheckHandler(handler) {
      this.check = handler
    },
    setPermissionRequestHandler(handler) {
      this.request = handler
    },
  }
  let dshOrigin = origin
  installDshMicrophonePermission(ses, mainWebContents, () => dshOrigin, platform, askForMicrophone)
  const request = (webContents = mainWebContents, details = {}) =>
    new Promise((resolve) => {
      ses.request(webContents, 'media', resolve, {
        requestingUrl: `${origin}/chat`,
        securityOrigin: origin,
        mediaTypes: ['audio'],
        ...details,
      })
    })
  const check = (webContents = mainWebContents, details = {}) =>
    ses.check(webContents, 'media', origin, {
      mediaType: 'audio',
      isMainFrame: true,
      requestingUrl: `${origin}/chat`,
      ...details,
    })
  return {
    ses,
    mainWebContents,
    request,
    check,
    setDshOrigin: (value) => {
      dshOrigin = value
    },
  }
}

test('only the current DSH window and same-origin audio frame can use the microphone', async () => {
  const { mainWebContents, request, check } = setup()
  assert.equal(check(), true)
  assert.equal(await request(), true)

  const otherWindow = { ...mainWebContents }
  assert.equal(check(otherWindow), false)
  assert.equal(await request(otherWindow), false)
  assert.equal(check(mainWebContents, { mediaType: 'video' }), false)
  assert.equal(await request(mainWebContents, { mediaTypes: ['audio', 'video'] }), false)
  assert.equal(await request(mainWebContents, { mediaTypes: ['video'] }), false)
  assert.equal(
    await request(mainWebContents, { requestingUrl: 'https://example.com/frame' }),
    false,
  )
  assert.equal(check(mainWebContents, { securityOrigin: 'https://example.com' }), false)
})

test('old origin and navigated or destroyed window lose microphone access', async () => {
  const { mainWebContents, request, check, setDshOrigin } = setup()
  setDshOrigin('http://127.0.0.1:43124')
  assert.equal(check(), false)
  assert.equal(await request(), false)
  setDshOrigin(origin)
  mainWebContents.currentUrl = 'https://example.com/'
  assert.equal(check(), false)
  assert.equal(await request(), false)
  mainWebContents.currentUrl = `${origin}/`
  mainWebContents.destroyed = true
  assert.equal(await request(), false)
})

test('macOS asks on demand and honors system denial', async () => {
  let calls = 0
  const { request } = setup('darwin', async () => {
    calls++
    return false
  })
  assert.equal(calls, 0)
  assert.equal(await request(), false)
  assert.equal(calls, 1)
})

test('concurrent macOS audio requests share one system prompt', async () => {
  let calls = 0
  let resolvePrompt
  const { request } = setup('darwin', () => {
    calls++
    return new Promise((resolve) => {
      resolvePrompt = resolve
    })
  })
  const first = request()
  const second = request()
  assert.equal(calls, 1)
  resolvePrompt(true)
  assert.deepEqual(await Promise.all([first, second]), [true, true])
})

test('non-media permissions retain the previous Electron behavior', async () => {
  const { ses, mainWebContents } = setup()
  assert.equal(ses.check(mainWebContents, 'notifications', origin, {}), true)
  const allowed = await new Promise((resolve) => {
    ses.request(mainWebContents, 'notifications', resolve, {})
  })
  assert.equal(allowed, true)
})

test('macOS rechecks the page when the system prompt completes', async () => {
  let resolvePrompt
  const { mainWebContents, request } = setup(
    'darwin',
    () =>
      new Promise((resolve) => {
        resolvePrompt = resolve
      }),
  )
  const result = request()
  mainWebContents.currentUrl = 'https://example.com/'
  resolvePrompt(true)
  assert.equal(await result, false)
})
