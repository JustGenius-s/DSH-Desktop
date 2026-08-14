# DSH-Decktop

Electron desktop shell for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Bundles node + pnpm, installs `@deepseek-ai/dsh` into `~/.dsh/runtime`, and serves the `dsh web` UI in a browser window.

## How it works

```
Electron main process
  ├─ bundled node + pnpm (resources/runtime; repo-root runtime/ in dev)
  ├─ first launch: pnpm installs @deepseek-ai/dsh → ~/.dsh/runtime (upgradeable)
  ├─ spawn  dsh web --host 127.0.0.1 --port <free-port>
  └─ BrowserWindow → http://127.0.0.1:<port>
```

DSH is installed from npm at runtime, not shipped with the app. Upgrading DSH = detect a newer version on launch → click "Update" → restart. No rebuild or re-signing.

## Develop

```sh
pnpm install
pnpm collect      # download node + pnpm into runtime/
pnpm start        # first launch installs @deepseek-ai/dsh (~1-2 min)
```

Dev and packaged behave identically: both use the bundled node and the external `~/.dsh/runtime`.

## Package

```sh
pnpm dist:mac     # macOS dmg + zip
pnpm dist:win     # Windows nsis + zip (run on Windows)
```

macOS artifacts are unsigned; Gatekeeper blocks first launch. Allow with:

```sh
xattr -dr com.apple.quarantine /Applications/DSH-Decktop.app
```

## Runtime dependencies

- node (latest) + pnpm (latest), bundled via `scripts/collect-runtime.mjs`
- `@deepseek-ai/dsh` (npm latest), installed to `~/.dsh/runtime`

## Thanks to
- [Linux do](https://linux.do/)