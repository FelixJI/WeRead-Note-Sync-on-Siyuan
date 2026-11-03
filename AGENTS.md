# AGENTS.md — 本仓库 AI 协作规则

适用于所有在本仓库工作的 AI 代理（规划、实施、审阅）。用户启动指令只界定当次行为边界；本文件界定仓库内不变量。

## 任务协议

- GitHub Issue 是唯一任务状态源；不创建长期计划文件、状态 JSON 或第二套事实源。
- 每个 Task 按 Issue 合同执行：范围、验收标准（AC）、依赖门禁以 Issue 文字为准。
- 依赖任务必须以**真实合并证据**（PR mergeCommit、集成 SHA）解锁，代理宣称完成不算。
- 未验证的能力一律标注 `UNVERIFIED`；Mock 测试与真实请求证据必须明确区分，不得混写。

## 安全不变量（任何任务不得违反）

1. 只使用微信读书官方 Agent API Gateway（`https://i.weread.qq.com/api/agent/gateway`，Bearer `wrk-` Key）与思源公开内核 API；禁止 Cookie、逆向、私有接口、扫码抓取凭证。
2. API Key 不得出现在仓库、笔记、日志、诊断包、截图或任何提交内容中；日志输出前必须经 `src/core/security/redact.ts` 脱敏。
3. 网络请求不得越过白名单（唯一远端网关地址 + 本地内核 API）；不开放任意 Base URL。
4. 远端文本永远作为纯文本/kramdown 转义处理，不得作为可执行 HTML/脚本注入。
5. 不直接修改 .sy 文件或数据库；一切写入走内核公开 API。
6. 默认不覆盖用户正文：新增可导入；既有正文变化默认进入待审 diff；不自动删除、不自动复活本地删除；规范引用锚点不删除重建。
7. CI 与测试不得依赖真实 Key；真实联调凭证只能在用户本地输入。

## 工程约定

- TypeScript `strict: true`；`npm run check`（tsc + svelte-check）、`npm test`（vitest）、`npm run build` 必须全绿才算门禁通过。
- 提交信息使用中文 Conventional Commits（如 `feat(适配器): ...`、`fix(设置): ...`、`test(契约): ...`）。
- 共享配置（package.json、tsconfig、vite.config）由主代理串行集成；并行工作包按 Issue 的 Work Packages 隔离划分写路径。
- 先写测试后实现（先红后绿），红绿证据保存到 `.ai-flow/runtime/`（已 gitignore），PR 正文引用命令与摘要。
- 参考第三方代码必须先核对许可证并保留署名；不引入 Cookie 回退、覆盖式导出或删除重建引用目标的模式。

## 构建与测试

- `npm install` 一次性由主代理执行；子代理只运行 check/test/build，不改共享配置。
- 构建：Vite + Svelte 5 + TypeScript，输出 CJS `index.js`（external `siyuan`），思源插件标准结构（plugin.json、i18n、icon）。
- 测试：vitest，契约测试覆盖分页、错误、脱敏、白名单；不访问真实网络。
