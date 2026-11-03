import type { Transport } from "../../core/net/transport";
import { executeGatewayCall, isRecord } from "./gateway";
import { paginateAll } from "./pagers";

// /book/bookmarklist（契约冻结）：单接口无分页，bookId 驼峰；
// updated 非数组 → complete=false（本轮数据不完整，上层整书跳过）；
// chapters 重复 uid 保留首个记 anomaly；字段缺失/形态异常仅记 anomaly 不降级 complete。

export interface BookmarkListResult {
    rawItems: Record<string, unknown>[];
    chapters: Record<number, { idx: number; title: string }>;
    book: Record<string, unknown> | undefined;
    anomalies: string[];
    complete: boolean;
}

export async function fetchBookmarkList(
    transport: Transport,
    apiKey: string,
    bookId: string,
): Promise<BookmarkListResult> {
    const obj = await executeGatewayCall(transport, apiKey, "/book/bookmarklist", { bookId });
    const anomalies: string[] = [];

    // updated[]：划线原始条目（bookmarkId/markText/type/range 等），不做裁剪
    const rawItems: Record<string, unknown>[] = [];
    const updatedRaw = obj.updated;
    let complete = true;
    if (!Array.isArray(updatedRaw)) {
        anomalies.push("updated 字段不是数组，视为数据不完整");
        complete = false;
    } else {
        updatedRaw.forEach((item, index) => {
            if (!isRecord(item)) {
                anomalies.push(`updated[${index}] 不是对象，跳过`);
                return;
            }
            rawItems.push(item);
        });
    }

    // chapters[]：chapterUid → {idx, title}；重复 uid 保留首个记 anomaly
    const chapters: Record<number, { idx: number; title: string }> = {};
    const chaptersRaw = obj.chapters;
    if (chaptersRaw !== undefined && !Array.isArray(chaptersRaw)) {
        anomalies.push("chapters 字段不是数组，忽略章节映射");
    } else if (Array.isArray(chaptersRaw)) {
        chaptersRaw.forEach((item, index) => {
            if (!isRecord(item)) {
                anomalies.push(`chapters[${index}] 不是对象，跳过`);
                return;
            }
            const uid = item.chapterUid;
            const idx = item.chapterIdx;
            const title = item.title;
            if (
                typeof uid !== "number" || !Number.isFinite(uid) ||
                typeof idx !== "number" || !Number.isFinite(idx) ||
                typeof title !== "string"
            ) {
                anomalies.push(
                    `chapters[${index}] 必填字段缺失（chapterUid/chapterIdx/title），跳过`,
                );
                return;
            }
            if (chapters[uid] !== undefined) {
                anomalies.push(`chapters 重复 chapterUid=${uid}，保留首个`);
                return;
            }
            chapters[uid] = { idx, title };
        });
    }

    // book：可选透传
    let book: Record<string, unknown> | undefined;
    if (obj.book !== undefined) {
        if (!isRecord(obj.book)) {
            anomalies.push("book 字段不是对象，忽略");
        } else {
            book = obj.book;
        }
    }

    return { rawItems, chapters, book, anomalies, complete };
}

// ---------- /review/list/mine 原始条目全量拉取（T02 引擎用） ----------

const REVIEWS_PAGE_COUNT = 20;

/**
 * 拉取单书全部个人想法/点评的**原始条目**（外层对象含 abstract/range，
 * 内层 .review 含 reviewId/content），供 normalizeReview 与载荷指纹使用，不做裁剪。
 * 分页守卫复用 paginateAll（游标循环/整页重复/同 ID 歧义/maxPages 与既有分页辅助一致）；
 * 参数名契约：bookid 全小写，游标为回包 synckey。
 */
export async function listAllReviewsRaw(
    transport: Transport,
    apiKey: string,
    bookId: string,
    maxPages: number = 200,
): Promise<{ raws: Record<string, unknown>[]; anomalies: string[] }> {
    const result = await paginateAll<Record<string, unknown>>({
        maxPages,
        cursorLabel: "synckey",
        keyLabel: "reviewId",
        // reviewId 在内层 .review；缺失/形态不对 → undefined → paginateAll 跳过并记异常
        keyOf: (raw) => {
            if (!isRecord(raw)) return undefined;
            const inner = raw.review;
            if (!isRecord(inner)) return undefined;
            const reviewId = inner.reviewId;
            return typeof reviewId === "string" && reviewId.length > 0 ? reviewId : undefined;
        },
        fetchPage: async (cursor) => {
            const params: Record<string, unknown> = { bookid: bookId, count: REVIEWS_PAGE_COUNT };
            if (cursor !== undefined) {
                params.synckey = cursor;
            }
            const obj = await executeGatewayCall(transport, apiKey, "/review/list/mine", params);
            const anomalies: string[] = [];
            const items: Record<string, unknown>[] = [];
            const reviewsRaw = obj.reviews;
            if (reviewsRaw !== undefined && !Array.isArray(reviewsRaw)) {
                anomalies.push("reviews 字段不是数组，按空页处理");
            } else if (Array.isArray(reviewsRaw)) {
                for (const raw of reviewsRaw) {
                    if (!isRecord(raw)) {
                        anomalies.push("review 条目不是对象，跳过");
                        continue;
                    }
                    items.push(raw);
                }
            }
            const hasMore = obj.hasMore === 1 || obj.hasMore === true;
            const synckeyRaw = obj.synckey;
            const nextCursor =
                typeof synckeyRaw === "string" || typeof synckeyRaw === "number"
                    ? synckeyRaw
                    : undefined;
            return { items, hasMore, nextCursor, anomalies };
        },
    });
    return { raws: result.items, anomalies: result.anomalies };
}
