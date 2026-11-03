// 计划计算（设计契约 §3，冻结）：纯函数，只读 state 与来源明细，输出 Plan。
// 只允许"新建"进入自动路径：绝无 update/delete；变化仅入 candidates 待审（T03）；
// 来源异常/不完整 → 整书跳过，不产出任何动作、不推进任何基线。

import { makeSourceKey, type SourceKind } from "./identity";
import { renderHighlightBlock, renderReviewChild } from "./kramdown";
import {
    fingerprintPayload,
    matchReviewToHighlight,
    type BookSourceDetail,
    type BookSyncState,
    type ItemState,
    type NormalizedHighlight,
    type NormalizedReview,
} from "./model";

export interface PlanCreate {
    sourceKey: string;
    kind: SourceKind;
    officialSourceId: string;
    /** 来源原始条目记录（不做裁剪；highlight=updated[] 原始对象，review=外层对象含 .review 嵌套） */
    payload: Record<string, unknown>;
    /** plan 用 kramdown 渲染函数产出的最终 markdown */
    renderedText: string;
    chapter: { idx: number; title: string } | undefined;
    /** 挂靠目标的 highlight bookmarkId（未挂靠则缺省） */
    matchedHighlightBlockHint?: string;
}

export interface PlanCandidate {
    sourceKey: string;
    reason: "source-changed";
    oldFingerprint: string;
    newFingerprint: string;
}

export interface PlanProtected {
    sourceKey: string;
    reason: "unseen" | "user-deleted" | "moved-out" | "ambiguous-attrs";
    note?: string;
}

export interface SyncPlan {
    creates: PlanCreate[];
    candidates: PlanCandidate[];
    protected: PlanProtected[];
    skipped: boolean;
    skipReason?: string;
}

interface HighlightItem {
    kind: "highlight";
    h: NormalizedHighlight;
    sourceKey: string;
}
interface ReviewItem {
    kind: "review";
    r: NormalizedReview;
    sourceKey: string;
}
type SourceItem = HighlightItem | ReviewItem;

function skipPlan(reason: string): SyncPlan {
    // 每次返回全新数组：防止调用方改动 plan 数组污染后续结果
    return { creates: [], candidates: [], protected: [], skipped: true, skipReason: reason };
}

function compareOptionalAsc(a: number | undefined, b: number | undefined): number {
    if (a === undefined && b === undefined) return 0;
    // 无值排在有值之后（"无章节信息排在有章节之后"同一规则的推广）
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

/** highlight 稳定排序：(chapterIdx, rangeStart, createTime, bookmarkId) */
function compareHighlights(a: NormalizedHighlight, b: NormalizedHighlight): number {
    const byIdx = compareOptionalAsc(a.chapterIdx, b.chapterIdx);
    if (byIdx !== 0) return byIdx;
    const byRange = compareOptionalAsc(a.rangeStart, b.rangeStart);
    if (byRange !== 0) return byRange;
    const byTime = compareOptionalAsc(a.createTime, b.createTime);
    if (byTime !== 0) return byTime;
    if (a.bookmarkId < b.bookmarkId) return -1;
    if (a.bookmarkId > b.bookmarkId) return 1;
    return 0;
}

/** 独立想法排序：(createTime, reviewId) */
function compareStandaloneReviews(a: NormalizedReview, b: NormalizedReview): number {
    const byTime = compareOptionalAsc(a.createTime, b.createTime);
    if (byTime !== 0) return byTime;
    if (a.reviewId < b.reviewId) return -1;
    if (a.reviewId > b.reviewId) return 1;
    return 0;
}

function chapterOfHighlight(h: NormalizedHighlight): { idx: number; title: string } | undefined {
    if (h.chapterIdx === undefined) return undefined;
    return { idx: h.chapterIdx, title: h.chapterTitle ?? "" };
}

export function computePlan(args: {
    state: BookSyncState | undefined;
    detail: BookSourceDetail;
    round: number;
    accountNamespace: string;
}): SyncPlan {
    const { state, detail, accountNamespace } = args;
    // round 不参与计划计算：seen 计数/lastSeenRound 由 engine 回写 state（契约冻结）。

    // ---- 前置门禁：分页异常/不完整 → 整书跳过 ----
    const gateReasons: string[] = [];
    if (!detail.complete) gateReasons.push("来源数据不完整（complete=false）");
    if (detail.anomalies.length > 0) {
        gateReasons.push(`来源异常 ${detail.anomalies.length} 条（${detail.anomalies.join("；")}）`);
    }
    if (gateReasons.length > 0) {
        return skipPlan(`${gateReasons.join("；")}，整书跳过：本轮不产出任何动作，不推进任何基线`);
    }

    // ---- 身份构建：官方 ID 无法构成合法身份 → 整书跳过（不猜主键） ----
    let sourceItems: SourceItem[];
    try {
        sourceItems = [
            ...detail.highlights.map((h): HighlightItem => ({
                kind: "highlight",
                h,
                sourceKey: makeSourceKey({
                    accountNamespace,
                    bookId: detail.bookId,
                    kind: "highlight",
                    officialSourceId: h.bookmarkId,
                }),
            })),
            ...detail.reviews.map((r): ReviewItem => ({
                kind: "review",
                r,
                sourceKey: makeSourceKey({
                    accountNamespace,
                    bookId: detail.bookId,
                    kind: "review",
                    officialSourceId: r.reviewId,
                }),
            })),
        ];
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return skipPlan(`来源官方 ID 无法构成合法身份（${message}），整书跳过（不猜主键）`);
    }

    const stateItems: Record<string, ItemState> = state?.items ?? {};
    const seenKeys = new Set(sourceItems.map((item) => item.sourceKey));

    const newHighlights: Array<{ h: NormalizedHighlight; sourceKey: string }> = [];
    const newReviews: Array<{ r: NormalizedReview; sourceKey: string }> = [];
    const candidates: PlanCandidate[] = [];
    const protectedItems: PlanProtected[] = [];

    for (const item of sourceItems) {
        const existing = stateItems[item.sourceKey];
        if (existing === undefined) {
            if (item.kind === "highlight") newHighlights.push({ h: item.h, sourceKey: item.sourceKey });
            else newReviews.push({ r: item.r, sourceKey: item.sourceKey });
            continue;
        }
        // 指纹统一：newFingerprint = fingerprintPayload(原始条目记录)，与 versionFingerprint 比较
        const newFingerprint = fingerprintPayload(item.kind === "highlight" ? item.h.raw : item.r.raw);
        if (existing.status === "active") {
            if (existing.versionFingerprint !== newFingerprint) {
                // 来源变化且本地 active → 待审候选；绝不产生 create/update
                candidates.push({
                    sourceKey: item.sourceKey,
                    reason: "source-changed",
                    oldFingerprint: existing.versionFingerprint,
                    newFingerprint,
                });
            }
            continue; // 指纹一致的 active：无动作；lastSeenRound 由 engine 回写
        }
        if (existing.status === "user-deleted") {
            protectedItems.push({ sourceKey: item.sourceKey, reason: "user-deleted" });
            continue;
        }
        if (existing.status === "moved-out") {
            protectedItems.push({ sourceKey: item.sourceKey, reason: "moved-out" });
            continue;
        }
        if (existing.status === "quarantined") {
            protectedItems.push({
                sourceKey: item.sourceKey,
                reason: "ambiguous-attrs",
                note: "多块歧义，待人工裁决（禁止任选接管）",
            });
            continue;
        }
        // status === "unseen"：本轮来源重新出现，plan 不产出动作；engine 复位状态
    }

    // ---- 来源未见：仅对 active 保护（unseen 计数由 engine 回写；永不删除标记） ----
    for (const [sourceKey, existing] of Object.entries(stateItems)) {
        if (seenKeys.has(sourceKey)) continue;
        if (existing.status === "active") {
            protectedItems.push({ sourceKey, reason: "unseen" });
        }
    }

    // ---- creates 组装（文档顺序） ----
    // 1. 新 highlight 按 (chapterIdx, rangeStart, createTime, bookmarkId) 排序；
    // 2. 挂靠到"本轮新建 highlight"的 review 紧随其后（来源顺序）；
    // 3. 挂靠到"已存在 highlight"的 review（hint 仍给出）按挂靠章节排后；
    // 4. 独立想法（无章节信息）最后，按 (createTime, reviewId)。
    const sortedNewHighlights = [...newHighlights].sort((a, b) => compareHighlights(a.h, b.h));
    const newHighlightIds = new Set(sortedNewHighlights.map((e) => e.h.bookmarkId));
    const highlightsById = new Map(detail.highlights.map((h) => [h.bookmarkId, h]));

    const attachedToNew = new Map<string, Array<{ r: NormalizedReview; sourceKey: string }>>();
    const attachedToExisting: Array<{
        r: NormalizedReview;
        sourceKey: string;
        hint: NormalizedHighlight;
    }> = [];
    const standaloneReviews: Array<{ r: NormalizedReview; sourceKey: string }> = [];
    for (const { r, sourceKey } of newReviews) {
        const hintBookmarkId = matchReviewToHighlight(r, detail.highlights);
        if (hintBookmarkId === undefined) {
            standaloneReviews.push({ r, sourceKey });
            continue;
        }
        const hinted = highlightsById.get(hintBookmarkId);
        if (hinted === undefined) continue; // 不可能：hint 产自同一 highlights 集合
        if (newHighlightIds.has(hintBookmarkId)) {
            const list = attachedToNew.get(hintBookmarkId);
            if (list === undefined) attachedToNew.set(hintBookmarkId, [{ r, sourceKey }]);
            else list.push({ r, sourceKey }); // 同一 highlight 多 review：保持来源顺序
        } else {
            attachedToExisting.push({ r, sourceKey, hint: hinted });
        }
    }

    const creates: PlanCreate[] = [];
    const pushHighlightCreate = (h: NormalizedHighlight, sourceKey: string): void => {
        creates.push({
            sourceKey,
            kind: "highlight",
            officialSourceId: h.bookmarkId,
            payload: h.raw,
            renderedText: renderHighlightBlock(h.markText),
            chapter: chapterOfHighlight(h),
        });
    };
    const pushReviewCreate = (
        r: NormalizedReview,
        sourceKey: string,
        chapter: { idx: number; title: string } | undefined,
        hint: string | undefined,
    ): void => {
        const create: PlanCreate = {
            sourceKey,
            kind: "review",
            officialSourceId: r.reviewId,
            payload: r.raw,
            renderedText: renderReviewChild(r.content),
            chapter,
        };
        if (hint !== undefined) create.matchedHighlightBlockHint = hint;
        creates.push(create);
    };

    for (const { h, sourceKey } of sortedNewHighlights) {
        pushHighlightCreate(h, sourceKey);
        const attached = attachedToNew.get(h.bookmarkId) ?? [];
        for (const { r, sourceKey: reviewKey } of attached) {
            // 挂靠 review 继承 highlight 的章节；同一 highlight 多 review 保持来源顺序
            pushReviewCreate(r, reviewKey, chapterOfHighlight(h), h.bookmarkId);
        }
    }

    attachedToExisting.sort((a, b) => {
        const byIdx = compareOptionalAsc(a.hint.chapterIdx, b.hint.chapterIdx);
        if (byIdx !== 0) return byIdx;
        return compareStandaloneReviews(a.r, b.r);
    });
    for (const { r, sourceKey, hint } of attachedToExisting) {
        pushReviewCreate(r, sourceKey, chapterOfHighlight(hint), hint.bookmarkId);
    }

    standaloneReviews.sort((a, b) => compareStandaloneReviews(a.r, b.r));
    for (const { r, sourceKey } of standaloneReviews) {
        pushReviewCreate(r, sourceKey, undefined, undefined);
    }

    return { creates, candidates, protected: protectedItems, skipped: false };
}
