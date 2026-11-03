# T02 同步核心设计契约（冻结）

> Task #3：非破坏导入、稳定块映射与中断恢复。本文件由主代理冻结，实施不得偏离；偏差须回报主代理裁决。
> 依赖：T01（PR #8 → 4c7345c）已合并。T01 移交门禁：**块更新语义 UNVERIFIED-LIVE → T02 只允许"新建块"进入自动路径；对既有块的原位更新一律不自动执行**（候选留给 T03），本设计即按此约束实现。

## 1. 身份模型（AC1/AC5）

- `sourceKey = accountNamespace / bookId / kind / officialSourceId`
  - `kind ∈ {"highlight", "review"}`；`officialSourceId`：highlight=bookmarkId，review=reviewId。
  - `accountNamespace`：用户显式配置的账号标识（设置页输入，默认空）。**不以 Key 哈希定义**；`keyMarker`（Key 的 SHA-256 前 16 hex）仅用于"换 Key 提醒"，绝不参与身份。
- 思源侧双记录：
  1. 块属性 `custom-wrs-src = sourceKey`（块上）；文档根块 `custom-wrs-book-id` + `custom-wrs-account`。
  2. 本地状态索引（可由 1 经 SQL 重建，但索引不是唯一存在性证据——存在性以块 ID 回读为准）。
- 同名书按 bookId 区分；缺官方 ID 不猜主键（跳过+异常）。

## 2. 状态存储（AC7 双世代）

- 载体：`Plugin.loadData/saveData`（内核侧持久化，随工作区同步与备份）。存储名：
  - `index`：`{schemaVersion, accountNamespace, keyMarker?, notebookId?, books:{bookId→{docId,title,generation}}}`
  - `book-<bookId>`：每书状态 `{schemaVersion, bookId, docId?, title, generation, items:{sourceKey→ItemState}, pendingOp?}`
  - `oplog`：环形数组（上限 500 条，超出丢最旧），元素见 §4。
- 双世代写入：save(name, data) 先把当前写为 `<name>.prev` 再写 `<name>`；load(name) 失败时回退 `.prev`，两级都坏 → **保护模式**（本轮停写、上报，绝不重建猜测）。
- ItemState 字段：
  ```
  blockId?, parentBlockId?, kind, sourcePayload(原始字段快照), renderedText(渲染快照),
  localBaseline(写后回读的 kramdown), versionFingerprint(稳定序列化指纹，仅比较用),
  status: active|user-deleted|moved-out|unseen|quarantined,
  override=false, lastSeenRound, lastChangeRound
  ```
- **指纹不代替快照**：比较用指纹，人工/审阅用 payload 与 localBaseline 正文。

## 3. 计划计算（纯函数，AC1/AC2/AC5/AC6）

输入：当前书状态 + 本轮来源明细（bookmarklist+reviews，含分页 anomalies）+ round 号。输出 Plan：
- `creates[]`：状态中不存在且 SQL/状态无归属的条目（仅新建；**绝无 update/delete**）。
- `candidates[]`：来源载荷变化且本地 active 的条目 → 待审（T03 处理；T02 只记录+报告）。
- `protected[]`：来源本轮未返回（unseen 计数+1，永不删除标记）；本地已删除（blockId 回读失败且非本轮写入）；moved-out（parent ≠ docId）；歧义（同 sourceKey 多块 → quarantined，任选一个=禁止）。
- 前置门禁：来源分页 anomalies 非空或抛错 → **整书跳过，不产出任何 creates/candidates，不推进任何基线**（T01 审阅移交条件）。
- 排序稳定性：highlight 按 (chapterIdx, rangeStart, createTime, bookmarkId)；review 优先挂到 (chapterUid+range) 匹配的 highlight 下，无匹配入"想法"独立区（按 createTime, reviewId）。

## 4. 写入引擎（AC3/AC4 状态机，主代理持有）

每步顺序（单个 create）：
1. `oplog.append({opId, intent:"create", sourceKey, payload, status:"pending"})` + book state 落 `pendingOp` → **持久化**
2. 执行：`insertBlock(previousID=prevBlockId)`（首条用 `appendBlock(parentID=docId)`）→ 得 blockId
3. `setBlockAttrs(blockId, {custom-wrs-src})`
4. 回读：`getBlockKramdown(blockId)` → localBaseline
5. oplog 完成（status:"done", blockId）+ ItemState 写入 + 清 pendingOp → **持久化**
- 任何一步失败/中断：状态停留 pendingOp；**下一轮 reconcile**：
  - 有 blockId（第 2 步后中断）：回读该块；内容匹配 → 补记账（推进基线）；不匹配 → quarantine。
  - 无 blockId（第 2 步中断/响应丢失）：按 `custom-wrs-src` SQL 查询——找到 1 块且内容匹配 → 收养；0 块 → 重执行；≥2 块 → quarantine。
  - **绝不盲目再次创建**（先查再建），**绝不提前推进基线**（记账以回读为准）。
- 文档创建：`createDocWithMd(notebook, "/"+sanitize(title), "")` → docId → 根块 setBlockAttrs（bookId/account）→ 逐条插入。标题 sanitize：`/`→`／`，首尾空白去除，空则用 bookId 兜底。
- 笔记本：`createNotebook("微信读书")` 一次；后续轮以 `lsNotebooks` 核实；丢失时先按文档属性 SQL 找回既有文档再决定重建（不重复建）。
- 部分成功：每书独立 try；一书失败不影响他书（index.books 各自 generation 独立）。

## 5. kramdown 渲染（纯函数）

- highlight → blockquote：`> ` + escaped(markText)（多行逐行前缀）。
- review（挂靠）→ 父块子块 list item：`- 💭 ` + escaped(content)。
- review（独立）→ "## 📝 想法" 区块下 list item。
- 章节 h3：`### ` + escaped(chapterTitle)；书首 `## ✂️ 摘录`。
- 转义规则（kramdown 注入防护）：远端文本按纯文本行处理；`\` 反斜杠转义 kramdown 标记字符；行首的 `>`/`#`/`-`/`*`/`+`/数字`.` 强制转义；HTML 标签形 `<...>` 全转义；属性 IAL `{:...}` 行首出现即转义。**远端文本永不解释为 HTML/脚本**（T01 不变量延续）。

## 6. 恢复与重建（AC4）

- 索引重建：SQL `select id, parent_id, ial from blocks where ial like '%custom-wrs-src="..%'`（限 notebook 范围）→ 恢复 book→doc 与 sourceKey→blockId 映射；重建后仍以回读核对内容。
- 基线丢失（book state 双世代全坏）：进入保护模式——停写该账本，报告用户；**不猜测重建基线**（身份可重建 ≠ 基线可猜测）。
- 复制属性（同 sourceKey 多块）：quarantine，生成待审候选，禁止任选接管。

## 7. 禁止事项（实现红线）

不替换已有正文；不自动删除任何块；不复活本地删除；不按文本相似性绑定身份；不支持多设备同时写入（本轮无锁设计，单客户端假设写入 T06）；不直接改 .sy/数据库；对既有块的任何 update/delete 调用不得出现在自动路径（T03 另议）。

## 8. 审阅整改与主代理裁决记录（2026-11-03，独立审阅 FAIL→整改）

独立只读审阅结论 FAIL（1 BLOCKER + 6 MAJOR + 6 MINOR），逐项裁决：

| 项 | 裁决 | 处置 |
| --- | --- | --- |
| B1 createNotebook 返回形状 | 修复 | 读 data.notebook.id；FakeKernel 改为真实形状 |
| M1 双世代 save 毁坏 .prev | 修复 | 仅当当前世代通过有效性校验才晋升 .prev（store.test.ts 证） |
| M2 保护模式被 UI 报成功 | 修复 | 书级 error 全部计入错误消息；outcome.ok 消费 |
| M3 LIKE 通配符未转义 | 修复 | likeEscape（%/\/\）+ escape '\' 子句；引擎全查询点覆盖；含 `_` bookId 回归测试 |
| M4 标题找回误认领 | 修复 | 仅认领"无主且为空"的孤儿；同名有内容 → 人工处理错误，不认领不新建（回归测试） |
| M5 每轮 5 本无轮转 | 修复 | index.rotation 轮转游标 + deferredBooks 上报（回归测试） |
| M6 块语义 UNVERIFIED-LIVE | **接受+显式标注** | 无本地真实内核，无法冒烟；假设清单入能力矩阵；退化路径为 quarantine（安全方向）；T06 真实环境验收取证 |
| m1 plan 缺 SQL 无归属预查 | **接受风险** | 无属性孤儿块无身份不可认领；重复内容用户可见可删；与 M6 一并标注 |
| m2 条目错误升级整书 | 修复 | 拉取/分页级（门禁）与条目级（跳过+上报）分离（回归测试） |
| m3 账号不一致死胡同 | 修复 | AccountMismatchError 完整指引透出；设置页即时字符集校验（validateSourceSegment） |
| m4 store 校验过浅 | 修复 | 注入字段级 isValid（index/book 两套） |
| m5 笔记本找回单点 | 修复 | 按账号属性全局 SQL 找回 |
| m6 逐块审计开销 | 修复 | 单次全局前缀 SQL 批量审计；SQL 缺失回读确认（索引非唯一证据不变量保持） |
| INFO IAL 出生内嵌 vs §4 步骤3 | **采纳偏离** | IAL 内嵌优于事后 setBlockAttrs（身份原子落地，响应丢失可恢复）；本节记录为准 |
| INFO 重建期同 sourceKey 多块 | 修复 | rebuild 直接置 quarantined，不依赖后续 audit 纠正 |
| INFO 死代码 | 修复 | 空分支删除；oplog 增 create-notebook intent；ItemStatus "unseen" 保留为 plan 语义标签 |

**M6/m1 的 UNVERIFIED-LIVE 假设清单**（真实内核冒烟前，恢复语义按"最坏退化=quarantine 停写"设计）：
1. 内核把创建 markdown 的尾随 IAL 绑定到所建块并写入 blocks.ial；
2. getBlockKramdown 回读正文与渲染文本逐字一致、IAL 位于尾部（stripIal 兼容）；
3. 内核 SQL 对 IAL/转义的行为与 SQLite LIKE+ESCAPE 语义一致；
4. updateBlock 语义（T03 解锁前置）仍完全未验证——T02 零调用。
