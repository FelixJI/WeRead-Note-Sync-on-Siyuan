import type { Transport } from "../../core/net/transport";
import { executeGatewayCall, isRecord } from "./gateway";

// 分页安全规则引擎（docs/contracts/weread-gateway.md "分页安全规则"）：
// 游标循环 → 抛错；整页重复 → 停止并记异常；同 ID 载荷不同 → 保留首个记异常；
// 必填 ID 缺失 → 跳过记异常；达到 maxPages 仍有未读完数据 → 抛错（不得当完整结果）。

export class PaginationAnomalyError extends Error {
    readonly anomalies: string[];

    constructor(message: string, anomalies: string[]) {
        super(message);
        this.name = "PaginationAnomalyError";
        this.anomalies = anomalies;
    }
}

export type PaginationCursor = number | string;

export interface PagedFetchResult<T> {
    items: T[];
    hasMore: boolean;
    nextCursor: PaginationCursor | undefined;
    anomalies: string[];
}

export interface PaginateAllOptions<T> {
    maxPages: number;
    /** 异常消息中的游标名（lastSort / synckey） */
    cursorLabel: string;
    /** 异常消息中的主键名（bookId / reviewId） */
    keyLabel: string;
    fetchPage: (cursor: PaginationCursor | undefined) => Promise<PagedFetchResult<T>>;
    /** 返回 undefined 表示必填 ID 缺失（跳过并记异常） */
    keyOf: (item: T) => string | undefined;
}

export interface PaginateAllResult<T> {
    items: T[];
    anomalies: string[];
}

// 递归稳定序列化：用于"同 ID 载荷是否一致"的确定论比较（键序无关）
function stableStringify(value: unknown): string {
    if (typeof value === "string") return JSON.stringify(value);
    if (value === null || typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    if (typeof value === "object") {
        const rec = value as Record<string, unknown>;
        const keys = Object.keys(rec).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(",")}}`;
    }
    return String(value);
}

export async function paginateAll<T>(options: PaginateAllOptions<T>): Promise<PaginateAllResult<T>> {
    const { maxPages, cursorLabel, keyLabel, fetchPage, keyOf } = options;
    const collected: T[] = [];
    const anomalies: string[] = [];
    const seen = new Map<string, string>(); // key -> 首次出现时的稳定序列化
    let prevCursor: PaginationCursor | undefined = undefined;
    let prevPageKeys: Set<string> | undefined = undefined;
    let pages = 0;

    for (;;) {
        if (pages >= maxPages) {
            throw new PaginationAnomalyError(
                `分页异常：已达 maxPages=${maxPages} 上限仍有未读完数据，结果不完整`,
                [...anomalies, `maxPages上限:${maxPages}，仍有 hasMore 未读完`],
            );
        }
        const page = await fetchPage(prevCursor);
        pages += 1;
        anomalies.push(...page.anomalies);

        const pageKeys: string[] = [];
        for (const item of page.items) {
            const key = keyOf(item);
            if (key === undefined || key.length === 0) {
                anomalies.push(`${keyLabel}缺失，跳过该条`);
                continue;
            }
            pageKeys.push(key);
            const payload = stableStringify(item);
            const firstPayload = seen.get(key);
            if (firstPayload === undefined) {
                seen.set(key, payload);
                collected.push(item);
            } else if (firstPayload !== payload) {
                // 保留首个，记录歧义交上层裁决
                anomalies.push(`ambiguousId:${key} 重复且载荷不同，保留首个`);
            }
            // 载荷完全一致的重复条目：静默去重
        }

        const currentPageKeys = new Set(pageKeys);
        // 回调内无法沿用 let 变量的窄化，先固化到 const
        const prevKeys = prevPageKeys;
        if (
            prevKeys !== undefined &&
            currentPageKeys.size === prevKeys.size &&
            [...currentPageKeys].every((k) => prevKeys.has(k))
        ) {
            anomalies.push(`整页重复：${keyLabel} 集合与上一页相同，停止翻页`);
            return { items: collected, anomalies };
        }

        if (!page.hasMore) {
            return { items: collected, anomalies };
        }

        const nextCursor = page.nextCursor;
        if (nextCursor === undefined || nextCursor === prevCursor) {
            throw new PaginationAnomalyError(
                `分页异常：游标${cursorLabel}不前进（${
                    nextCursor === undefined ? "缺失" : `仍为 ${nextCursor}`
                }），判定游标循环`,
                [...anomalies, `游标循环:${cursorLabel}未前进`],
            );
        }
        prevCursor = nextCursor;
        prevPageKeys = currentPageKeys;
    }
}

// ---------- /review/list/mine 分页辅助 ----------

export interface WereadReviewEntry {
    reviewId: string;
    /** 对应划线原文，整本书评/章节点评可能缺失 */
    abstract?: string;
    range?: string;
    star?: number;
}

const REVIEWS_PAGE_COUNT = 20;

interface RawReviewParse {
    entries: WereadReviewEntry[];
    anomalies: string[];
}

function parseReviewItems(rawReviews: unknown): RawReviewParse {
    const entries: WereadReviewEntry[] = [];
    const anomalies: string[] = [];
    if (!Array.isArray(rawReviews)) {
        if (rawReviews !== undefined) {
            anomalies.push("reviews 字段不是数组，按空页处理");
        }
        return { entries, anomalies };
    }
    for (const raw of rawReviews) {
        if (!isRecord(raw) || !isRecord(raw.review)) {
            anomalies.push("reviewId缺失，跳过该条");
            continue;
        }
        const reviewId = raw.review.reviewId;
        if (typeof reviewId !== "string" || reviewId.length === 0) {
            anomalies.push("reviewId缺失，跳过该条");
            continue;
        }
        const entry: WereadReviewEntry = { reviewId };
        if (typeof raw.abstract === "string") entry.abstract = raw.abstract;
        if (typeof raw.range === "string") entry.range = raw.range;
        if (typeof raw.review.star === "number" && Number.isFinite(raw.review.star)) {
            entry.star = raw.review.star;
        }
        entries.push(entry);
    }
    return { entries, anomalies };
}

/**
 * 拉取单书全部个人想法/点评。
 * 契约关键点：参数名是全小写 bookid（与 /user/notebooks 的 bookId 不同），游标为回包 synckey。
 */
export async function listAllReviewsForBook(
    transport: Transport,
    apiKey: string,
    bookId: string,
    maxPages: number = 200,
): Promise<{ reviews: WereadReviewEntry[]; anomalies: string[] }> {
    const result = await paginateAll<WereadReviewEntry>({
        maxPages,
        cursorLabel: "synckey",
        keyLabel: "reviewId",
        keyOf: (entry) => entry.reviewId,
        fetchPage: async (cursor) => {
            const params: Record<string, unknown> = { bookid: bookId, count: REVIEWS_PAGE_COUNT };
            if (cursor !== undefined) {
                params.synckey = cursor;
            }
            const obj = await executeGatewayCall(transport, apiKey, "/review/list/mine", params);
            const parsed = parseReviewItems(obj.reviews);
            const hasMoreRaw = obj.hasMore;
            const hasMore = hasMoreRaw === 1 || hasMoreRaw === true;
            const synckeyRaw = obj.synckey;
            const nextCursor =
                typeof synckeyRaw === "string" || typeof synckeyRaw === "number"
                    ? synckeyRaw
                    : undefined;
            return {
                items: parsed.entries,
                hasMore,
                nextCursor,
                anomalies: parsed.anomalies,
            };
        },
    });
    return { reviews: result.items, anomalies: result.anomalies };
}
