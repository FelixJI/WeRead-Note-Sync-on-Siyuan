/**
 * 审阅 UI 视图模型（纯辅助函数，无副作用、无 DOM 访问）。
 *
 * - 将队列候选（src/review/queue.ts 冻结接口）包装为带 UI 状态的条目视图。
 * - 提供按书分组 / 筛选 / 计数 / 徽标文案映射等纯函数，供 review-dialog-body.svelte 的 $derived 使用。
 * - 冲突分类结果由队列直接给出（classifyConflict 在数据层执行）；字符级 diff 使用 src/diff/chars.ts 冻结接口。
 */
import { diffChars, type DiffOp } from "../../diff/chars";
import type { ConflictKind, DecisionAction } from "../model";
import type { ReviewCandidate } from "../queue";
import type { SettingsTextKey } from "../../settings/i18n";

/** 筛选维度：全部 / 仅冲突（both-changed）/ 仅远端变化（remote-only）。 */
export type ReviewFilter = "all" | "both-changed" | "remote-only";

/** 需要经 applyDecision 落地的动作（defer 为纯 UI 行为，不调用 applyDecision）。 */
export type ExecutableAction = Exclude<DecisionAction, "defer">;

/** 条目视图：队列候选 + 纯 UI 状态（不承载任何持久化语义）。 */
export interface ReviewItemView extends ReviewCandidate {
    /** local vs remote 的字符级 diff（展示用，条目刷新时重算）。 */
    diff: DiffOp[];
    /** 基线段是否展开（默认折叠）。 */
    baselineOpen: boolean;
    /** 条目级操作进行中（防重入：期间禁用该条目全部决策按钮）。 */
    busy: boolean;
    /** 条目级提示（stale 重载说明 / 已脱敏的失败原因）。 */
    notice: string;
    noticeKind: "info" | "error";
    /** 手动合并编辑器是否打开。 */
    editing: boolean;
    /** 手动合并文本（打开编辑器时预填远端文本）。 */
    manualText: string;
}

/** 冲突类型 → 徽标文案键。 */
export const CONFLICT_BADGE_KEY: Record<ConflictKind, SettingsTextKey> = {
    identical: "reviewConflictIdentical",
    "remote-only": "reviewConflictRemoteOnly",
    "local-only": "reviewConflictLocalOnly",
    "both-changed": "reviewConflictBothChanged",
};

/** 条目类型 → 徽标文案键。 */
export const KIND_BADGE_KEY: Record<ReviewCandidate["kind"], SettingsTextKey> = {
    highlight: "reviewKindHighlight",
    review: "reviewKindReview",
};

/** 候选 → 条目视图（计算行内 diff，UI 状态复位）。 */
export function toItemView(candidate: ReviewCandidate): ReviewItemView {
    return {
        ...candidate,
        diff: diffChars(candidate.local, candidate.remote),
        baselineOpen: false,
        busy: false,
        notice: "",
        noticeKind: "info",
        editing: false,
        manualText: candidate.remote,
    };
}

/** 就地应用刷新后的候选数据（sourceKey 不变；diff 重算；编辑/展开状态复位）。 */
export function applyFreshItem(view: ReviewItemView, fresh: ReviewCandidate): void {
    view.bookId = fresh.bookId;
    view.bookTitle = fresh.bookTitle;
    view.kind = fresh.kind;
    view.blockId = fresh.blockId;
    view.baseline = fresh.baseline;
    view.local = fresh.local;
    view.remote = fresh.remote;
    view.remoteFingerprint = fresh.remoteFingerprint;
    view.conflict = fresh.conflict;
    view.detectedAt = fresh.detectedAt;
    view.diff = diffChars(fresh.local, fresh.remote);
    view.baselineOpen = false;
    view.editing = false;
    view.manualText = fresh.remote;
}

/** 按书分组（保持队列既有顺序：书按首次出现顺序，组内按队列顺序）。 */
export interface ReviewBookGroup {
    bookId: string;
    bookTitle: string;
    items: ReviewItemView[];
}

export function groupByBook(items: ReviewItemView[]): ReviewBookGroup[] {
    const groups: ReviewBookGroup[] = [];
    const byBook = new Map<string, ReviewBookGroup>();
    for (const item of items) {
        let group = byBook.get(item.bookId);
        if (group === undefined) {
            group = { bookId: item.bookId, bookTitle: item.bookTitle, items: [] };
            byBook.set(item.bookId, group);
            groups.push(group);
        }
        group.items.push(item);
    }
    return groups;
}

/** 按筛选维度过滤（筛选值与 ConflictKind 的 "both-changed" / "remote-only" 对齐）。 */
export function filterItems(items: ReviewItemView[], filter: ReviewFilter): ReviewItemView[] {
    if (filter === "all") {
        return items;
    }
    return items.filter((item) => item.conflict === filter);
}

/** 计数（筛选按钮徽标 + 标题待审数）。 */
export interface ReviewCounts {
    total: number;
    bothChanged: number;
    remoteOnly: number;
}

export function countItems(items: ReviewItemView[]): ReviewCounts {
    let bothChanged = 0;
    let remoteOnly = 0;
    for (const item of items) {
        if (item.conflict === "both-changed") {
            bothChanged += 1;
        } else if (item.conflict === "remote-only") {
            remoteOnly += 1;
        }
    }
    return { total: items.length, bothChanged, remoteOnly };
}

/** detectedAt → 本地化时间串；无法解析时返回空串（不显示该行）。 */
export function formatDetectedAt(iso: string): string {
    const time = Date.parse(iso);
    if (Number.isNaN(time)) {
        return "";
    }
    return new Date(time).toLocaleString();
}
