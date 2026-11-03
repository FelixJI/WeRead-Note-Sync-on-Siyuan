/**
 * 同步引擎（docs/design/t02-sync-core.md §3/§4/§6 + 审阅整改裁决记录）。
 *
 * 核心不变量（任何改动不得破坏）：
 * 1. 只新建，不更新/不删除既有块；来源变化只产生待审候选。
 * 2. 先持久化操作意图（oplog + book state.pendingOp），再写入，回读核对后才推进基线。
 * 3. 响应丢失/中断：按 custom-wrs-src SQL 查证后收养或重试，绝不盲目重建；多块歧义隔离。
 * 4. 拉取/分页级异常 → 整书/整轮跳过，不推进任何基线；条目级归一化错误只跳过该条（整改 m2）。
 * 5. 存在性以块回读为准，SQL 索引不是唯一证据（批量审计中"缺失"须回读确认）；状态损坏进保护模式。
 * 6. 每书独立部分成功；unseen 永不删除；本地删除永不复活。
 * 7. SQL LIKE 值一律经 likeEscape（%/_/\ 通配符转义，escape '\\' 子句）——防跨书/跨账号误匹配（整改 M3）。
 */
import type { Transport } from "../core/net/transport";
import { createWereadClient } from "../adapters/weread/client";
import { fetchBookmarkList, listAllReviewsRaw } from "../adapters/weread/bookmarks";
import { SiyuanWriter, likeEscape, type KernelCallFn } from "../adapters/siyuan/writer";
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
    renderHighlightBlock,
    renderReviewChild,
    sanitizeDocTitle,
} from "./kramdown";
import { computePlan, type SyncPlan } from "./plan";
import { OpLog, type OpLogEntry } from "./oplog";
import { makeSourceKey, parseSourceKey, type SourceKind } from "./identity";
import { classifyConflict, renderManualMerge } from "../review/model";
import { projectOverview, type BookProjectionInfo, type RecentHighlightCandidate } from "../projections/overview";

export interface SyncEngineDeps {
    persistence: StatePersistence;
    kernel: KernelCallFn;
    transport: Transport;
    apiKey: string;
    accountNamespace: string;
    /** 注入时钟与 opId 生成，保证测试确定性 */
    now?: () => string;
    newOpId?: () => string;
    /** T04：轮末总览投影开关（默认开启；测试/特殊场景可关） */
    projectOverview?: boolean;
}

export interface BookSyncOutcome {
    bookId: string;
    title?: string;
    created: number;
    adopted: number;
    quarantined: number;
    candidates: number;
    protectedCount: number;
    /** 条目级归一化错误数（跳过该条，不阻塞整书） */
    itemErrors: number;
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
    /** 本轮因上限未覆盖的书数（轮转游标保证下轮优先，整改 M5） */
    deferredBooks: number;
    /** T04：总览投影失败数（投影失败不影响同步本体结果） */
    projectionErrors?: number;
    /** T04：投影如实上报（歧义跳过/重建/复盘区缺失等） */
    projectionAnomalies?: string[];
    candidatesReport: Array<{ bookId: string; sourceKey: string; reason: string }>;
    protectedReport: Array<{ bookId: string; sourceKey: string; reason: string }>;
}

// ---------- T03：审阅队列与受控决策（设计契约 §2/§3） ----------

export interface ReviewCandidate {
    bookId: string;
    bookTitle: string;
    sourceKey: string;
    kind: SourceKind;
    blockId: string;
    baseline: string;
    local: string;
    remote: string;
    remoteFingerprint: string;
    conflict: "identical" | "remote-only" | "local-only" | "both-changed";
    detectedAt: string;
}

export type ApplyResult =
    | { ok: true }
    | { ok: false; kind: "stale" | "missing" | "kernel" | "not-found"; message: string };

/** 账号标识与既有状态不一致（换账号须显式处理，绝不自动混入）。 */
export class AccountMismatchError extends Error {
    constructor(existing: string, current: string) {
        super(
            `账号标识与既有状态不一致（现存 "${existing}"，当前 "${current}"）。` +
                "若确实更换了微信读书账号，请先处理旧账号的同步数据（如更换账号标识并按新书库重新导入），" +
                "不要直接沿用旧状态混入另一账号的笔记。",
        );
        this.name = "AccountMismatchError";
    }
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

// ---------- 状态结构校验（整改 m4：字段级，防"带 schemaVersion 的坏对象"放行） ----------

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isValidSyncIndex(v: unknown): boolean {
    if (!isPlainObject(v)) {
        return false;
    }
    if (typeof v.accountNamespace !== "string" || v.accountNamespace.length === 0) {
        return false;
    }
    return isPlainObject(v.books);
}

function isValidBookSyncState(v: unknown): boolean {
    if (!isPlainObject(v)) {
        return false;
    }
    if (typeof v.bookId !== "string" || v.bookId.length === 0) {
        return false;
    }
    if (typeof v.title !== "string") {
        return false;
    }
    return isPlainObject(v.items);
}

export class SyncEngine {
    readonly #deps: SyncEngineDeps;
    readonly #writer: SiyuanWriter;

    constructor(deps: SyncEngineDeps) {
        this.#deps = deps;
        this.#writer = new SiyuanWriter(deps.kernel);
    }

    #indexStore(): GenerationStore<SyncIndex> {
        return new GenerationStore<SyncIndex>(this.#deps.persistence, "index", isValidSyncIndex);
    }

    #bookStore(bookId: string): GenerationStore<BookSyncState> {
        return new GenerationStore<BookSyncState>(this.#deps.persistence, `book-${bookId}`, isValidBookSyncState);
    }

    async syncRound(bookLimit: number = MAX_BOOKS_PER_ROUND): Promise<RoundOutcome> {
        const books: BookSyncOutcome[] = [];
        const indexStore = this.#indexStore();

        let index: SyncIndex;
        try {
            index = await this.#loadOrInitIndex(indexStore);
        } catch (e) {
            if (e instanceof StateCorruptionError) {
                return {
                    ok: false,
                    protectionMode: `index 双世代损坏：${e.message}，本轮停写`,
                    books,
                    deferredBooks: 0,
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
                    deferredBooks: 0,
                    candidatesReport: [],
                    protectedReport: [],
                };
            }
            if (name === "AuthError" || name === "InvalidWereadApiKeyError") {
                return {
                    ok: false,
                    abortedReason: `鉴权失败，整轮中止：${(e as Error).message}`,
                    books,
                    deferredBooks: 0,
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
                deferredBooks: 0,
                candidatesReport: [],
                protectedReport: [],
            };
        }

        const oplog = await this.#loadOpLog();
        const round = this.#nextRound(index);
        index = await this.#ensureNotebook(index, oplog);

        // 轮转处理（整改 M5）：从 rotation 游标起，避免固定截断导致后续书永久饥饿
        const total = notebooks.books.length;
        const rotation = ((index.rotation ?? 0) % (total === 0 ? 1 : total) + total) % total;
        const picked: typeof notebooks.books = [];
        for (let i = 0; i < total && picked.length < bookLimit; i += 1) {
            picked.push(notebooks.books[(rotation + i) % total]!);
        }
        const deferredBooks = total - picked.length;

        let ok = true;
        for (const entry of picked) {
            let bookOutcome: BookSyncOutcome;
            try {
                const r = await this.#syncBook(
                    index,
                    oplog,
                    entry.bookId,
                    entry.title ?? entry.bookId,
                    round,
                );
                index = r.index;
                bookOutcome = r.outcome;
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
                    itemErrors: 0,
                    skipped: false,
                    candidatesReport: [],
                    protectedReport: [],
                    error: `本书意外失败：${(e as Error).message}`,
                };
            }
            books.push(bookOutcome);
            if (bookOutcome.error !== undefined) {
                ok = false;
            }
        }

        // T04：轮末总览投影（失败不影响同步本体结果；投影只写带插件属性的块）
        let projectionErrors = 0;
        const projectionAnomalies: string[] = [];
        if (this.#deps.projectOverview !== false && index.notebookId !== undefined && total > 0) {
            try {
                const roundBookIds = new Set(notebooks.books.map((b) => b.bookId));
                const outcomeByBook = new Map(books.map((b) => [b.bookId, b]));
                const booksInfo: BookProjectionInfo[] = [];
                for (const nb of notebooks.books) {
                    const entry = index.books[nb.bookId];
                    const oc = outcomeByBook.get(nb.bookId);
                    if (entry?.docId === undefined) {
                        continue;
                    }
                    booksInfo.push({
                        bookId: nb.bookId,
                        docId: entry.docId,
                        title: nb.title ?? nb.bookId,
                        author: nb.author,
                        progressPercent: nb.readingProgress,
                        finished: nb.markedStatus === 1,
                        unseen: false, // 本轮书目已返回；unseen 由下方补充循环判定
                        syncedThisRound: oc !== undefined && oc.error === undefined && !oc.skipped,
                    });
                }
                // unseen 补充：index 有但本轮书目未返回的书（条目保留标记）
                for (const [bookId, entry] of Object.entries(index.books)) {
                    if (entry?.docId !== undefined && !roundBookIds.has(bookId) && !booksInfo.some((b) => b.bookId === bookId)) {
                        booksInfo.push({
                            bookId,
                            docId: entry.docId,
                            title: entry.title ?? bookId,
                            unseen: true,
                            syncedThisRound: false,
                        });
                    }
                }
                const projection = await projectOverview({
                    writer: this.#writer,
                    oplog,
                    notebookId: index.notebookId,
                    index,
                    books: booksInfo,
                    loadRecentHighlights: () => this.#loadRecentHighlights(index),
                    now: () => this.#now(),
                    newOpId: () => this.#opId(),
                });
                if (projection.overviewDocId !== undefined) {
                    index = { ...index, overviewDocId: projection.overviewDocId };
                }
                projectionAnomalies.push(...projection.anomalies);
                if (projection.error !== undefined) {
                    projectionErrors += 1;
                    projectionAnomalies.push(projection.error);
                }
            } catch (e) {
                projectionErrors += 1;
                projectionAnomalies.push(`投影异常（安全停）：${(e as Error).message}`);
            }
        }

        // 复核随行修复：index 全轮累积后单次持久化（含轮转游标与总览缓存）——
        // 此前书级/轮转各自保存共享陈旧 base，会互相覆盖 books 条目
        const nextRotation = (rotation + picked.length) % (total === 0 ? 1 : total);
        await indexStore.save({ ...index, rotation: nextRotation });

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
        return {
            ok,
            books,
            deferredBooks,
            ...(projectionErrors > 0 ? { projectionErrors } : {}),
            ...(projectionAnomalies.length > 0 ? { projectionAnomalies } : {}),
            candidatesReport,
            protectedReport,
        };
    }

    // ---------- 索引 ----------

    async #loadOrInitIndex(indexStore: GenerationStore<SyncIndex>): Promise<SyncIndex> {
        const existing = await indexStore.load();
        if (existing !== undefined) {
            if (existing.accountNamespace !== this.#deps.accountNamespace) {
                throw new AccountMismatchError(existing.accountNamespace, this.#deps.accountNamespace);
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
        const docs = await this.#writer.sql(
            `select id, box, content from blocks where type='d' and ial like '%custom-wrs-account="${likeEscape(this.#deps.accountNamespace)}"%' escape '\\'`,
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

    /** 笔记本确保；index 由调用方累积后统一持久化（复核随行修复） */
    async #ensureNotebook(index: SyncIndex, oplog: OpLog): Promise<SyncIndex> {
        if (index.notebookId !== undefined) {
            const notebooks = await this.#writer.listNotebooks();
            if (notebooks.some((nb) => nb.id === index.notebookId)) {
                return index;
            }
        }
        // 笔记本 ID 失效：按账号属性全局找回任一书籍文档的 box（整改 m5：不依赖单一 docId）
        const found = await this.#writer.sql(
            `select box from blocks where type='d' and ial like '%custom-wrs-account="${likeEscape(this.#deps.accountNamespace)}"%' escape '\\'`,
        );
        for (const row of found) {
            if (typeof row.box === "string" && row.box.length > 0) {
                return { ...index, notebookId: row.box };
            }
        }
        const opId = this.#opId();
        await oplog.append({ opId, ts: this.#now(), intent: "create-notebook", status: "pending" });
        const notebookId = await this.#writer.createNotebook(NOTEBOOK_NAME);
        await oplog.complete(opId, {});
        return { ...index, notebookId };
    }

    // ---------- 单书同步 ----------

    /** 单书同步；返回书结果与累积后的 index（index 由 syncRound 末次统一持久化） */
    async #syncBook(
        index: SyncIndex,
        oplog: OpLog,
        bookId: string,
        title: string,
        round: number,
    ): Promise<{ outcome: BookSyncOutcome; index: SyncIndex }> {
        const store = this.#bookStore(bookId);
        const outcome: BookSyncOutcome = {
            bookId,
            title,
            created: 0,
            adopted: 0,
            quarantined: 0,
            candidates: 0,
            protectedCount: 0,
            itemErrors: 0,
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
                    outcome: {
                        ...outcome,
                        skipped: true,
                        skipReason: `状态双世代损坏，保护模式停写：${e.message}`,
                        error: e.message,
                    },
                    index,
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

        // ---- T03 恢复：pendingUpdate 核对（§3 重入：after→收养 / before→重议 / 其他→隔离）----
        const updRecovery = await this.#reconcilePendingUpdates(store, state);
        state = updRecovery.state;
        outcome.quarantined += updRecovery.quarantined;

        // ---- 块体检：存在性 / moved-out / 本地漂移 / 属性歧义（AC2/AC4/AC5）----
        const audit = await this.#auditBlocks(store, state, bookId);
        state = audit.state;
        outcome.quarantined += audit.quarantined;
        for (const p of audit.protected) {
            outcome.protectedReport.push(p);
            outcome.protectedCount += 1;
        }

        // ---- 来源明细拉取（拉取级失败 → 本书跳过、状态不推进）----
        let detail: BookSourceDetail;
        try {
            detail = await this.#fetchDetail(bookId);
        } catch (e) {
            return {
                outcome: {
                    ...outcome,
                    error: `来源拉取失败，本书跳过（状态未推进）：${(e as Error).message}`,
                },
                index,
            };
        }
        outcome.itemErrors = detail.itemErrors?.length ?? 0;

        // ---- 计划 ----
        const plan = computePlan({
            state,
            detail,
            round,
            accountNamespace: this.#deps.accountNamespace,
        });
        // 审阅整改：拉取异常整书跳过时零状态变更（含候选清除——异常轮不得动既有 pendingRemote）
        if (!plan.skipped) {
            // T03：候选持久化为 pendingRemote（UI 审阅队列数据源）；本轮未再变化的条目清除旧候选
            const candidateKeys = new Set(plan.candidates.map((c) => c.sourceKey));
            const payloadByKey = new Map<string, { payload: Record<string, unknown>; rendered: string }>();
            for (const h of detail.highlights) {
                payloadByKey.set(this.#sourceKey(bookId, "highlight", h.bookmarkId), { payload: h.raw, rendered: renderHighlightBlock(h.markText) });
            }
            for (const r of detail.reviews) {
                payloadByKey.set(this.#sourceKey(bookId, "review", r.reviewId), { payload: r.raw, rendered: renderReviewChild(r.content) });
            }
            for (const c of plan.candidates) {
                const src = payloadByKey.get(c.sourceKey);
                const item = state.items[c.sourceKey];
                if (src !== undefined && item !== undefined) {
                    item.pendingRemote = {
                        renderedText: src.rendered,
                        fingerprint: c.newFingerprint,
                        payload: src.payload,
                        detectedAt: this.#now(),
                    };
                }
            }
            for (const [key, item] of Object.entries(state.items)) {
                if (!candidateKeys.has(key) && item.pendingRemote !== undefined) {
                    item.pendingRemote = undefined;
                }
            }
        }
        for (const c of plan.candidates) {
            outcome.candidatesReport.push({ sourceKey: c.sourceKey, reason: "source-changed" });
            outcome.candidates += 1;
        }
        for (const p of plan.protected) {
            if (outcome.protectedReport.some((x) => x.sourceKey === p.sourceKey && x.reason === p.reason)) {
                continue;
            }
            outcome.protectedReport.push({ sourceKey: p.sourceKey, reason: p.reason });
            outcome.protectedCount += 1;
        }
        if (plan.skipped) {
            return { outcome: { ...outcome, skipped: true, skipReason: plan.skipReason }, index };
        }
        // 审阅整改 M5：候选检测立即落盘——先于文档确保等任何后续失败路径；
        // 否则失败轮只上报不持久，复发性错误会让候选永远进不了审阅队列（AC4 可恢复性）
        await store.save(state);

        // ---- 文档确保（含丢失找回）----
        const docEnsured = await this.#ensureDoc(index, oplog, store, state, bookId, title);
        state = docEnsured.state;
        index = docEnsured.index;
        if (docEnsured.error !== undefined || state.docId === undefined) {
            return {
                outcome: { ...outcome, error: docEnsured.error ?? "无法确定书籍文档，本书跳过" },
                index,
            };
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
                return {
                    outcome: { ...outcome, error: `创建中断（下轮可恢复）：${done.error}` },
                    index,
                };
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
        return { outcome, index: nextIndex };
    }

    async #fetchDetail(bookId: string): Promise<BookSourceDetail> {
        // 拉取/分页级异常（整书门禁）与条目级归一化错误（只跳过该条）分开收集（整改 m2）
        const anomalies: string[] = [];
        const itemErrors: string[] = [];
        const bm = await fetchBookmarkList(this.#deps.transport, this.#deps.apiKey, bookId);
        anomalies.push(...bm.anomalies);
        const highlights: NormalizedHighlight[] = [];
        for (const raw of bm.rawItems) {
            const n = normalizeHighlight(raw, bm.chapters);
            if (n.ok) {
                highlights.push(n.value);
            } else {
                itemErrors.push(n.error);
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
                itemErrors.push(n.error);
            }
        }
        const complete = bm.complete && anomalies.length === 0;
        return { bookId, highlights, reviews, anomalies, itemErrors, complete };
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

    // ---------- 块体检（整改 m6：批量 SQL，缺失项回读确认） ----------

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

        if (state.docId !== undefined) {
            // 一次全局前缀查询取本书全部条目块（不限 root——moved-out 块的 root 已不在本文档）：
            // id/root_id/markdown/ial。SQL 缺失的条目回读确认（存在性以块回读为准，索引非唯一证据）。
            const rows = await this.#writer.sql(
                `select id, root_id, markdown, ial from blocks where ial like '%custom-wrs-src="${likeEscape(this.#deps.accountNamespace)}/${likeEscape(bookId)}/%' escape '\\' and type != 'd'`,
            );
            const byBlockId = new Map(rows.map((r) => [r.id, r]));
            for (const [key, item] of Object.entries(state.items)) {
                if (item.status !== "active" || item.blockId === undefined) {
                    continue;
                }
                const row = byBlockId.get(item.blockId);
                if (row === undefined) {
                    // SQL 缺失不直接判死（索引可能滞后）：回读确认
                    const kramdown = await this.#writer.getBlockKramdown(item.blockId);
                    if (kramdown === undefined) {
                        // 本地删除：永不复活（AC5）
                        item.status = "user-deleted";
                        changed = true;
                        protectedList.push({ sourceKey: key, reason: "user-deleted" });
                    }
                    // 回读存在：索引滞后，保持 active，不动
                    continue;
                }
                if (row.root_id !== undefined && row.root_id !== state.docId) {
                    // 移出管理范围：暂停写入，不补建（AC2）
                    item.status = "moved-out";
                    changed = true;
                    protectedList.push({ sourceKey: key, reason: "moved-out" });
                    continue;
                }
                // 本地基线漂移 → override 标记（不覆盖、不更新，报告上层；T03 处理）
                if (
                    item.localBaseline !== undefined &&
                    row.markdown !== undefined &&
                    stripIal(row.markdown) !== item.localBaseline
                ) {
                    item.override = true;
                    changed = true;
                    protectedList.push({ sourceKey: key, reason: "local-modified" });
                }
            }
            // 属性歧义（复制属性 → 隔离，禁止任选接管）：同一查询内按 sourceKey 分组
            const bySrc = new Map<string, string[]>();
            for (const r of rows) {
                const src = this.#extractIalAttr(r.ial ?? "", "custom-wrs-src");
                if (src === undefined) {
                    continue;
                }
                const list = bySrc.get(src) ?? [];
                list.push(r.id);
                bySrc.set(src, list);
            }
            for (const [src, ids] of bySrc) {
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
        }

        if (changed) {
            await store.save(state);
        }
        return { state, quarantined, protected: protectedList };
    }

    // ---------- 文档 ----------

    /** 文档确保；index 变更随返回值累积（由 syncRound 末次统一持久化） */
    async #ensureDoc(
        index: SyncIndex,
        oplog: OpLog,
        store: GenerationStore<BookSyncState>,
        state: BookSyncState,
        bookId: string,
        title: string,
    ): Promise<{ state: BookSyncState; index: SyncIndex; error?: string }> {
        if (state.docId !== undefined) {
            const kramdown = await this.#writer.getBlockKramdown(state.docId);
            if (kramdown !== undefined) {
                return { state, index };
            }
            // 文档 ID 失效：按属性找回（不盲目重建）
        }
        const docs = await this.#writer.sql(
            `select id from blocks where type='d' and ial like '%custom-wrs-book-id="${likeEscape(bookId)}"%' escape '\\' and ial like '%custom-wrs-account="${likeEscape(this.#deps.accountNamespace)}"%' escape '\\'`,
        );
        if (docs.length === 1) {
            const next = { ...state, docId: docs[0].id };
            await store.save(next);
            return { state: next, index };
        }
        if (docs.length > 1) {
            return { state, index, error: "发现多份同身份书籍文档（属性歧义），需人工裁决后重试" };
        }
        // 文档创建窗口兜底（整改 M4：仅认领"空且无主"的孤儿文档）：
        // 非空的同名文档视为用户文档冲突——不认领、不新建，交人工处理
        if (index.notebookId !== undefined) {
            const sanitized = sanitizeDocTitle(title, bookId);
            const byTitle = await this.#writer.sql(
                `select id from blocks where type='d' and content='${sqlEscape(sanitized)}' and box='${sqlEscape(index.notebookId)}' and ial not like '%custom-wrs-book-id=%'`,
            );
            if (byTitle.length > 1) {
                return { state, index, error: `存在 ${byTitle.length} 份同名未绑定文档，歧义需人工裁决` };
            }
            if (byTitle.length === 1) {
                const candidateId = byTitle[0].id;
                // 复核随行修复：文档块自身 root_id 即自身 id，必须排除，否则空孤儿恒判"有内容"
                const children = await this.#writer.sql(
                    `select id from blocks where root_id='${sqlEscape(candidateId)}' and id != '${sqlEscape(candidateId)}'`,
                );
                if (children.length > 0) {
                    return {
                        state,
                        index,
                        error: `已存在同名文档《${sanitized}》且含内容，为避免误碰用户文档未自动认领；请人工处理后再同步`,
                    };
                }
                await this.#writer.setBlockAttrs(candidateId, {
                    "custom-wrs-book-id": bookId,
                    "custom-wrs-account": this.#deps.accountNamespace,
                });
                const next = { ...state, docId: candidateId };
                await store.save(next);
                return {
                    state: next,
                    index: {
                        ...index,
                        books: { ...index.books, [bookId]: { docId: candidateId, title, generation: state.generation } },
                    },
                };
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
        return {
            state: next,
            index: {
                ...index,
                books: { ...index.books, [bookId]: { docId, title, generation: state.generation } },
            },
        };
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
                const existing = await this.#writer.sql(
                    `select id from blocks where root_id='${sqlEscape(docId)}' and type='h' and content='${sqlEscape(create.chapter.title)}'`,
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
                const existing = await this.#writer.sql(
                    `select id from blocks where root_id='${sqlEscape(docId)}' and type='h' and content='${sqlEscape(REVIEW_SECTION_TEXT)}'`,
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
        const blocks = await this.#writer.sql(
            `select id, ial, markdown from blocks where ial like '%custom-wrs-src="${likeEscape(this.#deps.accountNamespace)}/${likeEscape(bookId)}/%' escape '\\'`,
        );
        const items: Record<string, ItemState> = {};
        for (const b of blocks) {
            const src = this.#extractIalAttr(b.ial ?? "", "custom-wrs-src");
            if (src === undefined) {
                continue;
            }
            const existing = items[src];
            if (existing !== undefined) {
                // 重建期同 sourceKey 多块：直接隔离，不"任选一个"（整改 INFO）
                existing.status = "quarantined";
                continue;
            }
            items[src] = {
                kind: this.#kindOf(src),
                sourcePayload: {},
                renderedText: b.markdown !== undefined ? stripIal(b.markdown) : "",
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

    // ---------- T03：审阅队列与受控决策 ----------

    /** 审阅队列：全量扫描各书状态中的 pendingRemote（local 为当前块实况回读）。 */
    async buildReviewQueue(): Promise<ReviewCandidate[]> {
        const index = await this.#indexStore().load();
        if (index === undefined) {
            return [];
        }
        const queue: ReviewCandidate[] = [];
        for (const [bookId, entry] of Object.entries(index.books)) {
            const store = this.#bookStore(bookId);
            let state: BookSyncState | undefined;
            try {
                state = await store.load();
            } catch {
                continue; // 单书损坏不阻塞整个队列
            }
            if (state === undefined) {
                continue;
            }
            for (const [sourceKey, item] of Object.entries(state.items)) {
                if (item.pendingRemote === undefined || item.blockId === undefined || item.status !== "active") {
                    continue; // 审阅整改 M4：非 active（隔离/已删/移出）不入审阅队列
                }
                const kramdown = await this.#writer.getBlockKramdown(item.blockId);
                const local = kramdown !== undefined ? stripIal(kramdown) : item.localBaseline ?? "";
                const baseline = item.localBaseline ?? "";
                const conflict = classifyConflict(baseline, local, item.pendingRemote.renderedText);
                queue.push({
                    bookId,
                    bookTitle: entry.title ?? bookId,
                    sourceKey,
                    kind: item.kind,
                    blockId: item.blockId,
                    baseline,
                    local,
                    remote: item.pendingRemote.renderedText,
                    remoteFingerprint: item.pendingRemote.fingerprint,
                    conflict,
                    detectedAt: item.pendingRemote.detectedAt,
                });
            }
        }
        return queue;
    }

    /**
     * 执行用户决策（唯一块更新写入口，设计契约 §2/§3）。
     * expectedLocal 为决策时快照（队列会话缓存），与现状不符 → 过期拒绝（AC4）；
     * expectedFingerprint 为决策时远端版本（会话缓存），不一致同样过期重审（整改 INFO9）。
     */
    async applyDecision(
        sourceKey: string,
        action: "apply-remote" | "keep-local" | "manual-merge" | "save-copy" | "defer",
        manualText: string | undefined,
        expectedLocal: string,
        expectedFingerprint?: string,
    ): Promise<ApplyResult> {
        const ref = parseSourceKey(sourceKey);
        const store = this.#bookStore(ref.bookId);
        const state = await store.load();
        if (state === undefined) {
            return { ok: false, kind: "not-found", message: "未找到该书同步状态" };
        }
        const item = state.items[sourceKey];
        if (item === undefined || item.pendingRemote === undefined || item.blockId === undefined) {
            return { ok: false, kind: "not-found", message: "该条目没有待审变更" };
        }
        if (
            expectedFingerprint !== undefined &&
            item.pendingRemote.fingerprint !== expectedFingerprint
        ) {
            // 审阅整改 INFO9：会话期内远端刷新（又同步过）→ 过期重审，不静默应用最新版
            return {
                ok: false,
                kind: "stale",
                message: "远端内容已更新（期间发生过同步），请重新审阅最新版本",
            };
        }
        if (item.status !== "active") {
            // 审阅整改 M4：隔离/已删/移出条目禁止经决策路径写入（防绕过多块歧义保护）
            return {
                ok: false,
                kind: "not-found",
                message: `该条目处于 ${item.status} 状态，不可自动应用决策；请先处理该状态`,
            };
        }
        const oplog = await this.#loadOpLog();
        if (action === "defer") {
            return { ok: true };
        }
        if (action === "keep-local") {
            // 不写块：推进已处理远端版本 + 本地为权威 → 同一远端版本不再打扰（AC3）
            item.versionFingerprint = item.pendingRemote.fingerprint;
            item.override = true;
            item.pendingRemote = undefined;
            await store.save(state);
            await oplog.append({
                opId: this.#opId(),
                ts: this.#now(),
                intent: "decision",
                sourceKey,
                status: "done",
                error: "keep-local",
            });
            return { ok: true };
        }
        if (action === "save-copy") {
            if (state.docId === undefined) {
                return { ok: false, kind: "not-found", message: "书籍文档未确定，无法另存副本" };
            }
            // 副本带 custom-wrs-copy-of 溯源属性，不带 custom-wrs-src——不建第二规范映射
            const copyMarkdown = `${item.pendingRemote.renderedText} {: custom-wrs-copy-of="${sourceKey}"}`;
            const opId = this.#opId();
            await oplog.append({ opId, ts: this.#now(), intent: "create-block", sourceKey, payloadText: copyMarkdown, status: "pending" });
            try {
                const copyId = await this.#writer.appendChildBlock(copyMarkdown, state.docId);
                const readback = await this.#writer.getBlockKramdown(copyId);
                if (readback === undefined) {
                    await oplog.fail(opId, "副本回读失败");
                    return { ok: false, kind: "kernel", message: "副本写入后回读失败" };
                }
                await oplog.complete(opId, { blockId: copyId });
                item.versionFingerprint = item.pendingRemote.fingerprint;
                item.override = true;
                item.pendingRemote = undefined;
                await store.save(state);
                return { ok: true };
            } catch (e) {
                await oplog.fail(opId, (e as Error).message);
                return { ok: false, kind: "kernel", message: `副本写入失败：${(e as Error).message}` };
            }
        }
        // apply-remote / manual-merge → §3 受控原位更新。
        // manual-merge 裁决（审阅整改 B1）：manualText 即最终 markdown（UI 预填远端渲染文本），
        // 仅 trim 规范化、不做二次渲染——"预填→确认"幂等，用户对合并结果有完全控制权
        const newRendered =
            action === "apply-remote"
                ? item.pendingRemote.renderedText
                : renderManualMerge(item.localBaseline ?? "", manualText ?? "");
        // 基线推进统一以"已处理的远端版本"为准（manual-merge 亦是审阅了该远端版本的结果），
        // 否则手动合并的指纹永不匹配来源 → 永续候选
        const remoteFingerprint = item.pendingRemote.fingerprint;
        const remotePayload = item.pendingRemote.payload;
        const overrideAfter = action === "manual-merge";
        return this.#applyControlledUpdate(store, state, oplog, sourceKey, item, expectedLocal, newRendered, remotePayload, remoteFingerprint, overrideAfter);
    }

    /** §3 协议：快照校验 → 意图持久化 → updateBlock → 回读验证 ID/属性 → 记账。任一步失败安全停。 */
    async #applyControlledUpdate(
        store: GenerationStore<BookSyncState>,
        state: BookSyncState,
        oplog: OpLog,
        sourceKey: string,
        item: ItemState,
        expectedLocal: string,
        newRendered: string,
        remotePayload: Record<string, unknown>,
        remoteFingerprint: string,
        overrideAfter: boolean,
    ): Promise<ApplyResult> {
        const blockId = item.blockId!;
        // 步骤 2 前置重读：现状必须等于决策时快照（过期计划拒绝，AC4）
        const current = await this.#writer.getBlockKramdown(blockId);
        if (current === undefined) {
            return { ok: false, kind: "missing", message: "目标块不存在（可能已被删除）" };
        }
        const currentStripped = stripIal(current);
        if (currentStripped.trim() !== expectedLocal.trim()) {
            return { ok: false, kind: "stale", message: "内容已在决策后发生变化，计划过期，请重新审阅" };
        }
        // 步骤 1：意图持久化
        const opId = this.#opId();
        item.pendingUpdate = {
            opId,
            before: currentStripped,
            after: newRendered,
            startedAt: this.#now(),
            remoteFingerprint,
            remotePayload,
        };
        await store.save(state);
        await oplog.append({
            opId,
            ts: this.#now(),
            intent: "update-block",
            sourceKey,
            beforeText: currentStripped,
            afterText: newRendered,
            status: "pending",
        });
        try {
            // 步骤 3：唯一用户批准写入口；markdown 自带 IAL 保身份
            const markdown = `${newRendered} {: id="${blockId}" custom-wrs-src="${sourceKey}"}`;
            await this.#writer.updateBlockContent(markdown, blockId);
            // 步骤 4：回读验证（内容 + 同 ID 可读 + 身份属性保留）
            const after = await this.#writer.getBlockKramdown(blockId);
            if (after === undefined) {
                // 验证回读不可得（块缺失或读取异常）≠ 验证逻辑失败：
                // 不判死、不隔离——意图留存，下轮 reconcile 按块实况裁决（落地→收养/未落地→重议/缺失→隔离）
                await oplog.fail(opId, "验证回读失败，意图留存待下轮核对");
                return {
                    ok: false,
                    kind: "kernel",
                    message: "更新后验证回读失败，已留存意图，下轮同步核对后恢复",
                };
            }
            if (
                stripIal(after) !== newRendered ||
                this.#extractIalAttr(after, "custom-wrs-src") !== sourceKey
            ) {
                // 回读成功但 ID 变化/属性丢失/内容不符 → 隔离 + 保留快照（oplog 含 before/after）+ 上报，不自动补救写
                item.status = "quarantined";
                item.pendingUpdate = undefined;
                item.pendingRemote = undefined;
                await store.save(state);
                await oplog.fail(opId, "更新后回读验证失败（ID/属性/内容未保持），已隔离保留快照");
                return {
                    ok: false,
                    kind: "kernel",
                    message: "更新后验证失败：块 ID/身份属性/内容未保持，已隔离并保留快照，请人工检查",
                };
            }
            // 步骤 5：记账推进（指纹=已处理远端版本；sourcePayload=远端载荷，供后续 diff 基准）
            item.renderedText = newRendered;
            item.localBaseline = stripIal(after);
            item.sourcePayload = remotePayload;
            item.versionFingerprint = remoteFingerprint;
            item.override = overrideAfter;
            item.pendingRemote = undefined;
            item.pendingUpdate = undefined;
            await store.save(state);
            await oplog.complete(opId, { blockId });
            return { ok: true };
        } catch (e) {
            // 写失败：意图留存待重入核对（before 未落地 → 清除重议）；此处不重试
            await oplog.fail(opId, (e as Error).message);
            return { ok: false, kind: "kernel", message: `更新失败（未重试，可重入恢复）：${(e as Error).message}` };
        }
    }

    /** pendingUpdate 重入核对：after→收养（推进基线）/ before→清除重议 / 其他或不可读→隔离。 */
    async #reconcilePendingUpdates(
        store: GenerationStore<BookSyncState>,
        state: BookSyncState,
    ): Promise<{ state: BookSyncState; quarantined: number }> {
        let quarantined = 0;
        let changed = false;
        for (const [sourceKey, item] of Object.entries(state.items)) {
            const pending = item.pendingUpdate;
            if (pending === undefined || item.blockId === undefined) {
                continue;
            }
            const kramdown = await this.#writer.getBlockKramdown(item.blockId);
            if (kramdown === undefined) {
                item.status = "quarantined";
                item.pendingUpdate = undefined;
                quarantined += 1;
                changed = true;
                continue;
            }
            const stripped = stripIal(kramdown);
            if (
                stripped === pending.after &&
                this.#extractIalAttr(kramdown, "custom-wrs-src") === sourceKey
            ) {
                // 更新已落地且身份保持：补记账推进基线（审阅整改 M2：收养须补完身份验证——
                // 否则丢身份的块被当健康块收养，对审计/重建 SQL 永久不可见）
                item.renderedText = pending.after;
                item.localBaseline = stripped;
                item.sourcePayload = pending.remotePayload;
                item.versionFingerprint = pending.remoteFingerprint;
                item.pendingUpdate = undefined;
                item.pendingRemote = undefined;
                changed = true;
            } else if (
                stripped === pending.before &&
                this.#extractIalAttr(kramdown, "custom-wrs-src") === sourceKey
            ) {
                // 未落地（身份保持）：清除意图，候选保留待重议（复核随行：before 分支同样校验身份）
                item.pendingUpdate = undefined;
                changed = true;
            } else {
                // 内容落地但身份丢失，或不可解释状态 → 隔离待人工裁决
                item.status = "quarantined";
                item.pendingUpdate = undefined;
                quarantined += 1;
                changed = true;
            }
        }
        if (changed) {
            await store.save(state);
        }
        return { state, quarantined };
    }

    /** T04：最近摘录候选（跨书取 highlight 活跃锚点，按来源 createTime 降序） */
    async #loadRecentHighlights(index: SyncIndex): Promise<RecentHighlightCandidate[]> {
        const all: RecentHighlightCandidate[] = [];
        for (const [bookId] of Object.entries(index.books)) {
            const store = this.#bookStore(bookId);
            let state: BookSyncState | undefined;
            try {
                state = await store.load();
            } catch {
                continue;
            }
            if (state === undefined) {
                continue;
            }
            for (const [sourceKey, item] of Object.entries(state.items)) {
                if (item.kind !== "highlight" || item.status !== "active" || item.blockId === undefined) {
                    continue;
                }
                const raw = item.sourcePayload as { createTime?: unknown };
                all.push({
                    blockId: item.blockId,
                    sourceKey,
                    createTime: typeof raw.createTime === "number" ? raw.createTime : undefined,
                    text: stripIal(item.renderedText).replace(/^> /gmu, ""),
                });
            }
        }
        all.sort((a, b) => (b.createTime ?? 0) - (a.createTime ?? 0));
        return all;
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
