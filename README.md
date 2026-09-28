<p align="center">
  <img src="build/icon-app.png" width="128" alt="DSH-Desktop app icon" />
</p>

<p align="center">
  <strong>English</strong> ｜ <a href="docs/README.zh-CN.md">简体中文</a>
</p>

<h1 align="center">DSH-Desktop</h1>

Electron desktop shell for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Uses Electron's embedded Node and bundled pnpm to install `@deepseek-ai/dsh` into `~/.dsh/runtime` and serve the `dsh web` UI.

<p align="center">
  <img src="public/desktop.png" alt="DSH-Desktop screenshot" />
</p>

## Download & Install

Prebuilt packages are published on [GitHub Releases](https://github.com/JustGenius-s/DSH-Desktop/releases). First launch installs the DSH runtime (~1-2 min).

### macOS

Requires macOS 13 (Ventura) or later.

1. Download `DSH-Desktop-*.dmg` from the latest release.
2. Open the `.dmg` and drag `DSH-Desktop.app` into `/Applications`.
3. The app is unsigned, so Gatekeeper blocks the first launch. Right-click the app → **Open** and confirm, or run:

```sh
xattr -dr com.apple.quarantine /Applications/DSH-Desktop.app
```

### Windows

Requires 64-bit Windows.

1. Download `DSH-Desktop Setup *.exe` (installer) or `DSH-Desktop-*-win.zip` (portable) from the latest release.
2. Run the installer, or unzip the archive and launch `DSH-Desktop.exe`.
3. The build is unsigned, so SmartScreen may warn. Click **More info** → **Run anyway**.

## How it works

```
Electron main process
  ├─ embedded Node (ELECTRON_RUN_AS_NODE) + bundled pnpm
  ├─ node/pnpm launchers (resources/runtime; repo-root runtime/ in dev)
  ├─ first launch: pnpm installs @deepseek-ai/dsh → ~/.dsh/runtime (upgradeable)
  ├─ spawn  dsh web --host 127.0.0.1 --port <free-port>
  └─ BrowserWindow → http://127.0.0.1:<port>
```

DSH is installed from npm at runtime, not shipped with the app. Upgrading DSH = detect a newer version on launch → click "Update" → optionally restart the web service (the desktop app stays open). No rebuild or re-signing.

After a successful boot, the web port is saved in `web-port.json` under Electron's user-data directory. Cold starts reuse it when available so origin-scoped browser preferences survive restarts. If another process occupies that port, a new loopback port is allocated; the app never attaches to that process. Plugins must still persist durable data on the host to survive a port change. Development and installed apps keep separate port records.

## Develop

```sh
pnpm install
pnpm collect      # collect pnpm and Electron launchers into runtime/
pnpm start        # first launch installs @deepseek-ai/dsh (~1-2 min)
pnpm dev          # alias for start
```

Dev and packaged builds both use the current Electron executable and the external `~/.dsh/runtime`. No standalone Node binary is downloaded or shipped. Plugin commands find a small `node` launcher through PATH; the executable path is supplied at each launch, so moving or upgrading the app does not leave stale paths.

Tests (no Electron window or browser required):

```sh
pnpm test          # vitest for test/*.test.ts + node --test for test/*.test.cjs
pnpm typecheck
pnpm check         # formatting + typecheck + build + all tests
```

The TypeScript suites run under vitest; the `*.test.cjs` suites are plain
`node:test` (see `vitest.config.ts`, which deliberately excludes them).
The test command builds fresh output first. See [source organization](src/README.md)
for module responsibilities, dependency rules, and Electron startup constraints.

## Package

```sh
pnpm dist:mac     # macOS dmg + zip
pnpm dist:win     # Windows nsis + zip (run on Windows)
```

Packaging recollects pnpm and the launchers. Windows builds require the matching MSVC Native Tools environment and Windows SDK for the small forwarding `node.exe`.

macOS artifacts are unsigned; Gatekeeper blocks first launch. Allow with:

```sh
xattr -dr com.apple.quarantine /Applications/DSH-Desktop.app
```

## Runtime dependencies

- Node supplied by Electron; pnpm (latest) and command launchers collected by `scripts/collect-runtime.mjs`
- `@deepseek-ai/dsh` (npm latest), installed to `~/.dsh/runtime`

## Updating Electron

Run `pnpm add -D -E electron@<version>` and `pnpm check`, then launch and test the packaged app.

Launchers and native plugin builds use the running Electron's path and version. Keep the `runAsNode` fuse enabled. DSH may reject a new Node/V8 combination, and existing ABI-specific plugins may need rebuilding; verify the UI, terminals and plugin installation before release. The DSH installation is shared with the CLI, so do not rebuild the entire shared runtime for Electron.

## Desktop plugin API

The shell injects `window.dshDesktop` into the DSH page (`updates` / `seats` / `notify` / `overlays` / `plugins`). Plugins should depend on that contract, not on Electron packaging code. See [docs/desktop-api.md](docs/desktop-api.md).

## Our plugins

Companion DSH plugins live in [DSH-Plugs](https://github.com/JustGenius-s/DSH-Plugs).

## Thanks to
- [Linux do](https://linux.do/)
