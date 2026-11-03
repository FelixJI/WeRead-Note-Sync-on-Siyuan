// 同步数据模型与归一化（设计契约 §1/§2/§3，冻结）。
// 本文件只含类型与纯函数；状态读写（loadData/saveData 双世代）由 engine/store 负责。

import type { SourceKind } from "./identity";
import { stableStringify } from "../adapters/weread/pagers";

// ---------- 状态存储类型（§2） ----------

export type ItemStatus = "active" | "user-deleted" | "moved-out" | "unseen" | "quarantined";

export interface ItemState {
    blockId?: string;
    parentBlockId?: string;
    kind: SourceKind;
    /** 原始来源条目快照（highlight=bookmarklist updated[] 原始对象；review=外层原始对象含 .review 嵌套） */
    sourcePayload: Record<string, unknown>;
    /** 渲染快照（kramdown） */
    renderedText: string;
    /** 写后回读的 kramdown 基线 */
    localBaseline?: string;
    /** 稳定序列化指纹（仅比较用，不代替快照） */
    versionFingerprint: string;
    status: ItemStatus;
    override: boolean;
    lastSeenRound: number;
    lastChangeRound?: number;
}

export interface PendingOp {
    opId: string;
    sourceKey: string;
    payloadText: string;
    startedAt: string;
}

export interface BookSyncState {
    schemaVersion: 1;
    bookId: string;
    docId?: string;
    title: string;
    generation: number;
    items: Record<string, ItemState>;
    pendingOp?: PendingOp;
}

export interface SyncIndex {
    schemaVersion: 1;
    accountNamespace: string;
    keyMarker?: string;
    notebookId?: string;
    /** 书目轮转游标（T02 审阅整改 M5）：每轮从该下标开始处理，避免固定截断饥饿 */
    rotation?: number;
    books: Record<string, { docId?: string; title?: string; generation: number }>;
}

/**
 * 稳定序列化指纹（键序无关）。复用 T01 pagers 的 stableStringify（行为冻结不变）；
* 指纹仅用于"来源是否变化"的比较，不代替 payload 快照与 localBaseline。
 */
export function fingerprintPayload(payload: Record<string, unknown>): string {
    return stableStringify(payload);
}

// ---------- 来源归一化（§3 输入） ----------

export interface NormalizedHighlight {
    bookmarkId: string;
    markText: string;
    chapterUid?: number;
    chapterIdx?: number;
    chapterTitle?: string;
    rangeStart?: number;
    createTime?: number;
    raw: Record<string, unknown>;
}

export interface NormalizedReview {
    reviewId: string;
    content: string;
    abstract?: string;
    chapterUid?: number;
    /** 注意：归一化评审无章节映射入参，chapterIdx 不在此产出（挂靠匹配用 chapterUid） */
    rangeStart?: number;
    createTime?: number;
    raw: Record<string, unknown>;
}

export interface BookSourceDetail {
    bookId: string;
    highlights: NormalizedHighlight[];
    reviews: NormalizedReview[];
    /** 拉取/分页级异常（整书门禁：非空 → 整书跳过、基线零推进） */
    anomalies: string[];
    /** 条目级归一化错误（T02 审阅整改 m2）：跳过该条并上报，不触发整书门禁 */
    itemErrors?: string[];
    complete: boolean;
}

export type NormalizeResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

/** range "2959-3007" → 2959（取首数字）；非法/缺失 → undefined（不崩、不猜） */
function parseRangeStart(range: unknown): number | undefined {
    if (typeof range !== "string") return undefined;
    const match = /^(\d+)/.exec(range.trim());
    if (match === null) return undefined;
    const value = Number(match[1]);
    return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * 归一化单条划线（bookmarklist updated[] 原始对象）。
 * 缺 bookmarkId / markText（含空串）→ error，不猜主键。
 * 章节定位优先 chapters 映射；映射缺失时回退原始 chapterIdx（若有）；映射缺失不视为异常。
 */
export function normalizeHighlight(
    raw: Record<string, unknown>,
    chapters: Record<number, { idx: number; title: string }>,
): NormalizeResult<NormalizedHighlight> {
    const bookmarkIdRaw = raw.bookmarkId;
    if (typeof bookmarkIdRaw !== "string" || bookmarkIdRaw.length === 0) {
        return { ok: false, error: "highlight 缺少 bookmarkId，跳过（不猜主键）" };
    }
    const markTextRaw = raw.markText;
    if (typeof markTextRaw !== "string" || markTextRaw.length === 0) {
        return { ok: false, error: `highlight ${bookmarkIdRaw} 缺少 markText，跳过` };
    }

    const value: NormalizedHighlight = { bookmarkId: bookmarkIdRaw, markText: markTextRaw, raw };

    const fallbackIdx = isFiniteNumber(raw.chapterIdx) ? raw.chapterIdx : undefined;
    if (isFiniteNumber(raw.chapterUid)) {
        value.chapterUid = raw.chapterUid;
        const chapter = chapters[raw.chapterUid];
        if (chapter !== undefined) {
            value.chapterIdx = chapter.idx;
            value.chapterTitle = chapter.title;
        } else if (fallbackIdx !== undefined) {
            value.chapterIdx = fallbackIdx;
        }
    } else if (fallbackIdx !== undefined) {
        value.chapterIdx = fallbackIdx;
    }

    const rangeStart = parseRangeStart(raw.range);
    if (rangeStart !== undefined) value.rangeStart = rangeStart;

    if (isFiniteNumber(raw.createTime)) value.createTime = raw.createTime;

    return { ok: true, value };
}

/**
 * 归一化单条想法（/review/list/mine reviews[] 的外层原始对象）。
 * reviewId/content 优先取内层 .review，回退外层平铺；abstract/range/chapterUid/createTime
 * 优先取外层（契约字段位置），回退内层。缺 reviewId / content（含空串）→ error。
 */
export function normalizeReview(reviewObj: Record<string, unknown>): NormalizeResult<NormalizedReview> {
    const innerSource = reviewObj.review;
    const inner = isRecord(innerSource) ? innerSource : reviewObj;

    const reviewIdRaw = inner.reviewId !== undefined ? inner.reviewId : reviewObj.reviewId;
    if (typeof reviewIdRaw !== "string" || reviewIdRaw.length === 0) {
        return { ok: false, error: "review 缺少 reviewId，跳过（不猜主键）" };
    }
    const contentRaw = inner.content !== undefined ? inner.content : reviewObj.content;
    if (typeof contentRaw !== "string" || contentRaw.length === 0) {
        return { ok: false, error: `review ${reviewIdRaw} 缺少 content，跳过` };
    }

    const value: NormalizedReview = { reviewId: reviewIdRaw, content: contentRaw, raw: reviewObj };

    const abstractRaw = reviewObj.abstract !== undefined ? reviewObj.abstract : inner.abstract;
    if (typeof abstractRaw === "string") value.abstract = abstractRaw;

    const chapterUidRaw = reviewObj.chapterUid !== undefined ? reviewObj.chapterUid : inner.chapterUid;
    if (isFiniteNumber(chapterUidRaw)) value.chapterUid = chapterUidRaw;

    const rangeStart = parseRangeStart(reviewObj.range !== undefined ? reviewObj.range : inner.range);
    if (rangeStart !== undefined) value.rangeStart = rangeStart;

    const createTimeRaw = reviewObj.createTime !== undefined ? reviewObj.createTime : inner.createTime;
    if (isFiniteNumber(createTimeRaw)) value.createTime = createTimeRaw;

    return { ok: true, value };
}

/**
 * 想法 → 划线挂靠匹配：chapterUid + rangeStart 双精确命中返回 bookmarkId；
 * 任一缺失或无命中 → undefined（保守放弃挂靠，入独立区）。禁止任何模糊/文本相似匹配。
 */
export function matchReviewToHighlight(
    r: NormalizedReview,
    hs: NormalizedHighlight[],
): string | undefined {
    if (r.chapterUid === undefined || r.rangeStart === undefined) return undefined;
    for (const h of hs) {
        if (h.chapterUid === r.chapterUid && h.rangeStart === r.rangeStart) {
            return h.bookmarkId;
        }
    }
    return undefined;
}
