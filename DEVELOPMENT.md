# **KomaScope**开发文档

> 面向 4K 分辨率屏幕优化的开源轻量漫画阅读器(MIT)

---

## 1. 项目概述

### 1.1 定位

一个轻量的开源桌面漫画图片阅读器,核心优化目标为 **4K 分辨率(3840×2160)屏幕**:

- 漫画图片以接近原始分辨率清晰呈现,HiDPI 下无模糊;
- 窗口与图片的**位置、大小**调整方便,符合 4K 大屏下的交互习惯;
- 支持**锁定缩放比例**,避免误操作导致图片变形或比例错乱;
- 面向本地文件夹与拖拽导入,离线可用,单机工具;
- 开源项目(MIT),接受社区贡献,工程化约定见 §9 开源工程化。

### 1.2 平台目标

| 平台 | 优先级 | 说明 |
| --- | --- | --- |
| Windows 10/11 | ★★★ | 主目标,4K 显示器用户占比最高,NSIS 打包 exe |
| macOS | ★★ | Electron 跨平台支持,后期适配 |
| Linux | ☆ | 兼容即可,不重点投入 |

---

## 2. 需求分析

### 2.1 功能需求

| 编号 | 需求 | 说明 |
| --- | --- | --- |
| FR-1 | 文件夹浏览 | 打开本地文件夹,按文件名**自然排序**逐页阅读(jpg/png/webp/gif/bmp/avif) |
| FR-2 | 拖拽导入 | 拖拽图片文件或整个文件夹进入窗口即打开 |
| FR-3 | 翻页 | 上一页/下一页,键盘 ←/→、滚轮翻页(可选)、翻页动画 |
| FR-4 | 图片位置调整 | 视口内**平移**(拖拽);窗口位置可拖动并记忆 |
| FR-5 | 图片大小调整 | **缩放**:滚轮(以光标为锚点)、快捷键、状态栏百分比显示 |
| FR-6 | 适配模式 | `适应宽度` / `适应高度` / `适应屏幕` / `实际大小(1:1)` / `自定义缩放` |
| FR-7 | 锁定缩放比例 | ① **等比锁定**(默认):缩放始终按同一比例作用于宽高,图片永不拉伸变形;② **缩放锁定**(可切换):锁定当前缩放倍率,此后只能平移、不能缩放,防止误触 |
| FR-8 | 窗口管理 | 窗口位置/大小持久化,多显示器下按显示器记忆;一键"适应屏幕"铺满工作区 |
| FR-9 | 配置持久化 | 记住上次打开的文件夹、窗口几何、缩放、适配模式、锁定状态 |
| FR-10 | 全屏 | F11 全屏阅读(4K 屏下全屏即 3840×2160 视口) |
| FR-11 | 状态栏 | 页码/总页数、缩放百分比、图片原始分辨率、锁定状态、缩放比例锁定图标 |

### 2.2 非功能需求

| 编号 | 需求 | 指标 |
| --- | --- | --- |
| NFR-1 | 渲染性能 | 4K 视口内平移/缩放 3000~6000px 宽漫画图 ≥ 30fps,不丢帧 |
| NFR-2 | 加载性能 | 首页图从点击打开到可见 ≤ 500ms;翻页预解码,相邻页 ≤ 200ms |
| NFR-3 | HiDPI 适配 | 支持 Windows 100% / 125% / 150% / 200% 缩放,图像按物理像素渲染,UI 尺寸随 DPI 合理缩放 |
| NFR-4 | 内存友好 | 解码缓存 LRU 上限(默认 8 页),翻页释放不可见页 |
| NFR-5 | 安全 | `contextIsolation: true`,渲染进程无 Node 权限,文件访问全部经主进程 |
| NFR-6 | 离线 | 完全离线可用,无任何网络依赖 |

### 2.3 "锁定缩放比例"的两种语义(均需实现)

1. **等比锁定(比例锁定)** — 缩放模型使用**单一缩放系数** `scale`,宽高永远同比例变化,图片宽高比恒定。这是默认且不可关闭的行为,从数学上杜绝拉伸变形。
2. **缩放锁定(倍率锁定)** — 用户按下 `L` 或点击锁定按钮后,`scale` 被冻结;滚轮、快捷键缩放操作被忽略,仅允许平移与翻页。再按 `L` 解锁。

---

## 3. 技术选型

### 3.1 选型总览

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 桌面框架 | Electron 33+ | Chromium 对 4K/HiDPI 渲染支持最成熟;`devicePixelRatio`、GPU 合成、CSS transform 动画均为原生能力;开发机已具备 Node 22 + npm 11 |
| 语言 | TypeScript 5 | 变换模型、IPC 协议、状态机均需要强类型约束 |
| 构建 | electron-vite + electron-builder | electron-vite 一体化开发/构建主进程+渲染进程;electron-builder 出 NSIS/dmg 安装包 |
| 渲染层 | HTML5 + Canvas 2D | 图片绘制用 `<canvas>`(可精确控制 DPR 与瓦片),UI 面板用 DOM |
| UI 框架 | 不使用重型框架 | 阅读器核心是高性能变换渲染,Vue/React 收益低且增加包体;UI 仅工具栏/状态栏/设置面板,Vanilla TS 足够 |
| 图片解码 | 浏览器原生 `createImageBitmap()` + `ImageDecoder`(可选) | 异步解码不阻塞主线程,支持渐进式 |
| 配置持久化 | `electron-store`(或自写 JSON 读写) | 轻量、可靠,配置为纯数据无副作用 |
| 状态管理 | 自写轻量 store(事件发布/订阅) | 避免引入 Redux 等重依赖 |

### 3.2 备选方案对比(为何不用)

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| 纯 Web 应用 | 备选 | 浏览器沙箱限制本地文件夹遍历,无法做窗口级"适应屏幕"与多显示器记忆;但可保留一个 `web` 构建目标作为演示 |
| Python + PySide6 | 不采用 | 4K 高 DPI 与图片渲染性能调优成本高,打包体积不小 |
| Tauri | 不采用 | 需要 Rust 工具链,当前环境未安装,且 Canvas 大图渲染生态不如 Chromium 成熟 |

---

## 4. 架构设计

### 4.1 进程模型

```
┌─────────────────────────────────────────────────┐
│ 主进程 (Main)                                    │
│  ├─ WindowManager   窗口创建/几何记忆/多显示器    │
│  ├─ FileService     文件夹扫描/自然排序/元数据    │
│  ├─ ConfigStore     配置读写与校验                │
│  └─ IpcHandler      统一 IPC 路由与白名单校验     │
└───────────────┬─────────────────────────────────┘
                │ contextBridge (preload, 仅暴露白名单 API)
┌───────────────▼─────────────────────────────────┐
│ 渲染进程 (Renderer)                              │
│  ├─ ViewerController   阅读器状态机(唯一真相源)  │
│  ├─ TransformModel     仿射变换数学模型(纯函数)  │
│  ├─ ImageRenderer      Canvas 绘制/DPR/瓦片渲染   │
│  ├─ TileCache          瓦片与解码缓存 (LRU)       │
│  ├─ InputController    鼠标/键盘/滚轮/拖拽映射    │
│  └─ UI 面板            工具栏/状态栏/设置         │
└─────────────────────────────────────────────────┘
```

**安全基线**:`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`;渲染进程通过 `window.komascope`(preload 注入)调用主进程能力。

### 4.2 IPC 通道清单

| 通道 | 方向 | 说明 |
| --- | --- | --- |
| `folder:open` | R→M | 打开系统目录选择器,返回图片文件列表(自然排序) |
| `folder:scan` | R→M | 扫描指定目录,返回 `{ path, name, width, height, size }[]` |
| `file:readMeta` | R→M | 读取单张图片尺寸(不解码全图,仅解析头部) |
| `file:stream` | R→M | 按页索引流式读取图片字节:主进程 `net.handleFileOpen` 返回 Web Stream,渲染进程边取边解码 |
| `config:get` / `config:set` | R→M | 配置读写,主进程落盘 |
| `window:getInfo` | R→M | 获取 `{ bounds, workArea, dpr, screenId }` |
| `window:setBounds` | R→M | 设置窗口位置/大小(拖拽窗口结束、适应屏幕时调用) |
| `window:toggleFullscreen` | R→M | 全屏切换 |

> 图片数据通过 Web Streams 传输(`net.handleFileOpen`),渲染进程以 `createImageBitmap(stream)` 增量解码;4K 大图(数十 MB)无需整图载入 IPC 内存,主进程不参与像素处理。
>
> **可扩展性**:文件访问统一走 `SourceProvider` 抽象(文件夹源为首个实现;zip/cbz 压缩包源为后续扩展),阅读层不感知数据来源。

### 4.3 渲染与变换模型(核心)

**坐标系**:

- 视口坐标系:窗口内容区 CSS 像素,原点左上角,尺寸 `viewportW × viewportH`;
- 图片坐标系:图片原始像素,原点左上角,尺寸 `imgW × imgH`;
- 变换:`screen = scale * (image - origin) + translate`,即单参数 `scale` + 平移向量 `(tx, ty)`。

**等比锁定**:模型只存在一个 `scale`,不存在独立 x/y 缩放,从数学结构上保证宽高比恒定(满足 FR-7 语义 ①)。

**锚点缩放公式**(以光标位置 `p` 为不动点):

```
scale' = clamp(scale * factor, MIN_SCALE, MAX_SCALE)
tx'    = p.x - (p.x - tx) * (scale' / scale)
ty'    = p.y - (p.y - ty) * (scale' / scale)
```

**缩放锁定**:`locked` 为 `true` 时,`setScale()` 直接拒绝写入,仅 `setTranslate()` 生效(满足 FR-7 语义 ②)。

**适配模式计算**(切换窗口大小或翻页后自动应用):

```
fitWidth   : scale = viewportW / imgW
fitHeight  : scale = viewportH / imgH
fitScreen  : scale = min(fitWidth, fitHeight)
actual     : scale = 1(物理像素下按 dpr 校正)
custom     : 用户缩放,记录百分比,翻页后保留
```

**缩放范围**:`MIN_SCALE = 0.05`,`MAX_SCALE = 8.0`(4K 屏下足够覆盖 100px 缩略图到 8000px 长条图)。

### 4.4 4K / HiDPI 专项设计

| 问题 | 方案 |
| --- | --- |
| 高分屏模糊 | Canvas 物理分辨率 = CSS 尺寸 × `devicePixelRatio`;监听 `window.devicePixelRatio` 变化重建画布 |
| 窗口默认大小 | 首次启动按 `screen.getPrimaryDisplay().workArea` 取 `min(工作区 88%, 3360×1890)`;多显示器启动时定位到上次所在显示器 |
| UI 控件尺寸 | 全局 `--ui-scale` 系数 = `dpr 相关基准(以 150% 为 1.0)`,工具栏/状态栏字号与间距按系数缩放,4K 下控件不过小、1080p 下不过大 |
| 超大图片 | 超过 GPU 纹理上限(约 8192px)的图启用**瓦片渲染**:离屏 canvas 按 2048×2048 切片,仅绘制视口可见瓦片,平移缩放时增量绘制 |
| 瓦片渐进显示 | 缺失瓦片按到视口中心距离排序解码(中心优先);单块解码完成且变换未变时立即增量绘制,画面渐进填充而非整批等待;变换已变由批次完成回调整帧重绘兜底 |
| 渲染合并 | 变换(缩放/平移)立即写入状态,实际重绘经 `requestAnimationFrame` 合并,每帧最多一次整帧绘制(滚轮/拖拽事件 100Hz+ → 60fps) |
| 显示缩放缓存 | 整页模式低倍率显示(2^-k ≥ scale×dpr)时使用 2 的幂预缩小位图采样,每帧 GPU 采样像素降至 1/4~1/16,锐度无损(缓存分辨率 ≥ 物理显示分辨率) |
| 高频 IPC 防抖 | 缩放交互期间 `setConfig` 150ms 防抖合并(主进程另 500ms 落盘防抖);页面卸载时冲刷防抖中配置,最后状态不丢失 |
| 翻页性能 | 预解码策略:当前页 + 后一页(向前翻时加前一页),LRU 容量 8 页 |
| 全屏 | 全屏即获得完整 3840×2160 视口,适配模式自动重算 |
| 缩放流畅度 | 缩放期间用 CSS `transform` 合成层做预览,松手后重绘高精度画面(可选优化) |

### 4.5 配置持久化

`config.json`(存放于 `app.getPath('userData')`):

```jsonc
{
  "windowBounds": { "x": 320, "y": 90, "width": 3360, "height": 1890 },
  "screenId": "DISPLAY_2",          // 上次所在显示器,多显示器记忆
  "lastFolder": "F:\\Comics\\OnePiece",
  "fitMode": "fitScreen",           // fitWidth | fitHeight | fitScreen | actual | custom
  "scale": 1.0,                     // custom 模式下的缩放百分比
  "scaleLocked": false,             // 缩放锁定状态
  "uiScale": 1.0,                   // UI 缩放系数
  "theme": "dark",
  "wheelAction": "zoom"             // zoom | page(滚轮动作)
}
```

写盘节流:配置变更 500ms 防抖后落盘;窗口移动/缩放结束(resize/move 停止)时记录几何。

---

## 5. 交互设计

| 操作 | 行为 |
| --- | --- |
| 滚轮(视口) | 以光标为锚点缩放(锁定状态下忽略) |
| 滚轮(侧栏) | 上下切换图片(上一页 / 下一页) |
| 滚轮(长图模式) | 滚动浏览长条图片 |
| `Ctrl+滚轮`(长图模式) | 缩放长图(50%–400%,与滚动区分) |
| 左键拖拽 | 平移图片;拖拽到边缘可翻页(可选) |
| 双击 | 在 `fitScreen` 与上一次自定义缩放间切换 |
| 拖入文件/文件夹/压缩包 | 打开对应图片/目录(压缩包支持 zip/cbz) |
| `←` / `→` | 上一页 / 下一页(双页跨页模式下步进 2) |
| `+` / `-` | 放大 / 缩小(锚点=视口中心) |
| `0` | 适应屏幕 |
| `1` | 实际大小 1:1 |
| `W` / `H` | 适应宽度 / 适应高度 |
| `L` | 切换缩放锁定(状态栏图标同步) |
| `R` | 重置视图(居中 + fitScreen) |
| `F` / `F11` | OS 全屏切换 |
| `Esc` | 退出沉浸 / 全屏 |
| 沉浸按钮 | 切换非全屏无边框模式(沉浸);退出时重建有边框窗口以便访问系统菜单 |
| 侧栏分隔条 | 拖拽调整历史 / 图片区块占比(15%–85%) |
| 工具栏空白区 | 拖动无边框窗口位置(自绘最小化/最大化/关闭按钮) |

**状态栏示例**:`第 12 / 240 页 · 3428×4820 · 缩放 87% · 🔒 锁定`

---

## 6. 目录结构规划

```
KomaScope/
├── package.json
├── electron.vite.config.ts
├── electron-builder.yml
├── tsconfig.json
├── LICENSE                       # MIT
├── CONTRIBUTING.md               # 贡献指南
├── .github/
│   ├── ISSUE_TEMPLATE/           # 缺陷报告/功能请求模板
│   └── workflows/
│       ├── ci.yml                # lint + typecheck + 单测(PR/push)
│       └── release.yml           # tag 触发,electron-builder 出包并发布
├── resources/
│   ├── icon.png                  # EXE/安装包图标(KomaScope 艺术字)
│   └── window-icon.png           # 窗口标题栏图标(lucide image 开源图标)
├── src/
│   ├── main/                     # 主进程
│   │   ├── index.ts              # 入口:创建窗口、注册 IPC
│   │   ├── window-manager.ts     # 窗口创建/几何记忆/多显示器/全屏
│   │   ├── file-service.ts       # 目录扫描、自然排序、图片元数据
│   │   ├── config-store.ts       # 配置读写(防抖落盘)
│   │   └── ipc.ts                # IPC 路由与参数校验
│   ├── preload/
│   │   └── index.ts              # contextBridge 白名单 API
│   └── renderer/
│       ├── index.html
│       ├── app.ts                # 启动装配
│       ├── shared/
│       │   ├── types.ts          # IPC 协议类型、页面模型
│       │   └── natural-sort.ts   # 自然排序(1,2,10,11)
│       ├── viewer/
│       │   ├── viewer-controller.ts   # 状态机:页/适配/锁定/变换
│       │   ├── transform-model.ts     # 纯函数变换数学(可单测)
│       │   ├── image-renderer.ts      # Canvas 绘制、DPR、瓦片
│       │   ├── tile-cache.ts          # 瓦片 + 解码 LRU
│       │   └── input-controller.ts    # 输入映射
│       └── ui/
│           ├── toolbar.ts
│           ├── statusbar.ts
│           └── settings-panel.ts
└── tests/
    ├── transform-model.test.ts   # 锚点缩放/锁定/适配 单测
    └── natural-sort.test.ts
```

---

## 7. 核心数据流

```
打开文件夹(按钮/拖拽)
  → 主进程 scan:读取目录 → 过滤图片扩展名 → 自然排序 → 读取尺寸元数据
  → IPC 返回页面列表 PageList
  → ViewerController 定位到上次阅读页(可选,记住页码)
  → 请求当前页 file:stream → createImageBitmap(stream) 流式解码
  → ImageRenderer 按 TransformModel 状态绘制到 Canvas(考虑 DPR/瓦片)
  → 用户交互 → InputController 更新 TransformModel → 重绘 → 状态栏同步
  → 缩放/平移停止 → 配置防抖落盘
```

---

## 8. 关键算法清单

| 算法 | 位置 | 说明 |
| --- | --- | --- |
| 自然排序 | `shared/natural-sort.ts` | 数字段按数值比较(`page2 < page10`),中英文混排 |
| 锚点缩放 | `transform-model.ts` | 见 4.3 公式,纯函数、可单测 |
| 适配计算 | `transform-model.ts` | fitWidth/fitHeight/fitScreen/actual |
| 可见瓦片枚举 | `image-renderer.ts` | 由视口矩形与变换反算可见瓦片范围 |
| LRU 淘汰 | `tile-cache.ts` | 解码结果按最近使用淘汰,上限 8 页 |
| DPR 重建 | `image-renderer.ts` | dpr 变化时重建 canvas 缓冲并重绘 |

---

## 9. 开源工程化

### 9.1 许可与版本策略

- 许可证:**MIT**(极简宽松,对商用与二次分发友好);
- 版本号:语义化版本 `MAJOR.MINOR.PATCH`,以 `v*` tag 触发发布;
- 提交规范:Conventional Commits(`feat:` / `fix:` / `perf:` / `docs:` ...),便于自动生成变更日志。

### 9.2 CI / CD(GitHub Actions)

| 工作流 | 触发 | 内容 |
| --- | --- | --- |
| ci | PR / push | `tsc --noEmit` + ESLint + vitest 单测 |
| build | PR / push | windows-latest 构建产物验证(macos-latest 可选) |
| release | push tag `v*` | electron-builder 生成 NSIS exe / dmg,上传至 GitHub Release |

### 9.3 社区基础设施

| 文件 | 用途 |
| --- | --- |
| `CONTRIBUTING.md` | 开发环境搭建、分支模型、PR 检查清单 |
| `.github/ISSUE_TEMPLATE/` | 缺陷报告(需附分辨率/系统缩放/复现步骤)、功能请求 |
| `CODE_OF_CONDUCT.md` | 行为准则(Contributor Covenant v2.1) |

### 9.4 贡献友好设计

- 核心纯逻辑(变换模型、自然排序、LRU)保持纯函数 + 单测覆盖,降低贡献门槛;
- IPC 通道与快捷键映射均为数据表驱动,便于以小型 PR 增量贡献;
- 新格式/来源(cbz、zip)通过 `SourceProvider` 接口扩展,不侵入阅读核心。

---

## 10. 开发里程碑

| 里程碑 | 内容 | 预估 |
| --- | --- | --- |
| M0 脚手架 | electron-vite + TS 工程、主/preload/渲染三端骨架、Dev 模式跑通 | 0.5 天 |
| M1 窗口与配置 | WindowManager(多显示器记忆、默认尺寸)、ConfigStore、IPC 基座 | 1 天 |
| M2 图片加载 | FileService 扫描/排序/元数据、拖拽、解码与首屏渲染 | 1~2 天 |
| M3 变换交互 | TransformModel + 平移/锚点缩放/适配模式/缩放锁定、快捷键 | 1~2 天 |
| M4 4K 打磨 | DPR 适配、UI 缩放系数、瓦片渲染、预解码、状态栏 | 1~2 天 |
| M5 打包与发布 | electron-builder NSIS 安装包、图标、GitHub Actions CI/Release、Issue 模板与贡献指南 | 1 天 |

**总计约 6~9 个工作日**。建议每个里程碑结束做一次 4K 实机验证(见 §11)。

**M5 之后的持续迭代(v0.1 / v0.2)已交付**:

- zip/cbz 压缩包直接阅读(fflate 流式,带资源上限);
- 双页跨页阅读(左右并排,翻页步进 2);
- 书签与阅读进度记忆(页码持久化 + 打开恢复);
- 图片旋转(90°步进)与水平/垂直镜像;
- 沉浸模式(非全屏无边框窗口,退出重建有边框访问系统菜单)与默认无边框窗口;
- 长图模式(单页无限下拉 + Ctrl+滚轮缩放);
- 侧栏(历史文件夹管理、图片列表、可拖拽区块占比)与自动隐藏 UI;
- 深色主题视觉刷新与代码精简(死代码清理、共享 MIME 工具)。

---

## 11. 测试与验证

### 11.1 单元测试(纯逻辑,`vitest`)

- `transform-model`:锚点缩放不动点性质、缩放范围钳制、锁定后拒绝写入、四种适配模式计算;
- `natural-sort`:`[p1, p2, p10, p11]` 顺序、大小写、混排。

### 11.2 4K 实机验证清单

| 项目 | 验证内容 |
| --- | --- |
| 分辨率 | 3840×2160 显示器,系统缩放 100% / 150% / 200% 各跑一遍 |
| 清晰度 | 3428×4820 漫画页 1:1 显示无模糊、无摩尔纹 |
| 流畅度 | 平移/缩放全程 ≥30fps(DevTools Performance 记录) |
| 大图 | 8000px+ 长条图平移缩放正常,无纹理上限黑块 |
| 锁定 | 缩放锁定后滚轮无效、仅平移;解锁恢复 |
| 多显示器 | 窗口在副屏(4K)关闭后重开,回到原显示器原位置大小 |
| 持久化 | 改窗口几何/缩放/锁定后重启,配置完整恢复 |

### 11.3 手动冒烟用例

1. 打开含 200 张图的文件夹 → 逐页翻页无卡顿、内存不持续增长;
2. 拖拽单张图 / 整个文件夹进窗口;
3. 全屏 ↔ 窗口模式切换,适配模式自动重算;
4. 长时间阅读后检查内存(任务管理器)稳定。

---

## 12. 风险与备选方案

| 风险 | 应对 |
| --- | --- |
| GPU 纹理上限导致超大图黑块 | 瓦片渲染(§4.4),上线前用 8000×12000 测试图压测 |
| 大目录(数千张)扫描慢 | 扫描放主进程异步执行,分页返回列表;首屏仅加载元数据 |
| 解码内存峰值 | 解码并发上限 2 张,LRU 8 页,超限主动 `close()` 释放 bitmap |
| 无边框窗口在部分 Windows 版本缩放异常 | 提供"系统边框窗口"开关,默认使用标准边框 + 记忆几何 |
| Electron 包体较大(~80MB) | 裁剪未用 Chromium 特性、启用压缩;如对体积敏感再评估 Tauri |
| DPI 变化(拖动到不同缩放显示器) | 监听 `display-metrics-changed` 事件重建画布与 UI 系数 |
| 中英文档双份维护漂移 | 中文为源,英文随 PR 同步更新;文档变更列入 PR 检查清单 |

---

## 13. 后续扩展(非本期范围)

按优先级排序(以下功能已在 v0.2 前迭代完成:**zip/cbz 直接阅读、双页跨页、书签与阅读进度、图片旋转与镜像**):

- 触摸板手势与触摸屏支持(P2);
- Web 版构建目标(浏览器演示,P3);
- 翻页动画 / 过渡效果(P2);
- 双页模式下的旋转与镜像组合优化(P2)。

---

## 14. 致谢

- [Reasonix](https://github.com/esengine/DeepSeek-Reasonix.git) —— 本项目的开发与排障全程由 Reasonix 辅助完成;
- [DeepSeek](https://www.deepseek.com/) —— 为需求分析、代码实现与文档编写提供了强大的大模型能力支持。
