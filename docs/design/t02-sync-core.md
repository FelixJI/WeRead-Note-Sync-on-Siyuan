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
