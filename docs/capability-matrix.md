# 能力矩阵与验证状态（T01）

依据 Issue #2 AC5：提交已测客户端/思源版本矩阵、接口契约样例、代理解包与能力结论；**真实请求证据和 Mock 测试明确区分**。

## 验证状态定义

- `MOCK-TESTED`：脱敏合成数据契约测试通过（vitest，无真实网络）。
- `DOC-VERIFIED`：与官方文档原文核对（WeRead 官方技能契约 / 思源 kernel API zh-CN 文档）。
- `UNVERIFIED-LIVE`：需要真实凭证或真实内核环境，尚未实测；相关能力在代码中不进入自动路径或显式标注。

## 客户端 / 思源版本矩阵

| 环境 | 本地验证 | 状态 |
| --- | --- | --- |
| Node 26.10.0 / npm 12.2.0（构建机，Windows） | `npm run check`（tsc+svelte-check 0 err/0 warn）、`npm test`（7 文件 52 用例全绿×3 次）、`npm run build`（vite 8.3.5，dist 7 项产物） | **已实测（2026-11-03）** |
| GitHub Actions（CI） | ubuntu-latest + node 24 + `npm ci` → check → test → build → dist artifact | 待首个 PR 运行后回填链接 |
| 思源桌面端（Electron） | 插件加载 + 设置页 + 连接测试 | UNVERIFIED-LIVE（无本地思源实例；需用户在隔离工作区实测） |
| 思源浏览器端 | forwardProxy 路径连接测试 | UNVERIFIED-LIVE（同上） |

## 接口能力结论

| 能力 | 通道 | 状态 | 证据 |
| --- | --- | --- | --- |
| 网关调用（Bearer + 平铺参数 + skill_version） | 内核 forwardProxy | MOCK-TESTED + DOC-VERIFIED | tests/contracts/gateway.test.ts |
| notebooks 分页（count+lastSort，异常检测） | 同上 | MOCK-TESTED | tests/contracts/notebooks-pager.test.ts |
| review/list/mine 分页（synckey，小写 bookid） | 同上 | MOCK-TESTED | tests/contracts/reviews-pager.test.ts |
| errcode/upgrade_info/鉴权失败语义 | 同上 | MOCK-TESTED | tests/contracts/gateway.test.ts |
| Key 脱敏（wrk- 前缀、Bearer） | 纯函数 | MOCK-TESTED | tests/contracts/redact.test.ts |
| 白名单守卫（唯一网关 URL） | 纯函数 | MOCK-TESTED | tests/contracts/whitelist.test.ts |
| 非破坏导入引擎（幂等/块映射/中断恢复/保护状态，AC1–AC7） | 引擎 + FakeKernel 故障注入 | MOCK-TESTED（tests/sync/engine.test.ts 20 例 + 纯函数层 98 例，2026-11-03 T02） | 设计契约 docs/design/t02-sync-core.md |
| 真实网关连通（有效/无效 Key） | — | UNVERIFIED-LIVE | 需用户本地 Key；代码路径已具备 |
| 思源块原位更新后 ID/属性/引用保留 | — | UNVERIFIED-LIVE | T02 未启用任何原位更新路径（只新建）；待授权隔离内核取证 |
| 思源 localStorage 密钥存储同步范围 | — | UNVERIFIED-LIVE | 文档如实标注：按端本地存储，非加密、不经内核同步 |
| 账号命名空间 | 用户显式配置 + keyMarker 换 Key 提醒 | 已实现（不自动换账号）；服务端身份字段探测 UNVERIFIED-LIVE | src/settings/account-store.ts |

## 代理解包

- 请求：`forwardProxy`（headers 数组、payloadEncoding=json、responseEncoding=text）→ `data.status`/`data.body`。
- 结论：桌面/浏览器共享同一 `Transport` 抽象；真实内核下的状态码透传与重定向行为 UNVERIFIED-LIVE。

## T02 整改后的 UNVERIFIED-LIVE 假设（合并门禁裁决，T06 取证）

1. 内核将创建 markdown 尾随 IAL 绑定到块并写入 blocks.ial（FakeKernel 假设，真实内核未测）；
2. getBlockKramdown 回读正文与渲染文本逐字一致、IAL 位于尾部；
3. 内核 SQL（blocks.ial LIKE + ESCAPE）行为与 SQLite 语义一致；
4. 无属性孤儿块（IAL 未落的创建窗口）会发生一次可见重复，无法自动认领（接受风险）；
5. updateBlock 原位更新语义（T03 前置）：完全未验证，T02 零调用。

## 遗留契约缺口（移交 T02 实测解决）

- **账号命名空间来源**：现有官方技能契约接口（notebooks/shelf/readdata 等）均未文档化"自身份（vid）"字段。Goal 要求账号命名空间不得以 Key 哈希定义、换 Key 不自动换账号。T02 方案：取得真实 Key 后优先探测服务端身份字段（`/_list` 及全量回包未文档化字段）；若确无可用身份字段，则由用户在首次配置时显式选择/确认账号标签，并显式确认 Key↔账号变更，绝不静默推导。
- **块更新语义**（updateBlock 后 ID/属性/引用保留、custom 属性、SQL 索引可见性）：UNVERIFIED-LIVE，T02 在授权隔离内核上取证后才解锁自动写入路径。
- **网关鉴权类 errcode 集合**：当前按 HTTP 语义实现为 `{401, 403}`（HTTP 层仅 401 映射 AuthError）；微信读书网关若存在专有鉴权 errcode，需真实联调后在 `src/adapters/weread/gateway.ts` 的 `AUTH_ERRCODES` 扩展。UNVERIFIED-LIVE。

## 不进入自动路径的能力（硬边界）

- 任何对既有块的原位更新/删除：需 T02 在授权隔离内核上取得“更新前后 ID/属性/引用”证据后才解锁。
- Cookie / 逆向 / 私有接口 / 扫码凭证 / 全文下载：永久禁止。
