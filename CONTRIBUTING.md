# 参与贡献 KomaScope

感谢你对 KomaScope 的关注!本文档说明如何搭建开发环境、提交 Issue 与 Pull Request。

设计与架构细节见 [DEVELOPMENT.md](./DEVELOPMENT.md)(英文版见 [DEVELOPMENT.en.md](./DEVELOPMENT.en.md))。

## 开发环境

- Node.js 22+,npm 11+
- Windows 10/11(主目标平台;macOS / Linux 可开发)

```bash
git clone https://github.com/moyutegong/KomaScope.git
cd KomaScope
npm install
npm run dev      # electron-vite 开发模式
npm run typecheck && npm run lint && npm test
```

## 提交 Issue

- **缺陷报告**:请使用 Bug Report 模板,并务必附上:
  - 显示器分辨率与系统缩放(如 3840×2160 / 150%);
  - 应用版本;
  - 最小复现步骤;
  - 涉及图片时说明尺寸与格式(如 3428×4820 jpg)。
- **功能请求**:先搜索已有 Issue,说明使用场景与预期交互。

## 提交 Pull Request

1. Fork 本仓库并创建特性分支:`git checkout -b feat/xxx` 或 `fix/xxx`;
2. 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/):`feat:` / `fix:` / `perf:` / `docs:` / `test:` / `refactor:`;
3. 涉及核心逻辑(变换模型、自然排序、LRU 等)的改动需补充/更新 vitest 单测;
4. 涉及文档的改动:**中文为源**,请同步更新对应英文文档;
5. 确保 CI 通过(typecheck + lint + 单测 + 构建)。

### PR 检查清单

- [ ] 代码通过 `npm run lint` 与 `npm run typecheck`
- [ ] 新增/修改逻辑有单测覆盖
- [ ] 中英文档已同步(如涉及)
- [ ] 无新增重型依赖(如需,请先开 Issue 讨论)

## 架构约定(贡献前必读)

- **渲染进程无 Node 权限**:所有文件访问经主进程 IPC,preload 仅暴露白名单 API(`window.komascope`);
- **变换模型单参数 `scale`**:不允许引入独立 x/y 缩放(等比锁定是核心设计);
- **新数据来源**(如 cbz / zip)通过 `SourceProvider` 接口扩展,不侵入阅读核心;
- 纯函数优先:可单测的逻辑不要耦合 DOM / Electron API。

## 行为准则

本项目采用 [Contributor Covenant v2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) 行为准则,参与即表示同意遵守。

## 许可证

提交贡献即表示同意你的贡献以 [MIT](./LICENSE) 许可证发布。
