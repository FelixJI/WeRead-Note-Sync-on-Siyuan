# T03 中文 diff、冲突决策与受控原位更新设计契约（冻结）

> Task #4。依赖 #3 已合并（PR#9→f364497）。主代理冻结；偏离须回报裁决。
> **更新路径裁决**（承接 T02 UNVERIFIED-LIVE 门禁）：本任务的块更新**只走用户逐条批准**（Goal "运行插件时由用户逐条批准已有正文的替换"）；同步自动路径继续零 updateBlock/deleteBlock。每次更新执行 §3 运行时验证协议；系统化内核取证留 T06。

## 1. 纯函数层（子代理 D）

### src/diff/chars.ts
```ts
export interface DiffOp { type: "equal" | "insert" | "delete"; text: string; }
export function diffChars(a: string, b: string): DiffOp[];   // 中文逐字：公共前后缀修剪 + LCS；相邻同类型 op 合并
export function diffLines(a: string, b: string): DiffOp[];   // 行级（先按行 diff，单行内可再 diffChars 由 UI 决定）
```
- 输入含 CRLF/空串/纯空白/Unicode（含 emoji 组合）均确定；无随机性。

### src/review/model.ts
```ts
export type ConflictKind = "identical" | "remote-only" | "local-only" | "both-changed";
export function classifyConflict(baseline: string, local: string, remote: string): ConflictKind;
// identical: 三者一致；remote-only: local==baseline && remote!=baseline；local-only: remote==baseline && local!=baseline；both-changed: 两者都偏离
export type DecisionAction = "apply-remote" | "keep-local" | "manual-merge" | "save-copy" | "defer";
export interface DecisionRecord { sourceKey: string; action: DecisionAction; decidedAt: string; expectedLocal: string; remoteRendered: string; manualText?: string; }
export function isDecisionStale(record: DecisionRecord, currentLocal: string): boolean; // 当前内容 != 决策时内容 → 过期
export function renderManualMerge(baseline: string, manualText: string): string;        // 手动合并文本的规范化（trim 尾空白）
```
排序/分组辅助：`sortCandidates(list)` 按 (bookTitle, chapterIdx, sourceKey) 稳定排序。

## 2. 候选持久化（T02 引擎增量，主代理）

- `ItemState` 增量字段（model.ts，additive）：
  - `pendingRemote?: { renderedText: string; fingerprint: string; payload: Record<string, unknown>; detectedAt: string; }`
    ——同步轮发现来源变化即写入（含 candidates 上报路径）；决策后清除。
- 各决策语义：
  - **apply-remote**：走 §3 协议更新块 → localBaseline/sourcePayload/versionFingerprint=远端、override=false、清 pendingRemote。
  - **keep-local**：**不写块**；versionFingerprint=pendingRemote.fingerprint（推进已处理版本）、override=true、清 pendingRemote → 下一轮同版本不再打扰（AC3）。
  - **manual-merge**：§3 协议更新为 manualText → 基线三件套=manual 渲染、override=true（本地为权威）、清 pendingRemote。
  - **save-copy**：appendChildBlock 到 docId（远端文本+IAL 仅 `custom-wrs-copy-of="<sourceKey>"`，**不带 custom-wrs-src**——不建第二规范映射）；versionFingerprint=远端、override=true、清 pendingRemote。
  - **defer**：仅 UI 分组留存，状态不变。
- 决策审计：每条决策 append oplog（intent 增 "update-block" | "decision"），update-block 含 before/after 快照引用。

## 3. 受控原位更新协议（主代理，writer 增量）

`updateBlockContent(markdown, blockId)`：dataType=markdown，data 含 IAL（id + custom-wrs-src）以保身份。
应用序（任一步失败=安全停，绝不重试写）：
1. 持久化意图：item.pendingUpdate={opId, before, after} 落 book state + oplog pending；
2. 重读目标：kramdown(stripIal) 必须 === before（不等 → 过期计划，拒绝应用并保留候选，AC4）；
3. updateBlock（唯一用户批准写入口）；
4. 回读验证：getBlockKramdown 新内容 === after 且 **块 ID 不变**（getBlockInfo/sql 以原 blockId 可读）且 custom-wrs-src 仍在（IAL 或 getBlockAttrs 语义由回读 kramdown 判定）；ID 变化/属性丢失 → 立即 quarantine + 保留 before 快照 + 上报（不自动补救写）；
5. 记账推进（同 T02 §4 语义）；中断重入按 pendingUpdate 核对（内容=after → 收养；=before → 清除重议；其他 → quarantine）。

## 4. 审阅 UI（子代理 E）

- 入口：顶栏菜单"审阅变更"+ 命令；打开 Dialog（Svelte 5），标题含待审数。
- 数据：`buildReviewQueue(persistence)`（主代理提供）：遍历 index.books → book state items 中 pendingRemote 非空者 → {bookId, bookTitle, sourceKey, kind, baseline, local(=localBaseline), remote(=pendingRemote.renderedText), conflict: classifyConflict(...)}。
- 展示：每条目 = 三段（基线可折叠展开/本地/远端）+ **行内字符级 diff**（local vs remote，insert/delete 双色+加/减号标记，不只靠红绿辨识，AC5）；宽屏双栏、窄屏（<720px）单栏行内（CSS container/media query）；按书分组+筛选（全部/仅冲突/仅远端变化）；"定位原块"按钮 → 打开思源块（window.open `siyuan://blocks/<id>`）。
- 决策按钮：采用远端/保留本地/手动合并（编辑框）/另存副本/稍后处理。apply/manual/save-copy 经 §3 协议执行并刷新队列；过期计划 → 该条目刷新 diff 不应用（AC4）。
- 无批量"全部采用"（批量动作不扩大用户选择范围，AC5）；远端文本纯文本插值（零 @html）。
- 重启可恢复：决策未落地前状态即持久化（pendingRemote/pendingUpdate），队列重开无损（AC4）。

## 5. 红线
不删除重建锚点；不做 AI/语义合并；不隐式全选覆盖；不承诺零并发（§3 步骤2 即防并发窗口的受控处理）；远端文本零 HTML 执行。
