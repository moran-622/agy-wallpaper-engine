# Changelog

All notable changes to **agy-wallpaper-engine** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-11-24

Zero-visual-compromise rendering, GPU power, and main-thread performance update.

### Performance & Reliability
- **Eliminated `MutationObserver` full-tree churn**: `watchBrowserHoles` in `src/bg-runtime.js` and `src/picker-ui.js` no longer listens to high-frequency `class`/`style` mutations across `document.body`; scroll listeners now use `{ capture: true, passive: true }` and skip geometry scans when no split-pane browser holes exist.
- **WebGL2 MSAA disabled & automatic software-renderer protection**: `src/webwallgl-host/renderer.js` forces `antialias: false` on WebGL2 scene contexts to save GPU memory bandwidth, detects software renderers (`Microsoft Basic Render Driver` / `SwiftShader` / `llvmpipe`), and automatically falls back to the high-resolution preview with a console status notice instead of stalling the UI.
- **Smart unfocus FPS throttling & scroll-pause**: `src/bg-runtime.js` automatically throttles WebGL2 scene rendering down to `5 FPS` (cutting background GPU load by ~83%) when Antigravity loses focus, restores the configured FPS immediately on focus, and silently pauses scene frame submission during active scrolling without altering Liquid Glass blur.
- **Loopback static asset caching**: `src/media-server.mjs` adds `Cache-Control: private, max-age=300` to preview images and read-only `scene.pkg` responses while preserving `HEAD` and HTTP `Range 206` behavior.
- **Expanded automated test suite**: increased from 64 to **69** cross-platform tests (`npm test`), verifying blur/focus FPS handoff, software-renderer fallback, scroll/observer cleanup, and cache headers.

## [1.0.0] - 2026-11-24

Initial public release of **agy-wallpaper-engine** — a zero-invasion local Wallpaper Engine runtime and iOS Liquid Glass theme engine for Google Antigravity Desktop on Windows.

### Added
- **Full Wallpaper Engine Format Support**:
  - Native streaming `PKGV` (`scene.pkg` / `.mpkg`) archive parser with built-in LZ4 block decompression and LRU caching (zero full-disk extraction).
  - WebGL2 `scene` rendering via `webwallgl` inside a sandboxed iframe host with automatic fallback to embedded video or preview image on timeout.
  - `video` playback with HTTP `206 Partial Content` Range streaming, `web` wallpapers under strict CSP sandbox, and static/animated `image` wallpapers.
  - Automatic Steam & Wallpaper Engine discovery via Windows Registry and `libraryfolders.vdf` (Workshop `431960` + `defaultprojects`), plus local media upload up to 200 MB (works even without Steam).
- **iOS Liquid Glass Theme Engine**:
  - 4 curated presets: **Liquid Auto** (`液态灵动`), **Crystal** (`极致赏图`), **Frosted** (`长文专注`), and **Cinema Dark** (`暗夜影院`).
  - Independent glass tone mode (`auto` / `light` / `dark`) and 7 real-time parameter sliders (background dim, background blur, canvas veil opacity, card/composer opacity, sidebar/topbar opacity, glass blur, and liquid border glow).
  - Non-destructive CSS scoping (`body[data-agy-we-glass="on"]`) designed to coexist cleanly with native Antigravity menus, settings dialogs, and community plugins.
- **Shadow DOM Wallpaper Console & Pure Viewing Mode**:
  - Isolated Shadow DOM drawer (`Alt+Shift+W`) with search, random pick, favorites pinning, local import, 7 balanced single-row filter chips (`All / Favorites / Scene / Video / Web / Built-in / Trash`), and live FPS/playback controls.
  - Pure Viewing / Peek mode (`Alt+Shift+H`, exit with `Esc` or `Alt+Shift+H`) to fade out the entire UI and enjoy the live wallpaper unobstructed.
  - Draggable viewport edge dock with persisted vertical position and leader-only multi-window slideshow rotation.
- **Two-Stage Recycle Bin**:
  - Safe hide-to-trash (`×`), one-click single/bulk restore, and inline two-step confirmed purge (deletes uploaded files on disk; marks Steam/custom wallpapers as permanently hidden without touching original Steam files).
- **Antigravity Split-Pane & Browser-Hole Avoidance**:
  - Event-driven `clip-path: path(evenodd, ...)` cutout around `[data-browser-hole="true"]` regions so split panes and embedded browser previews stay completely unobstructed.
  - Automatic picker dock/drawer repositioning away from right-docked browser panes.
- **WebGL2 `R8` / `RG8` Particle Albedo Fix**:
  - Runtime WebGL2 context wrapper that detects `R8` / `RG8` internal formats and patches `u_albedoR8` shader sampling so single/dual-channel particle textures render with accurate alpha and color instead of dark/opaque squares.
- **Zero-Invasion Lifecycle & Update Resilience (`install.mjs`)**:
  - One-command `install`, `start`, `stop`, `status`, `shortcut`, and `uninstall` CLI with silent Windows Startup VBS autostart (no admin privileges required).
  - Dedicated `Antigravity (CDP).lnk` Start Menu shortcut (`--remote-debugging-port=0 --remote-debugging-address=127.0.0.1`) that survives Antigravity auto-updates without patching `app.asar` or the install directory.
  - In-place runtime/picker hot-upgrade (`__agyWeBg` / `__agyWePicker` version handoff) and clean DOM teardown on stop/uninstall.
- **Automated Verification**:
  - 64 cross-platform automated unit and integration tests (`npm test`) running on Node.js 22+ with zero external test framework dependencies.
