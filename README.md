# KomaScope

**English** | [简体中文](./README.zh-CN.md)

An open-source, lightweight desktop comic reader optimized for **4K displays (3840×2160)**. Read local comic pages at near-native resolution with pixel-perfect clarity. Fully offline, single-machine tool. Licensed under [Apache-2.0](./LICENSE).

> **Status**: All milestones M0–M5 complete — Electron + TypeScript app runs in dev mode (`pnpm dev`); folder browsing (natural sort), drag & drop import, image metadata parsing, first-screen rendering with page turning, pan, cursor-anchored wheel zoom, five fit modes, zoom lock, all keyboard shortcuts, HiDPI (devicePixelRatio-aware canvas + UI scale), tile rendering for >8192px images, adjacent-page pre-decoding, config persistence, lucide icons, bilingual app menu (File/Edit/View/Window/Language/Help) and zh/en language switching all work. Core pure logic (transform model, natural sort, image-size, window geometry, tile LRU & grid, i18n) is unit-tested; CI/CD (GitHub Actions) and community files (issue templates, CoC) are in place. See [DEVELOPMENT.en.md](./DEVELOPMENT.en.md) for the detailed development plan (Chinese: [DEVELOPMENT.md](./DEVELOPMENT.md)).

## Key Features

- **Crisp rendering**: Comic pages displayed at near-native resolution, no blur under HiDPI (100% / 125% / 150% / 200%); images exceeding the GPU texture limit automatically use tile-based rendering
- **Folder browsing**: Open a local folder and read page by page with **natural filename sorting** (`page2 < page10`); supports jpg / png / webp / gif / bmp / avif
- **Drag & drop**: Drop image files or an entire folder into the window to open them
- **Flexible zoom**: Mouse-wheel zoom anchored at the cursor, with five fit modes: `Fit Width` / `Fit Height` / `Fit Screen` / `Actual Size (1:1)` / `Custom Zoom`
- **Locked aspect ratio**: Aspect-ratio lock (default, width and height always scale proportionally, so distortion is impossible) plus a toggleable zoom lock (freezes the current scale; pan only)
- **Pan & page turning**: Pan by left-drag, turn pages with `←`/`→`, double-click toggles between Fit Screen and the last custom zoom
- **Window memory**: Window position/size persisted, remembered per-display on multi-monitor setups; F11 fullscreen reading
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
| Config persistence | `electron-store` (or hand-written JSON) at `userData/config.json` |
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
| `F` / `F11` | Toggle fullscreen |
| `Esc` | Exit fullscreen / close settings panel |
| Mouse wheel | Zoom anchored at the cursor (ignored while locked) |
| Left-drag | Pan the image |
| Double-click | Toggle between Fit Screen and the last custom zoom |
| Drop file/folder | Open the corresponding image/directory |

## Development

The development plan — requirements analysis, architecture, IPC protocol, rendering & transform model, milestones, test & verification checklist — lives in **[DEVELOPMENT.en.md](./DEVELOPMENT.en.md)** (Chinese: **[DEVELOPMENT.md](./DEVELOPMENT.md)**).

- Milestones: M0 Scaffolding → M1 Window & Config → M2 Image Loading → M3 Transform & Interaction → M4 4K Polish → M5 Packaging & Release (≈6–9 working days total)
- Unit tests: vitest, covering the transform model and natural sort pure logic
- On-device 4K verification: 3840×2160 at 100% / 150% / 200% scaling, checking sharpness, smoothness and large-image rendering

## Roadmap (Out of Current Scope)

By priority: zip / cbz archive reading (P0) → two-page spread mode, bookmarks & reading progress (P1) → image rotation & mirroring, trackpad/touchscreen support (P2) → web demo build (P3).

## Contributing

Issues and pull requests are welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before you start. Core pure logic (transform model, natural sort, LRU) is fully unit-tested — a good place to make your first contribution.

## Acknowledgments

- [Reasonix](https://github.com/esengine/DeepSeek-Reasonix.git) — the development and troubleshooting of this project were assisted by Reasonix throughout
- [DeepSeek](https://www.deepseek.com/) — provided powerful LLM support for requirements analysis, implementation and documentation of this project

## License

[Apache-2.0](./LICENSE)
