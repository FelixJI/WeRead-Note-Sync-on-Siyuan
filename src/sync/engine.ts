/**
 * 同步引擎（docs/design/t02-sync-core.md §3/§4/§6）。
 *
 * 核心不变量（任何改动不得破坏）：
 * 1. 只新建，不更新/不删除既有块；来源变化只产生待审候选。
 * 2. 先持久化操作意图（oplog + book state.pendingOp），再写入，回读核对后才推进基线。
 * 3. 响应丢失/中断：按 custom-wrs-src SQL 查证后收养或重试，绝不盲目重建；多块歧义隔离。
 * 4. 分页异常/anomalies 非空 → 整书/整轮跳过，不推进任何基线（T01 移交门禁）。
 * 5. 存在性以块 ID 回读为准，SQL 索引不是唯一证据；状态损坏进保护模式。
 * 6. 每书独立部分成功；unseen 永不删除；本地删除永不复活。
 */
import type { Transport } from "../core/net/transport";
import { createWereadClient } from "../adapters/weread/client";
import { fetchBookmarkList, listAllReviewsRaw } from "../adapters/weread/bookmarks";
import { SiyuanWriter, type KernelCallFn } from "../adapters/siyuan/writer";
import { GenerationStore, StateCorruptionError, type StatePersistence } from "./state/store";
import {
    fingerprintPayload,
    normalizeHighlight,
    normalizeReview,
    type BookSourceDetail,
    type BookSyncState,
    type ItemState,
    type NormalizedHighlight,
    type NormalizedReview,
    type SyncIndex,
} from "./model";
import {
    renderChapterHeading,
    renderReviewSectionHeading,
    renderHighlightsSectionHeading,
    sanitizeDocTitle,
} from "./kramdown";
import { computePlan, type SyncPlan } from "./plan";
import { OpLog, type OpLogEntry } from "./oplog";
import { makeSourceKey, type SourceKind } from "./identity";

export interface SyncEngineDeps {
    persistence: StatePersistence;
    kernel: KernelCallFn;
    transport: Transport;
    apiKey: string;
    accountNamespace: string;
    /** 注入时钟与 opId 生成，保证测试确定性 */
    now?: () => string;
    newOpId?: () => string;
}

export interface BookSyncOutcome {
    bookId: string;
    title?: string;
    created: number;
    adopted: number;
    quarantined: number;
    candidates: number;
    protectedCount: number;
    skipped: boolean;
    skipReason?: string;
    error?: string;
    candidatesReport: Array<{ sourceKey: string; reason: string }>;
    protectedReport: Array<{ sourceKey: string; reason: string }>;
}

export interface RoundOutcome {
    ok: boolean;
    abortedReason?: string;
    protectionMode?: string;
    books: BookSyncOutcome[];
    candidatesReport: Array<{ bookId: string; sourceKey: string; reason: string }>;
    protectedReport: Array<{ bookId: string; sourceKey: string; reason: string }>;
}

const NOTEBOOK_NAME = "微信读书";
const MAX_BOOKS_PER_ROUND = 5;
const REVIEW_SECTION_TEXT = "📝 想法";

/** 去掉 IAL 尾注后的 kramdown 归一比较（回读核对用）。 */
export function stripIal(kramdown: string): string {
    return kramdown
        .replace(/\s*\{:[^}]*\}\s*$/u, "")
        .trim();
}

function sqlEscape(text: string): string {
    return text.replaceAll("'", "''");
}

export class SyncEngine {
    readonly #deps: SyncEngineDeps;
    readonly #writer: SiyuanWriter;

    constructor(deps: SyncEngineDeps) {
        this.#deps = deps;
        this.#writer = new SiyuanWriter(deps.kernel);
    }

    async syncRound(bookLimit: number = MAX_BOOKS_PER_ROUND): Promise<RoundOutcome> {
        const books: BookSyncOutcome[] = [];
        const indexStore = new GenerationStore<SyncIndex>(this.#deps.persistence, "index");

        let index: SyncIndex;
        try {
            index = await this.#loadOrInitIndex(indexStore);
        } catch (e) {
            if (e instanceof StateCorruptionError) {
                return {
                    ok: false,
                    protectionMode: `index 双世代损坏：${e.message}，本轮停写`,
                    books,
                    candidatesReport: [],
                    protectedReport: [],
                };
            }
            throw e;
        }

        const client = createWereadClient(this.#deps.transport, this.#deps.apiKey);

        // 门禁 4：书目概览分页异常/anomalies → 整轮中止（不推进任何基线）
        let notebooks: Awaited<ReturnType<typeof client.listAllNotebooks>>;
        try {
            notebooks = await client.listAllNotebooks();
        } catch (e) {
            const name = (e as { name?: string }).name;
            if (name === "PaginationAnomalyError") {
                return {
                    ok: false,
                    abortedReason: `书目分页异常，整轮中止：${(e as Error).message}`,
                    books,
                    candidatesReport: [],
                    protectedReport: [],
                };
            }
            if (name === "AuthError" || name === "InvalidWereadApiKeyError") {
                return {
                    ok: false,
                    abortedReason: `鉴权失败，整轮中止：${(e as Error).message}`,
                    books,
                    candidatesReport: [],
                    protectedReport: [],
                };
            }
            throw e;
        }
        if (notebooks.anomalies.length > 0) {
            return {
                ok: false,
                abortedReason: `书目概览 anomalies 非空（${notebooks.anomalies.length} 条），整轮中止`,
                books,
                candidatesReport: [],
                protectedReport: [],
            };
        }

        const oplog = await this.#loadOpLog();
        const round = this.#nextRound(index);
        index = await this.#ensureNotebook(index, indexStore, oplog);

        let processed = 0;
        let ok = true;
        for (const entry of notebooks.books) {
            if (processed >= bookLimit) {
                break;
            }
            let bookOutcome: BookSyncOutcome;
            try {
                bookOutcome = await this.#syncBook(
                    index,
                    indexStore,
                    oplog,
                    entry.bookId,
                    entry.title ?? entry.bookId,
                    round,
                );
            } catch (e) {
                // 书级异常隔离：一本书失败不影响其他书（部分成功语义）
                bookOutcome = {
                    bookId: entry.bookId,
                    title: entry.title,
                    created: 0,
                    adopted: 0,
                    quarantined: 0,
                    candidates: 0,
                    protectedCount: 0,
                    skipped: false,
                    candidatesReport: [],
                    protectedReport: [],
                    error: `本书意外失败：${(e as Error).message}`,
                };
            }
            books.push(bookOutcome);
            processed += 1;
            if (bookOutcome.error !== undefined) {
                ok = false;
            }
        }

        const candidatesReport: RoundOutcome["candidatesReport"] = [];
        const protectedReport: RoundOutcome["protectedReport"] = [];
        for (const b of books) {
            for (const r of b.candidatesReport) {
                candidatesReport.push({ bookId: b.bookId, ...r });
            }
            for (const r of b.protectedReport) {
                protectedReport.push({ bookId: b.bookId, ...r });
            }
        }
        return { ok, books, candidatesReport, protectedReport };
    }

    // ---------- 索引 ----------

    async #loadOrInitIndex(indexStore: GenerationStore<SyncIndex>): Promise<SyncIndex> {
        const existing = await indexStore.load();
        if (existing !== undefined) {
            if (existing.accountNamespace !== this.#deps.accountNamespace) {
                throw new Error(
                    `账号标识与既有状态不一致（现存 "${existing.accountNamespace}"，当前 "${this.#deps.accountNamespace}"）；换账号须显式迁移，不自动混入`,
                );
            }
            return existing;
        }
        // 首次或索引丢失：从块属性重建（AC4），否则全新
        const rebuilt = await this.#rebuildIndexFromBlocks();
        const fresh = rebuilt ?? {
            schemaVersion: 1 as const,
            accountNamespace: this.#deps.accountNamespace,
            books: {},
        };
        await indexStore.save(fresh);
        return fresh;
    }

    async #rebuildIndexFromBlocks(): Promise<SyncIndex | undefined> {
        const ns = sqlEscape(this.#deps.accountNamespace);
        const docs = await this.#writer.sql(
            `select id, box, content from blocks where type='d' and ial like '%custom-wrs-account="${ns}"%'`,
        );
        if (docs.length === 0) {
            return undefined;
        }
        const books: SyncIndex["books"] = {};
        let notebookId: string | undefined;
        for (const doc of docs) {
            const bookId = this.#extractIalAttr(doc.ial ?? "", "custom-wrs-book-id");
            if (bookId === undefined || doc.box === undefined) {
                continue;
            }
            books[bookId] = { docId: doc.id, title: doc.content, generation: 1 };
            if (notebookId === undefined) {
                notebookId = doc.box;
            }
        }
        return { schemaVersion: 1, accountNamespace: this.#deps.accountNamespace, notebookId, books };
    }

    #extractIalAttr(ial: string, name: string): string | undefined {
        const m = ial.match(new RegExp(`${name}="([^"]*)"`));
        return m !== null ? m[1] : undefined;
    }

    #nextRound(index: SyncIndex): number {
        const gens = Object.values(index.books).map((b) => b.generation);
        return gens.length === 0 ? 1 : Math.max(...gens) + 1;
    }

    async #ensureNotebook(
        index: SyncIndex,
        indexStore: GenerationStore<SyncIndex>,
        oplog: OpLog,
    ): Promise<SyncIndex> {
        if (index.notebookId !== undefined) {
            const notebooks = await this.#writer.listNotebooks();
            if (notebooks.some((nb) => nb.id === index.notebookId)) {
                return index;
            }
            // 笔记本 ID 失效：按既有书籍文档的 box 找回（不重复建）
            const anyDocId = Object.values(index.books).find((b) => b.docId !== undefined)?.docId;
            if (anyDocId !== undefined) {
                const rows = await this.#writer.sql(
                    `select box from blocks where id='${anyDocId}'`,
                );
                const box = rows[0]?.box;
                if (box !== undefined && box.length > 0) {
                    const next = { ...index, notebookId: box };
                    await indexStore.save(next);
                    return next;
                }
            }
        }
        const opId = this.#opId();
        await oplog.append({ opId, ts: this.#now(), intent: "create-doc", status: "pending" });
        const notebookId = await this.#writer.createNotebook(NOTEBOOK_NAME);
        await oplog.complete(opId, {});
        const next = { ...index, notebookId };
        await indexStore.save(next);
        return next;
    }

    // ---------- 单书同步 ----------

    async #syncBook(
        index: SyncIndex,
        indexStore: GenerationStore<SyncIndex>,
        oplog: OpLog,
        bookId: string,
        title: string,
        round: number,
    ): Promise<BookSyncOutcome> {
        const store = new GenerationStore<BookSyncState>(this.#deps.persistence, `book-${bookId}`);
        const outcome: BookSyncOutcome = {
            bookId,
            title,
            created: 0,
            adopted: 0,
            quarantined: 0,
            candidates: 0,
            protectedCount: 0,
            skipped: false,
            candidatesReport: [],
            protectedReport: [],
        };

        let state: BookSyncState | undefined;
        try {
            state = await store.load();
        } catch (e) {
            if (e instanceof StateCorruptionError) {
                return {
                    ...outcome,
                    skipped: true,
                    skipReason: `状态双世代损坏，保护模式停写：${e.message}`,
                    error: e.message,
                };
            }
            throw e;
        }
        if (state !== undefined && state.bookId !== bookId) {
            // 存储名与内容不符：视为状态不可信，重建路径
            state = undefined;
        }
        if (state === undefined) {
            state = await this.#rebuildOrInitBookState(store, bookId, title, index);
        }

        // ---- 恢复：pendingOp 核对（AC3/AC4）----
        const recovery = await this.#reconcilePendingOp(store, state, oplog);
        state = recovery.state;
        outcome.adopted += recovery.adopted;
        outcome.quarantined += recovery.quarantined;

        // ---- 块体检：存在性 / moved-out / 本地漂移 / 属性歧义（AC2/AC4/AC5）----
        const audit = await this.#auditBlocks(store, state, bookId);
        state = audit.state;
        outcome.quarantined += audit.quarantined;
        for (const p of audit.protected) {
            outcome.protectedReport.push(p);
            outcome.protectedCount += 1;
        }

        // ---- 来源明细拉取（任一失败 → 本书跳过、状态不推进）----
        let detail: BookSourceDetail;
        try {
            detail = await this.#fetchDetail(bookId);
        } catch (e) {
            return {
                ...outcome,
                error: `来源拉取失败，本书跳过（状态未推进）：${(e as Error).message}`,
            };
        }

        // ---- 计划 ----
        const plan = computePlan({
            state,
            detail,
            round,
            accountNamespace: this.#deps.accountNamespace,
        });
        for (const c of plan.candidates) {
            outcome.candidatesReport.push({ sourceKey: c.sourceKey, reason: "source-changed" });
            outcome.candidates += 1;
        }
        for (const p of plan.protected) {
            outcome.protectedReport.push({ sourceKey: p.sourceKey, reason: p.reason });
            outcome.protectedCount += 1;
        }
        if (plan.skipped) {
            return { ...outcome, skipped: true, skipReason: plan.skipReason };
        }
        if (plan.creates.length === 0 && !plan.candidates.length && !plan.protected.length) {
            // 无动作也要推进 seen 与世代（幂等轮）
        }

        // ---- 文档确保（含丢失找回）----
        const docEnsured = await this.#ensureDoc(index, indexStore, oplog, store, state, bookId, title);
        state = docEnsured.state;
        if (state.docId === undefined) {
            return { ...outcome, error: "无法确定书籍文档（找回歧义或创建失败），本书跳过" };
        }
        const docId = state.docId;

        // ---- 逐条新建：先 highlight 后 review（挂靠依赖），§4 状态机 ----
        const ordered = [
            ...plan.creates.filter((c) => c.kind === "highlight"),
            ...plan.creates.filter((c) => c.kind === "review"),
        ];
        for (const create of ordered) {
            const done = await this.#executeCreate(store, state, oplog, create, docId, bookId);
            if (done.error !== undefined) {
                return { ...outcome, error: `创建中断（下轮可恢复）：${done.error}` };
            }
            state = done.state;
            outcome.created += 1;
        }

        // ---- seen 回写与世代推进 ----
        const seenKeys = new Set<string>([
            ...detail.highlights.map((h) => this.#sourceKey(bookId, "highlight", h.bookmarkId)),
            ...detail.reviews.map((r) => this.#sourceKey(bookId, "review", r.reviewId)),
        ]);
        for (const [key, item] of Object.entries(state.items)) {
            if (seenKeys.has(key) && item.status === "active") {
                item.lastSeenRound = round;
            }
        }
        state.generation = round;
        await store.save(state);
        const nextIndex: SyncIndex = {
            ...index,
            books: { ...index.books, [bookId]: { docId, title, generation: round } },
        };
        await indexStore.save(nextIndex);
        return outcome;
    }

    async #fetchDetail(bookId: string): Promise<BookSourceDetail> {
        const anomalies: string[] = [];
        const bm = await fetchBookmarkList(this.#deps.transport, this.#deps.apiKey, bookId);
        anomalies.push(...bm.anomalies);
        const highlights: NormalizedHighlight[] = [];
        for (const raw of bm.rawItems) {
            const n = normalizeHighlight(raw, bm.chapters);
            if (n.ok) {
                highlights.push(n.value);
            } else {
                anomalies.push(n.error);
            }
        }
        const rv = await listAllReviewsRaw(this.#deps.transport, this.#deps.apiKey, bookId);
        anomalies.push(...rv.anomalies);
        const reviews: NormalizedReview[] = [];
        for (const raw of rv.raws) {
            const n = normalizeReview(raw);
            if (n.ok) {
                reviews.push(n.value);
            } else {
                anomalies.push(n.error);
            }
        }
        const complete = bm.complete && anomalies.length === 0;
        return { bookId, highlights, reviews, anomalies, complete };
    }

    // ---------- 恢复 ----------

    async #reconcilePendingOp(
        store: GenerationStore<BookSyncState>,
        state: BookSyncState,
        oplog: OpLog,
    ): Promise<{ state: BookSyncState; adopted: number; quarantined: number }> {
        const pending = state.pendingOp;
        if (pending === undefined) {
            return { state, adopted: 0, quarantined: 0 };
        }
        const blocks = await this.#writer.findBlocksBySourceKey(pending.sourceKey);
        if (blocks.length === 0) {
            // 未落地：清除意图（oplog 记失败），由本轮 plan 自然重建——先查证，不盲目重试
            await oplog.fail(pending.opId, "中断于落块前，已清除意图，本轮重新计划");
            const next = { ...state, pendingOp: undefined };
            await store.save(next);
            return { state: next, adopted: 0, quarantined: 0 };
        }
        if (blocks.length > 1) {
            const next = this.#withItem(state, pending.sourceKey, (item) => {
                item.status = "quarantined";
                item.blockId = blocks[0]?.id;
            });
            next.pendingOp = undefined;
            await store.save(next);
            await oplog.append({
                opId: this.#opId(),
                ts: this.#now(),
                intent: "quarantine",
                sourceKey: pending.sourceKey,
                status: "done",
                error: "恢复期发现同 sourceKey 多块，隔离待人工裁决",
            });
            return { state: next, adopted: 0, quarantined: 1 };
        }
        // 单块：回读核对内容（存在性以块回读为准，不以 SQL 为准）
        const block = blocks[0];
        const kramdown = await this.#writer.getBlockKramdown(block.id);
        if (kramdown === undefined || stripIal(kramdown) !== pending.payloadText.trim()) {
            const next = this.#withItem(state, pending.sourceKey, (item) => {
                item.status = "quarantined";
                item.blockId = block.id;
            });
            next.pendingOp = undefined;
            await store.save(next);
            await oplog.fail(pending.opId, "恢复期单块内容与意图不符，隔离待人工裁决");
            return { state: next, adopted: 0, quarantined: 1 };
        }
        // 收养：内容已核对，补记账并推进基线
        const kind = this.#kindOf(pending.sourceKey);
        const item: ItemState = {
            kind,
            sourcePayload: {},
            renderedText: pending.payloadText,
            localBaseline: stripIal(kramdown),
            versionFingerprint: "adopted",
            status: "active",
            override: false,
            lastSeenRound: state.generation,
            blockId: block.id,
        };
        const next: BookSyncState = {
            ...state,
            items: { ...state.items, [pending.sourceKey]: item },
            pendingOp: undefined,
        };
        await store.save(next);
        await oplog.append({
            opId: this.#opId(),
            ts: this.#now(),
            intent: "adopt",
            sourceKey: pending.sourceKey,
            blockId: block.id,
            status: "done",
        });
        return { state: next, adopted: 1, quarantined: 0 };
    }

    // ---------- 块体检 ----------

    async #auditBlocks(
        store: GenerationStore<BookSyncState>,
        state: BookSyncState,
        bookId: string,
    ): Promise<{
        state: BookSyncState;
        quarantined: number;
        protected: Array<{ sourceKey: string; reason: string }>;
    }> {
        const protectedList: Array<{ sourceKey: string; reason: string }> = [];
        let quarantined = 0;
        let changed = false;

        for (const [key, item] of Object.entries(state.items)) {
            if (item.status !== "active" || item.blockId === undefined) {
                continue;
            }
            const kramdown = await this.#writer.getBlockKramdown(item.blockId);
            if (kramdown === undefined) {
                // 本地删除：永不复活（AC5）
                item.status = "user-deleted";
                changed = true;
                protectedList.push({ sourceKey: key, reason: "user-deleted" });
                continue;
            }
            if (state.docId !== undefined) {
                const info = await this.#writer.getBlockInfo(item.blockId);
                if (info?.rootId !== undefined && info.rootId !== state.docId) {
                    // 移出管理范围：暂停写入，不补建（AC2）
                    item.status = "moved-out";
                    changed = true;
                    protectedList.push({ sourceKey: key, reason: "moved-out" });
                    continue;
                }
            }
            // 本地基线漂移 → override 标记（不覆盖、不更新，报告上层；T03 处理）
            if (item.localBaseline !== undefined && stripIal(kramdown) !== item.localBaseline) {
                item.override = true;
                changed = true;
                protectedList.push({ sourceKey: key, reason: "local-modified" });
            }
        }

        // 属性歧义扫描（AC4：复制属性 → 隔离，禁止任选接管）
        const ns = sqlEscape(this.#deps.accountNamespace);
        const bid = sqlEscape(bookId);
        const blocks = await this.#writer.sql(
            `select id, ial from blocks where ial like '%custom-wrs-src="${ns}/${bid}/%' and type != 'd'`,
        );
        const byKey = new Map<string, string[]>();
        for (const b of blocks) {
            const src = this.#extractIalAttr(b.ial ?? "", "custom-wrs-src");
            if (src === undefined) {
                continue;
            }
            const list = byKey.get(src) ?? [];
            list.push(b.id);
            byKey.set(src, list);
        }
        for (const [src, ids] of byKey) {
            if (ids.length > 1) {
                const item = state.items[src];
                if (item !== undefined && item.status === "active") {
                    item.status = "quarantined";
                    item.blockId = ids[0];
                    changed = true;
                    quarantined += 1;
                    protectedList.push({ sourceKey: src, reason: "ambiguous-attrs" });
                }
            }
        }

        if (changed) {
            await store.save(state);
        }
        return { state, quarantined, protected: protectedList };
    }

    // ---------- 文档 ----------

    async #ensureDoc(
        index: SyncIndex,
        indexStore: GenerationStore<SyncIndex>,
        oplog: OpLog,
        store: GenerationStore<BookSyncState>,
        state: BookSyncState,
        bookId: string,
        title: string,
    ): Promise<{ state: BookSyncState }> {
        if (state.docId !== undefined) {
            const kramdown = await this.#writer.getBlockKramdown(state.docId);
            if (kramdown !== undefined) {
                return { state };
            }
            // 文档 ID 失效：按属性找回（不盲目重建）
        }
        const ns = sqlEscape(this.#deps.accountNamespace);
        const docs = await this.#writer.sql(
            `select id from blocks where type='d' and ial like '%custom-wrs-book-id="${sqlEscape(bookId)}"%' and ial like '%custom-wrs-account="${ns}"%'`,
        );
        if (docs.length === 1) {
            const next = { ...state, docId: docs[0].id };
            await store.save(next);
            return { state: next };
        }
        if (docs.length > 1) {
            return { state }; // 歧义：不选边，交上层报错
        }
        // 文档创建窗口兜底：属性未落的同名孤儿文档（创建后、setBlockAttrs 前中断）按标题找回。
        // 必须排除任何已绑定 custom-wrs-book-id 的文档——同名书按 bookId 区分，不得误认领。
        if (index.notebookId !== undefined) {
            const sanitized = sanitizeDocTitle(title, bookId);
            const byTitle = await this.#writer.sql(
                `select id, box from blocks where type='d' and content='${sqlEscape(sanitized)}' and box='${sqlEscape(index.notebookId)}' and ial not like '%custom-wrs-book-id=%'`,
            );
            if (byTitle.length === 1) {
                const adoptedId = byTitle[0].id;
                await this.#writer.setBlockAttrs(adoptedId, {
                    "custom-wrs-book-id": bookId,
                    "custom-wrs-account": this.#deps.accountNamespace,
                });
                const next = { ...state, docId: adoptedId };
                await store.save(next);
                return { state: next };
            }
            if (byTitle.length > 1) {
                return { state }; // 同名歧义：不选边
            }
        }
        const opId = this.#opId();
        await oplog.append({ opId, ts: this.#now(), intent: "create-doc", status: "pending" });
        const docId = await this.#writer.createBookDoc(
            index.notebookId ?? "",
            sanitizeDocTitle(title, bookId),
        );
        await this.#writer.setBlockAttrs(docId, {
            "custom-wrs-book-id": bookId,
            "custom-wrs-account": this.#deps.accountNamespace,
        });
        // 文档骨架：摘录区标题（想法区按需懒建）
        await this.#writer.appendChildBlock(renderHighlightsSectionHeading(), docId);
        await oplog.complete(opId, {});
        const next = { ...state, docId };
        await store.save(next);
        const nextIndex: SyncIndex = {
            ...index,
            books: { ...index.books, [bookId]: { docId, title, generation: state.generation } },
        };
        await indexStore.save(nextIndex);
        return { state: next };
    }

    // ---------- 新建（§4 状态机）----------

    async #executeCreate(
        store: GenerationStore<BookSyncState>,
        state: BookSyncState,
        oplog: OpLog,
        create: SyncPlan["creates"][number],
        docId: string,
        bookId: string,
    ): Promise<{ state: BookSyncState; error?: string }> {
        const payloadText = create.renderedText;

        // 步骤 1：意图先行持久化（AC3 第一切断点）
        const opId = this.#opId();
        const pending: BookSyncState = {
            ...state,
            pendingOp: { opId, sourceKey: create.sourceKey, payloadText, startedAt: this.#now() },
        };
        await store.save(pending);
        await oplog.append({
            opId,
            ts: this.#now(),
            intent: "create-block",
            sourceKey: create.sourceKey,
            payloadText,
            status: "pending",
        });

        try {
            let anchorId: string | undefined;
            if (create.kind === "highlight" && create.chapter !== undefined) {
                // 章节标题去重：同文档同内容标题已存在则不重复插入（blocks.content 为纯文本）
                const docSql = sqlEscape(docId);
                const headingSql = sqlEscape(create.chapter.title);
                const existing = await this.#writer.sql(
                    `select id from blocks where root_id='${docSql}' and type='h' and content='${headingSql}'`,
                );
                if (existing.length === 0) {
                    anchorId = await this.#writer.appendChildBlock(
                        renderChapterHeading(create.chapter.title),
                        docId,
                    );
                }
            }
            if (create.kind === "review" && create.matchedHighlightBlockHint === undefined) {
                // 独立想法：懒建"想法"区标题
                const docSql = sqlEscape(docId);
                const existing = await this.#writer.sql(
                    `select id from blocks where root_id='${docSql}' and type='h' and content='${sqlEscape(REVIEW_SECTION_TEXT)}'`,
                );
                if (existing.length === 0) {
                    await this.#writer.appendChildBlock(renderReviewSectionHeading(), docId);
                }
            }

            // 块出生即带身份属性（IAL 内嵌创建 markdown）：
            // 这是"写入成功但响应丢失"可恢复的前提——无属性的无名块无法被 SQL 认领，必然重复创建
            const finalMarkdown = `${payloadText} {: custom-wrs-src="${create.sourceKey}"}`;

            // 步骤 2：创建块（review 挂靠须父块已存在——两段排序保证）
            let blockId: string;
            if (create.kind === "review" && create.matchedHighlightBlockHint !== undefined) {
                const parentKey = this.#sourceKey(bookId, "highlight", create.matchedHighlightBlockHint);
                const parentBlock = state.items[parentKey]?.blockId ?? pending.items[parentKey]?.blockId;
                if (parentBlock === undefined) {
                    return { state: pending, error: `挂靠父块不存在：${parentKey}` };
                }
                blockId = await this.#writer.appendChildBlock(finalMarkdown, parentBlock);
            } else if (anchorId !== undefined) {
                blockId = await this.#writer.insertBlockAfter(finalMarkdown, anchorId);
            } else {
                blockId = await this.#writer.appendChildBlock(finalMarkdown, docId);
            }

            // 步骤 3：回读核对（存在性以块回读为准；响应丢失由 IAL+SQL 查证恢复）
            const kramdown = await this.#writer.getBlockKramdown(blockId);
            if (kramdown === undefined) {
                return { state: pending, error: `回读失败 blockId=${blockId}` };
            }

            // 步骤 4：记账 + 推进基线（记账前中断由重入 reconcile 收养，不重复创建）
            const item: ItemState = {
                kind: create.kind,
                sourcePayload: create.payload,
                renderedText: payloadText,
                localBaseline: stripIal(kramdown),
                versionFingerprint: fingerprintPayload(create.payload),
                status: "active",
                override: false,
                lastSeenRound: state.generation + 1,
                blockId,
            };
            const next: BookSyncState = {
                ...pending,
                items: { ...pending.items, [create.sourceKey]: item },
                pendingOp: undefined,
            };
            await store.save(next);
            await oplog.complete(opId, { blockId });
            return { state: next };
        } catch (e) {
            await oplog.fail(opId, (e as Error).message);
            return { state: pending, error: (e as Error).message };
        }
    }

    // ---------- 重建 ----------

    async #rebuildOrInitBookState(
        store: GenerationStore<BookSyncState>,
        bookId: string,
        title: string,
        index: SyncIndex,
    ): Promise<BookSyncState> {
        // 基线丢失：从块属性重建身份映射；指纹置 unknown → 后续轮来源比对只产生候选，绝不覆盖、不重复导入
        const ns = sqlEscape(this.#deps.accountNamespace);
        const bid = sqlEscape(bookId);
        const blocks = await this.#writer.sql(
            `select id, ial, markdown from blocks where ial like '%custom-wrs-src="${ns}/${bid}/%'`,
        );
        const items: Record<string, ItemState> = {};
        for (const b of blocks) {
            const src = this.#extractIalAttr(b.ial ?? "", "custom-wrs-src");
            if (src === undefined || items[src] !== undefined) {
                continue;
            }
            items[src] = {
                kind: this.#kindOf(src),
                sourcePayload: {},
                renderedText: b.markdown ?? "",
                localBaseline: b.markdown !== undefined ? stripIal(b.markdown) : undefined,
                versionFingerprint: "rebuilt-unknown",
                status: "active",
                override: false,
                lastSeenRound: 0,
                blockId: b.id,
            };
        }
        const state: BookSyncState = {
            schemaVersion: 1,
            bookId,
            docId: index.books[bookId]?.docId,
            title,
            generation: 1,
            items,
        };
        await store.save(state);
        return state;
    }

    // ---------- 小工具 ----------

    #withItem(state: BookSyncState, key: string, mut: (item: ItemState) => void): BookSyncState {
        const existing: ItemState = state.items[key] ?? {
            kind: this.#kindOf(key),
            sourcePayload: {},
            renderedText: "",
            versionFingerprint: "",
            status: "active",
            override: false,
            lastSeenRound: 0,
        };
        mut(existing);
        return { ...state, items: { ...state.items, [key]: existing } };
    }

    #sourceKey(bookId: string, kind: SourceKind, officialSourceId: string): string {
        return makeSourceKey({
            accountNamespace: this.#deps.accountNamespace,
            bookId,
            kind,
            officialSourceId,
        });
    }

    #kindOf(sourceKey: string): SourceKind {
        return sourceKey.split("/")[2] === "review" ? "review" : "highlight";
    }

    #now(): string {
        return this.#deps.now !== undefined ? this.#deps.now() : new Date().toISOString();
    }

    #opId(): string {
        return this.#deps.newOpId !== undefined
            ? this.#deps.newOpId()
            : `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    async #loadOpLog(): Promise<OpLog> {
        let initial: OpLogEntry[] = [];
        try {
            const raw = await this.#deps.persistence.load("oplog");
            if (Array.isArray(raw)) {
                initial = raw as OpLogEntry[];
            }
        } catch {
            initial = [];
        }
        return new OpLog(async (entries) => {
            await this.#deps.persistence.save("oplog", entries);
        }, initial);
    }
}
