# **KomaScope** Development Document

> An open-source lightweight comic reader optimized for **4K resolution** displays (Apache-2.0)

---

## 1. Project Overview

### 1.1 Positioning

A lightweight open-source desktop comic reader whose core optimization target is **4K resolution (3840×2160) displays**:

- Comic pages are rendered at near-native resolution — no blur under HiDPI;
- Window and image **position/size** adjustments are convenient, matching interaction habits on large 4K screens;
- Supports **aspect-ratio locking** to prevent accidental distortion or scale corruption;
- Works with local folders and drag-and-drop import — fully offline, single-machine tool;
- Open-source project (Apache-2.0), open to community contributions; see §9 Open-Source Engineering for conventions.

### 1.2 Platform Targets

| Platform | Priority | Notes |
| --- | --- | --- |
| Windows 10/11 | ★★★ | Primary target; highest share of 4K display users; packaged as NSIS exe |
| macOS | ★★ | Electron cross-platform; adapted later |
| Linux | ☆ | Best-effort compatibility only |

---

## 2. Requirements Analysis

### 2.1 Functional Requirements

| ID | Requirement | Description |
| --- | --- | --- |
| FR-1 | Folder browsing | Open a local folder, read page by page with **natural filename sorting** (jpg/png/webp/gif/bmp/avif) |
| FR-2 | Drag & drop import | Dragging image files or an entire folder into the window opens them |
| FR-3 | Page turning | Previous/next page, keyboard `←`/`→`, wheel page-turn (optional), page-turn animation |
| FR-4 | Image position adjustment | **Pan** within the viewport (drag); window position draggable and remembered |
| FR-5 | Image size adjustment | **Zoom**: wheel (anchored at cursor), shortcuts, percentage shown in the status bar |
| FR-6 | Fit modes | `Fit Width` / `Fit Height` / `Fit Screen` / `Actual Size (1:1)` / `Custom Zoom` |
| FR-7 | Locked zoom ratio | ① **Aspect-ratio lock** (default): zoom always applies a single ratio to width and height; the image can never be stretched or distorted. ② **Zoom lock** (toggleable): freezes the current zoom factor; after that only panning is allowed, preventing accidental zoom |
| FR-8 | Window management | Window position/size persistence, remembered per-display on multi-monitor setups; one-click "Fit Screen" fills the work area |
| FR-9 | Config persistence | Remember last opened folder, window geometry, zoom, fit mode, lock state |
| FR-10 | Fullscreen | F11 fullscreen reading (on a 4K display, fullscreen equals a 3840×2160 viewport) |
| FR-11 | Status bar | Page number/total pages, zoom percentage, image native resolution, lock state, aspect-ratio-lock icon |

### 2.2 Non-Functional Requirements

| ID | Requirement | Metric |
| --- | --- | --- |
| NFR-1 | Rendering performance | Pan/zoom of 3000–6000px wide comic pages in a 4K viewport ≥ 30fps, no dropped frames |
| NFR-2 | Loading performance | First page visible from click-to-open ≤ 500ms; pre-decode adjacent pages, next page ≤ 200ms |
| NFR-3 | HiDPI support | Windows 100% / 125% / 150% / 200% scaling; images rendered at physical pixels, UI scales reasonably with DPI |
| NFR-4 | Memory friendly | Decode cache LRU cap (8 pages by default); off-screen pages released on page turn |
| NFR-5 | Security | `contextIsolation: true`, no Node access in the renderer; all file access through the main process |
| NFR-6 | Offline | Fully offline, no network dependency |

### 2.3 The Two Semantics of "Locked Zoom Ratio" (both to be implemented)

1. **Aspect-ratio lock (ratio lock)** — The zoom model uses a **single scale factor** `scale`; width and height always change proportionally, keeping the image aspect ratio constant. This is the default, non-disableable behavior, mathematically ruling out stretching distortion.
2. **Zoom lock (factor lock)** — When the user presses `L` or clicks the lock button, `scale` is frozen; wheel and shortcut zoom operations are ignored; only panning and page turning remain. Press `L` again to unlock.

---

## 3. Technology Selection

### 3.1 Selection Overview

| Layer | Choice | Rationale |
| --- | --- | --- |
| Desktop framework | Electron 33+ | Chromium has the most mature 4K/HiDPI rendering support; `devicePixelRatio`, GPU compositing, and CSS transform animations are all native capabilities; dev machine already has Node 22 + npm 11 |
| Language | TypeScript 5 | The transform model, IPC protocol, and state machine all need strong typing |
| Build | electron-vite + electron-builder | electron-vite provides integrated dev/build for main + renderer; electron-builder produces NSIS/dmg installers |
| Rendering layer | HTML5 + Canvas 2D | Images drawn on `<canvas>` (precise DPR and tile control), UI panels in DOM |
| UI framework | No heavyweight framework | The viewer core is high-performance transform rendering; Vue/React yield little benefit and add bundle size; UI is only toolbar/status bar/settings panel, Vanilla TS suffices |
| Image decoding | Native browser `createImageBitmap()` + `ImageDecoder` (optional) | Async decoding does not block the main thread, supports progressive decoding |
| Config persistence | `electron-store` (or hand-written JSON read/write) | Lightweight and reliable; config is pure data with no side effects |
| State management | Hand-written lightweight store (event publish/subscribe) | Avoids heavy dependencies like Redux |

### 3.2 Alternatives Considered (and why not)

| Option | Verdict | Reason |
| --- | --- | --- |
| Pure web app | Backup | Browser sandbox restricts local folder traversal; cannot do window-level "Fit Screen" or per-display memory. But a `web` build target can be kept for demos |
| Python + PySide6 | Not adopted | High-DPI and image rendering performance tuning costs are high; package size is not small |
| Tauri | Not adopted | Requires a Rust toolchain (not installed in the current environment); Canvas large-image rendering ecosystem is less mature than Chromium's |

---

## 4. Architecture Design

### 4.1 Process Model

```
┌─────────────────────────────────────────────────┐
│ Main Process                                    │
│  ├─ WindowManager   window creation/geometry memory/multi-display │
│  ├─ FileService     folder scan/natural sort/metadata │
│  ├─ ConfigStore     config read/write & validation │
│  └─ IpcHandler      unified IPC routing & whitelist validation │
└───────────────┬─────────────────────────────────┘
                │ contextBridge (preload, exposes whitelisted API only)
┌───────────────▼─────────────────────────────────┐
│ Renderer Process                                │
│  ├─ ViewerController   viewer state machine (single source of truth) │
│  ├─ TransformModel     affine transform math (pure functions) │
│  ├─ ImageRenderer      Canvas drawing/DPR/tile rendering │
│  ├─ TileCache          tile & decode cache (LRU) │
│  ├─ InputController    mouse/keyboard/wheel/drag mapping │
│  └─ UI panels          toolbar/status bar/settings │
└─────────────────────────────────────────────────┘
```

**Security baseline**: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; the renderer calls main-process capabilities via `window.komascope` (injected by preload).

### 4.2 IPC Channel List

| Channel | Direction | Description |
| --- | --- | --- |
| `folder:open` | R→M | Opens the system directory picker; returns the image file list (natural sort) |
| `folder:scan` | R→M | Scans a given directory; returns `{ path, name, width, height, size }[]` |
| `file:readMeta` | R→M | Reads a single image's dimensions (header-only, no full decode) |
| `file:stream` | R→M | Streams image bytes by page index: main process `net.handleFileOpen` returns a Web Stream; the renderer decodes incrementally |
| `config:get` / `config:set` | R→M | Config read/write; persisted to disk by the main process |
| `window:getInfo` | R→M | Gets `{ bounds, workArea, dpr, screenId }` |
| `window:setBounds` | R→M | Sets window position/size (called after window drag ends or on Fit Screen) |
| `window:toggleFullscreen` | R→M | Fullscreen toggle |

> Image data is transferred via Web Streams (`net.handleFileOpen`); the renderer decodes incrementally with `createImageBitmap(stream)`. Large 4K images (tens of MB) never need to be fully loaded into IPC memory, and the main process never touches pixels.
>
> **Extensibility**: file access goes through a `SourceProvider` abstraction (folder source first; zip/cbz archive sources later), so the reading layer is agnostic to the data origin.

### 4.3 Rendering & Transform Model (Core)

**Coordinate systems**:

- Viewport coordinates: window content area in CSS pixels, origin top-left, size `viewportW × viewportH`;
- Image coordinates: image native pixels, origin top-left, size `imgW × imgH`;
- Transform: `screen = scale * (image - origin) + translate`, i.e. a single `scale` + translation vector `(tx, ty)`.

**Aspect-ratio lock**: the model has exactly one `scale`; there is no independent x/y scaling, so the aspect ratio is guaranteed constant by the mathematical structure (satisfies FR-7 semantic ①).

**Anchor zoom formula** (cursor position `p` as fixed point):

```
scale' = clamp(scale * factor, MIN_SCALE, MAX_SCALE)
tx'    = p.x - (p.x - tx) * (scale' / scale)
ty'    = p.y - (p.y - ty) * (scale' / scale)
```

**Zoom lock**: when `locked` is `true`, `setScale()` rejects writes outright; only `setTranslate()` takes effect (satisfies FR-7 semantic ②).

**Fit mode calculation** (auto-applied after window resize or page turn):

```
fitWidth   : scale = viewportW / imgW
fitHeight  : scale = viewportH / imgH
fitScreen  : scale = min(fitWidth, fitHeight)
actual     : scale = 1 (corrected by dpr in physical pixels)
custom     : user zoom, percentage recorded, kept across page turns
```

**Zoom range**: `MIN_SCALE = 0.05`, `MAX_SCALE = 8.0` (enough on a 4K display to cover everything from 100px thumbnails to 8000px long strips).

### 4.4 4K / HiDPI Specific Design

| Problem | Solution |
| --- | --- |
| Blur on high-DPI screens | Canvas physical resolution = CSS size × `devicePixelRatio`; listen to `window.devicePixelRatio` changes and rebuild the canvas |
| Default window size | First launch uses `screen.getPrimaryDisplay().workArea`, taking `min(88% of work area, 3360×1890)`; on multi-display startup, position at the last used display |
| UI control sizing | Global `--ui-scale` factor = DPI-based baseline (1.0 at 150%); toolbar/status bar font sizes and spacing scale by the factor — controls are not too small at 4K nor too large at 1080p |
| Very large images | Images beyond the GPU texture limit (~8192px) use **tile rendering**: offscreen canvas sliced into 2048×2048 tiles, only viewport-visible tiles drawn, incremental drawing during pan/zoom |
| Page-turn performance | Pre-decode strategy: current page + next page (plus previous page when turning backward); LRU capacity of 8 pages |
| Fullscreen | Fullscreen yields the full 3840×2160 viewport; fit modes recalculate automatically |
| Zoom smoothness | CSS `transform` compositing layer for preview during zoom, high-precision redraw on release (optional optimization) |

### 4.5 Config Persistence

`config.json` (stored at `app.getPath('userData')`):

```jsonc
{
  "windowBounds": { "x": 320, "y": 90, "width": 3360, "height": 1890 },
  "screenId": "DISPLAY_2",          // last display, multi-display memory
  "lastFolder": "F:\\Comics\\OnePiece",
  "fitMode": "fitScreen",           // fitWidth | fitHeight | fitScreen | actual | custom
  "scale": 1.0,                     // zoom percentage in custom mode
  "scaleLocked": false,             // zoom lock state
  "uiScale": 1.0,                   // UI scale factor
  "theme": "dark",
  "wheelAction": "zoom"             // zoom | page (wheel action)
}
```

Write throttling: config changes debounced 500ms before persisting; window geometry recorded when move/resize settles.

---

## 5. Interaction Design

| Action | Behavior |
| --- | --- |
| Mouse wheel (viewport) | Zoom anchored at the cursor (ignored while locked) |
| Mouse wheel (sidebar) | Previous / next page |
| Mouse wheel (long strip) | Scroll the strip |
| `Ctrl+wheel` (long strip) | Zoom the strip (50%–400%, distinct from scrolling) |
| Left-drag | Pan the image; dragging to the edge may turn pages (optional) |
| Double-click | Toggle between `fitScreen` and the last custom zoom |
| Drop file/folder/archive | Open the corresponding image/directory (zip/cbz supported) |
| `←` / `→` | Previous page / Next page (step 2 in spread mode) |
| `+` / `-` | Zoom in / Zoom out (anchor = viewport center) |
| `0` | Fit Screen |
| `1` | Actual Size 1:1 |
| `W` / `H` | Fit Width / Fit Height |
| `L` | Toggle zoom lock (status bar icon syncs) |
| `R` | Reset view (center + Fit Screen) |
| `F` / `F11` | OS fullscreen toggle |
| `Esc` | Exit immersive / fullscreen |
| Immersive button | Toggle non-fullscreen frameless mode; exiting rebuilds a framed window so the system menu is accessible |
| Sidebar divider | Drag to adjust history/images split (15%–85%) |
| Toolbar blank area | Drag the frameless window (custom min/max/close buttons) |

**Status bar example**: `Page 12 / 240 · 3428×4820 · Zoom 87% · 🔒 Locked`

---

## 6. Directory Structure Plan

```
KomaScope/
├── package.json
├── electron.vite.config.ts
├── electron-builder.yml
├── tsconfig.json
├── LICENSE                       # Apache-2.0
├── CONTRIBUTING.md               # contribution guide
├── .github/
│   ├── ISSUE_TEMPLATE/           # bug report / feature request templates
│   └── workflows/
│       ├── ci.yml                # lint + typecheck + unit tests (PR/push)
│       └── release.yml           # tag-triggered electron-builder publish
├── resources/
│   └── icon.png                  # app icon
├── src/
│   ├── main/                     # main process
│   │   ├── index.ts              # entry: create window, register IPC
│   │   ├── window-manager.ts     # window creation/geometry memory/multi-display/fullscreen
│   │   ├── file-service.ts       # directory scan, natural sort, image metadata
│   │   ├── config-store.ts       # config read/write (debounced persistence)
│   │   └── ipc.ts                # IPC routing & parameter validation
│   ├── preload/
│   │   └── index.ts              # contextBridge whitelist API
│   └── renderer/
│       ├── index.html
│       ├── app.ts                # startup assembly
│       ├── shared/
│       │   ├── types.ts          # IPC protocol types, page model
│       │   └── natural-sort.ts   # natural sort (1,2,10,11)
│       ├── viewer/
│       │   ├── viewer-controller.ts   # state machine: page/fit/lock/transform
│       │   ├── transform-model.ts     # pure-function transform math (unit-testable)
│       │   ├── image-renderer.ts      # Canvas drawing, DPR, tiles
│       │   ├── tile-cache.ts          # tile + decode LRU
│       │   └── input-controller.ts    # input mapping
│       └── ui/
│           ├── toolbar.ts
│           ├── statusbar.ts
│           └── settings-panel.ts
└── tests/
    ├── transform-model.test.ts   # anchor zoom/lock/fit unit tests
    └── natural-sort.test.ts
```

---

## 7. Core Data Flow

```
Open folder (button/drag & drop)
  → main process scan: read directory → filter image extensions → natural sort → read dimension metadata
  → IPC returns PageList
  → ViewerController locates the last-read page (optional, remembers page number)
  → request current page via file:stream → createImageBitmap(stream) streaming decode
  → ImageRenderer draws to Canvas per TransformModel state (considering DPR/tiles)
  → user interaction → InputController updates TransformModel → redraw → status bar syncs
  → zoom/pan settles → config persisted after debounce
```

---

## 8. Key Algorithm List

| Algorithm | Location | Description |
| --- | --- | --- |
| Natural sort | `shared/natural-sort.ts` | Numeric segments compared by value (`page2 < page10`), mixed Chinese/English |
| Anchor zoom | `transform-model.ts` | See formula in 4.3; pure function, unit-testable |
| Fit calculation | `transform-model.ts` | fitWidth/fitHeight/fitScreen/actual |
| Visible tile enumeration | `image-renderer.ts` | Back-calculate visible tile range from viewport rect and transform |
| LRU eviction | `tile-cache.ts` | Decoded results evicted by least-recent use, cap 8 pages |
| DPR rebuild | `image-renderer.ts` | Rebuild canvas buffer and redraw on dpr change |

---

## 9. Open-Source Engineering

### 9.1 License & Versioning

- License: **Apache-2.0** (includes patent grant; friendly to commercial reuse and redistribution);
- Versioning: Semantic Versioning `MAJOR.MINOR.PATCH`; releases triggered by `v*` tags;
- Commit convention: Conventional Commits (`feat:` / `fix:` / `perf:` / `docs:` ...), enabling auto-generated changelogs.

### 9.2 CI / CD (GitHub Actions)

| Workflow | Trigger | Content |
| --- | --- | --- |
| ci | PR / push | `tsc --noEmit` + ESLint + vitest unit tests |
| build | PR / push | Build artifact verification on windows-latest (macos-latest optional) |
| release | push tag `v*` | electron-builder produces NSIS exe / dmg, uploaded to GitHub Release |

### 9.3 Community Infrastructure

| File | Purpose |
| --- | --- |
| `CONTRIBUTING.md` | Dev environment setup, branching model, PR checklist |
| `.github/ISSUE_TEMPLATE/` | Bug reports (must include resolution / OS scaling / repro steps), feature requests |
| `CODE_OF_CONDUCT.md` | Code of Conduct (Contributor Covenant v2.1) |

### 9.4 Contribution-Friendly Design

- Core pure logic (transform model, natural sort, LRU) kept as pure functions with unit-test coverage, lowering the contribution barrier;
- IPC channels and shortcut mappings are data-table driven, enabling small incremental PRs;
- New formats/sources (cbz, zip) extend via the `SourceProvider` interface without touching the reading core.

---

## 10. Development Milestones

| Milestone | Content | Estimate |
| --- | --- | --- |
| M0 Scaffolding | electron-vite + TS project, main/preload/renderer skeleton, Dev mode runs | 0.5 day |
| M1 Window & Config | WindowManager (multi-display memory, default size), ConfigStore, IPC base | 1 day |
| M2 Image Loading | FileService scan/sort/metadata, drag & drop, decoding & first render | 1–2 days |
| M3 Transform & Interaction | TransformModel + pan/anchor zoom/fit modes/zoom lock, shortcuts | 1–2 days |
| M4 4K Polish | DPR support, UI scale factor, tile rendering, pre-decoding, status bar | 1–2 days |
| M5 Packaging & Release | electron-builder NSIS installer, icon, GitHub Actions CI/Release, issue templates & contribution guide | 1 day |

**Total ≈ 6–9 working days**. On-device 4K verification after each milestone is recommended (see §11).

**Continuous iteration after M5 (delivered in v0.1 / v0.2)**:

- zip/cbz archive reading (fflate streaming, with resource limits);
- two-page spread layout (side-by-side, page step 2);
- bookmarks & reading progress memory (page persistence + restore on open);
- image rotation (90° steps) and horizontal/vertical mirroring;
- immersive mode (non-fullscreen frameless window; exiting rebuilds a framed window to access the system menu) and frameless window by default;
- long-strip mode (endless vertical strip + Ctrl+wheel zoom);
- sidebar (history management, image list, draggable split) and auto-hide UI;
- dark theme visual refresh and code slimming (dead-code removal, shared MIME utility).

---

## 11. Testing & Verification

### 11.1 Unit Tests (pure logic, `vitest`)

- `transform-model`: anchor-zoom fixed-point property, scale-range clamping, reject writes when locked, four fit-mode calculations;
- `natural-sort`: `[p1, p2, p10, p11]` ordering, case handling, mixed sorting.

### 11.2 On-Device 4K Verification Checklist

| Item | Verification content |
| --- | --- |
| Resolution | Run on a 3840×2160 display at system scaling 100% / 150% / 200% |
| Sharpness | 3428×4820 comic page at 1:1 — no blur, no moiré |
| Smoothness | Pan/zoom ≥30fps throughout (DevTools Performance recording) |
| Large images | 8000px+ long strips pan/zoom normally, no black tiles at texture limit |
| Lock | After zoom lock, wheel is inert, pan only; unlocking restores |
| Multi-display | Window closed on secondary (4K) display and reopened — returns to the same display, position and size |
| Persistence | Change window geometry/zoom/lock, restart — config fully restored |

### 11.3 Manual Smoke Test Cases

1. Open a folder with 200 images → page through without stutter, memory does not grow continuously;
2. Drag a single image / an entire folder into the window;
3. Toggle fullscreen ↔ windowed, fit modes recalculate automatically;
4. After long reading sessions, check memory (Task Manager) stays stable.

---

## 12. Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| GPU texture limit causes black tiles on very large images | Tile rendering (§4.4); stress-test with an 8000×12000 test image before release |
| Large directories (thousands of images) scan slowly | Scan asynchronously in the main process, return the list paginated; first screen loads metadata only |
| Decode memory spikes | Decode concurrency cap of 2, LRU 8 pages, proactively `close()` bitmaps when over the limit |
| Frameless window scaling issues on some Windows versions | Provide a "system-bordered window" toggle; default to standard border + remembered geometry |
| Electron bundle size is large (~80MB) | Trim unused Chromium features, enable compression; re-evaluate Tauri if size-sensitive |
| DPI changes (drag to a display with different scaling) | Listen for `display-metrics-changed` to rebuild canvas and UI factor |
| Bilingual docs drifting apart | Chinese is the source of truth; English syncs within the same PR; doc sync is on the PR checklist |

---

## 13. Future Extensions (Out of Current Scope)

In priority order (the following were already delivered through the v0.2 iterations: **zip/cbz reading, two-page spread, bookmarks & reading progress, image rotation & mirroring**):

- Trackpad gestures & touchscreen support (P2);
- Web build target — browser demo (P3);
- Page-turn animations / transitions (P2);
- Combined rotation & mirroring optimization in spread mode (P2).

---

## 14. Acknowledgments

- [Reasonix](https://github.com/esengine/DeepSeek-Reasonix.git) — development and troubleshooting of this project were assisted by Reasonix throughout;
- [DeepSeek](https://www.deepseek.com/) — provided powerful LLM support for requirements analysis, implementation and documentation.
