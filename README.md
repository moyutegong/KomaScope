# KomaScope

**English** | [简体中文](./README.zh-CN.md)

An open-source, lightweight desktop comic reader optimized for **4K displays (3840×2160)**. Read local comic pages at near-native resolution with pixel-perfect clarity. Fully offline, single-machine tool. Licensed under [MIT](./LICENSE).

> **Status**: v0.2.0 released — Electron + TypeScript app runs in dev mode (`pnpm dev`). Features: folder & archive (zip/cbz) browsing with natural sort, drag & drop import, first-screen rendering, page turning & two-page spread, pan, cursor-anchored wheel zoom, five fit modes, zoom lock, long-strip mode (endless vertical strip + Ctrl+wheel zoom), bookmarks & reading progress, image rotation & mirroring, HiDPI (devicePixelRatio-aware canvas + UI scale), tile rendering for >8192px images, adjacent-page pre-decoding, config persistence, **frameless window by default** (immersive = non-fullscreen frameless; rebuilds with a frame to access the system menu), **sidebar** (history management + image list + adjustable split), **auto-hide UI**, lucide icons, bilingual app menu and zh/en switching. Core pure logic (transform model, natural sort, image-size, window geometry, tile LRU & grid, i18n, config store, archive parsing) is unit-tested (70 tests); GitHub Actions CI/CD (daily tests + v* tag auto build/release) and community files are in place. See [DEVELOPMENT.en.md](./DEVELOPMENT.en.md) for the detailed development plan (Chinese: [DEVELOPMENT.md](./DEVELOPMENT.md)).

## Key Features

- **Crisp rendering**: Comic pages displayed at near-native resolution, no blur under HiDPI (100% / 125% / 150% / 200%); images exceeding the GPU texture limit automatically use tile-based rendering
- **Folder & archives**: Open a local folder or a **zip/cbz archive** and read page by page with **natural filename sorting** (`page2 < page10`); supports jpg / png / webp / gif / bmp / avif
- **Drag & drop**: Drop image files, an entire folder or an archive into the window to open them
- **Flexible zoom**: Mouse-wheel zoom anchored at the cursor, with five fit modes: `Fit Width` / `Fit Height` / `Fit Screen` / `Actual Size (1:1)` / `Custom Zoom`
- **Locked aspect ratio**: Aspect-ratio lock (default, width and height always scale proportionally, so distortion is impossible) plus a toggleable zoom lock (freezes the current scale; pan only)
- **Pan & page turning**: Pan by left-drag, turn pages with `←`/`→`, double-click toggles between Fit Screen and the last custom zoom; two-page spread layout supported
- **Long-strip mode**: Stack all pages vertically into one endless scrollable strip; plain wheel scrolls, `Ctrl+wheel` zooms (50%–400%), clicking any image jumps to that page
- **Frameless window**: Frameless by default (no title bar / system menu); toolbar is a drag region with custom min/max/close buttons; immersive mode = non-fullscreen frameless, exiting rebuilds a framed window so the system menu is accessible; `F11` is OS fullscreen
- **Sidebar**: Recently opened folders/archives (individually removable, click to reopen) + image list of the current source (click to jump); history/images split is draggable
- **Auto-hide UI**: On by default; sidebar/toolbar/statusbar float away and reappear near screen edges
- **Window memory**: Window position/size persisted, remembered per-display on multi-monitor setups
- **Performance friendly**: Pre-decoding + LRU decode cache (8 pages by default); ≥30fps pan/zoom target in a 4K viewport
- **Fully offline**: No network dependency at all

## Platform Support

| Platform | Priority | Notes |
| --- | --- | --- |
| Windows 10/11 | ★★★ | Primary target; packaged as NSIS installer (exe) |
| macOS | ★★ | Electron cross-platform; adapted later |
| Linux | ☆ | Best-effort compatibility only |

## Tech Stack

| Layer | Choice |
| --- | --- |
| Desktop framework | Electron 33+ (mature Chromium 4K / HiDPI rendering) |
| Language | TypeScript 5 |
| Build | electron-vite + electron-builder (NSIS / dmg) |
| Rendering | HTML5 Canvas 2D (precise DPR & tile control); DOM for UI panels, no heavyweight framework |
| Image decoding | Native browser `createImageBitmap()` (Web Streams streaming decode, non-blocking) |
| Archive parsing | fflate (streaming zip/cbz decompression with resource limits against zip bombs) |
| Config persistence | Hand-written JSON at `userData/config.json` |
| Security baseline | `contextIsolation: true`, `sandbox: true`; renderer has no Node access, all file access via the main process |

## Keyboard Shortcuts

| Key | Action |
| --- | --- |
| `←` / `→` | Previous page / Next page |
| `+` / `-` | Zoom in / Zoom out (anchor = viewport center) |
| `0` | Fit Screen |
| `1` | Actual Size 1:1 |
| `W` / `H` | Fit Width / Fit Height |
| `L` | Toggle zoom lock |
| `R` | Reset view (center + Fit Screen) |
| `F` / `F11` | Toggle OS fullscreen |
| `Esc` | Exit immersive / fullscreen |
| Wheel (viewport) | Zoom anchored at the cursor (ignored while locked) |
| Wheel (sidebar) | Previous / next page |
| Wheel (long strip) | Scroll the strip |
| `Ctrl+wheel` (long strip) | Zoom the strip (50%–400%) |
| Left-drag | Pan the image |
| Double-click | Toggle between Fit Screen and the last custom zoom |
| Drop file/folder/archive | Open the corresponding image/directory |

## Development

The development plan — requirements analysis, architecture, IPC protocol, rendering & transform model, milestones, test & verification checklist — lives in **[DEVELOPMENT.en.md](./DEVELOPMENT.en.md)** (Chinese: **[DEVELOPMENT.md](./DEVELOPMENT.md)**).

- Milestones: M0 Scaffolding → M1 Window & Config → M2 Image Loading → M3 Transform & Interaction → M4 4K Polish → M5 Packaging & Release (all complete); follow-up features (zip/cbz, spread mode, bookmarks, rotation, immersive, long strip, etc.) iterate continuously
- Unit tests: vitest, 70 tests covering transform model, natural sort, image-size, window geometry, tile LRU & grid, i18n, config store, archive parsing and other pure logic
- On-device 4K verification: 3840×2160 at 100% / 150% / 200% scaling, checking sharpness, smoothness and large-image rendering

## Roadmap (Out of Current Scope)

By priority: trackpad/touchscreen support (P2) → web demo build (P3).

## Contributing

Issues and pull requests are welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before you start. Core pure logic (transform model, natural sort, LRU, archive parsing) is fully unit-tested — a good place to make your first contribution.

## Acknowledgments

- [Reasonix](https://github.com/esengine/DeepSeek-Reasonix.git) — the development and troubleshooting of this project were assisted by Reasonix throughout
- [DeepSeek](https://www.deepseek.com/) — provided powerful LLM support for requirements analysis, implementation and documentation of this project

## License

[MIT](./LICENSE)
