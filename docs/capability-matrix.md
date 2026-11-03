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

## T03 审阅裁决补充（2026-11-03）

- updateBlock 用户批准路径已上线（T03），每次执行运行时验证（快照/ID/属性/内容）；**updateBlock 的内核 ID 稳定性在真实内核未取证**（FakeKernel 原地更新，结构上无法证伪"ID 不变"）——T06 实测假设 1-3 时一并取证，取证前相关测试不构成 ID 稳定性证据（审阅 m7 明示）。
- manual-merge 语义（主代理裁决，整改 B1）：manualText 即最终 markdown（UI 预填远端渲染文本、仅 trim 规范化），"预填→确认"幂等。
- isDecisionStale/sortCandidates 为公共工具保留（引擎内联等价实现；审阅 INFO8）。

## T04 审阅裁决补充（2026-11-03）

- **块引用标签实体转义（审阅 MAJOR-1）**：真实内核（Lute）对 `((id 'label'))` 标签做 HTML 实体转义（& " > 等）；本仓以写入端全角化规避（sanitizeRefLabel），回读全等比较成立的前提=标签不含触发字符——**真实内核回读形态仍未实测（UNVERIFIED-LIVE），T06 一并取证**；FakeKernel 不模拟实体转义（原样回显），相关测试不构成内核行为证据。
- **readingProgress/markedStatus 语义（审阅 MINOR-5）**：/user/notebooks 未文档化此二字段；按 0-100 与 1=读完假设实现，UNVERIFIED-LIVE，T05/T06 真实回包校准。
- **AC5 视觉证据**：桌面/浏览器、深浅色、窄窗截图与操作证据 UNVERIFIED-LIVE（无 GUI 环境），T06 GAC6 实测。
- 投影时机：整轮部分失败仍投影（失败书 syncedThisRound=false 不更新其 meta）——设计契约 §4 补充说明。

## T05 审阅裁决补充（2026-11-03）

- **多块 updateBlock 语义**：stats 快照以代码栅栏单块化写入（规避真实内核拆块未验证行为）；栅栏内多行是否被拆为多块 UNVERIFIED-LIVE，T06 取证；FakeKernel 原样单块存储，相关测试不构成内核行为证据。
- **dailyReadTimes/readTimes key 形态**：实现按"UTC 日起始秒字符串"精确匹配；若服务端为 CST 日界或其他形态，热力图将全 unknown（不伪造）——UNVERIFIED-LIVE，T06 以真实回包校准。
- **readDays/totalReadTime 字段语义**：按网关契约文档实现；真实回包校准 UNVERIFIED-LIVE。
- **含听书口径**：已从用户可见文案中删除该断言（待实测后再标注）。
- **快照文案语言**：当前为中文（交互 UI 有双语 i18n）；英文用户混排已知限制，T06 评估。
- **单书累计**：/book/getprogress recordReadingTime（秒）+progress（0-100）按契约实现，真实回包 UNVERIFIED-LIVE。
- AC5 视觉证据（深浅色/窄屏截图）UNVERIFIED-LIVE → T06；统计失败独立性与四败冷却优雅降级已有引擎级测试。

## 遗留契约缺口（移交 T02 实测解决）

- **账号命名空间来源**：现有官方技能契约接口（notebooks/shelf/readdata 等）均未文档化"自身份（vid）"字段。Goal 要求账号命名空间不得以 Key 哈希定义、换 Key 不自动换账号。T02 方案：取得真实 Key 后优先探测服务端身份字段（`/_list` 及全量回包未文档化字段）；若确无可用身份字段，则由用户在首次配置时显式选择/确认账号标签，并显式确认 Key↔账号变更，绝不静默推导。
- **块更新语义**（updateBlock 后 ID/属性/引用保留、custom 属性、SQL 索引可见性）：UNVERIFIED-LIVE，T02 在授权隔离内核上取证后才解锁自动写入路径。
- **网关鉴权类 errcode 集合**：当前按 HTTP 语义实现为 `{401, 403}`（HTTP 层仅 401 映射 AuthError）；微信读书网关若存在专有鉴权 errcode，需真实联调后在 `src/adapters/weread/gateway.ts` 的 `AUTH_ERRCODES` 扩展。UNVERIFIED-LIVE。

## 不进入自动路径的能力（硬边界）

- 任何对既有块的原位更新/删除：需 T02 在授权隔离内核上取得“更新前后 ID/属性/引用”证据后才解锁。
- Cookie / 逆向 / 私有接口 / 扫码凭证 / 全文下载：永久禁止。
