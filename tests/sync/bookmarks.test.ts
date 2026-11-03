import { describe, expect, it } from "vitest";
import type { HttpTextResponse, Transport } from "../../src/core/net/transport";
import { fetchBookmarkList, listAllReviewsRaw } from "../../src/adapters/weread/bookmarks";
import type { BookmarkListResult } from "../../src/adapters/weread/bookmarks";
import { normalizeHighlight } from "../../src/sync/model";
import type { BookSourceDetail, NormalizedHighlight } from "../../src/sync/model";
import { computePlan } from "../../src/sync/plan";

const KEY = "wrk-test-key-0001";

interface RecordedCall {
    url: string;
    body: unknown;
    headers: Record<string, string>;
    timeoutMs: number;
}

function scriptedTransport(
    pages: Array<() => HttpTextResponse>,
): Transport & { calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    return {
        calls,
        async post(url, body, headers, timeoutMs) {
            const next = pages[calls.length];
            if (next === undefined) {
                throw new Error(`意外的第 ${calls.length + 1} 次请求`);
            }
            calls.push({ url, body, headers, timeoutMs });
            return next();
        },
    };
}

function jsonBody(obj: unknown, status = 200): HttpTextResponse {
    return { status, body: JSON.stringify(obj), contentType: "application/json" };
}

function bodyAsRecord(call: RecordedCall): Record<string, unknown> {
    return call.body as Record<string, unknown>;
}

function bm(bookmarkId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { bookmarkId, markText: `文本-${bookmarkId}`, chapterUid: 1, range: "10-20", createTime: 100, ...extra };
}

describe("fetchBookmarkList（/book/bookmarklist）", () => {
    it("断言 api_name/bookId（驼峰）参数与回包解包", async () => {
        const t = scriptedTransport([
            () =>
                jsonBody({
                    errcode: 0,
                    updated: [bm("b1"), bm("b2")],
                    chapters: [
                        { chapterUid: 1, chapterIdx: 1, title: "第一章" },
                        { chapterUid: 2, chapterIdx: 2, title: "第二章" },
                    ],
                    book: { bookId: "BID", title: "书名", author: "作者" },
                }),
        ]);
        const result = await fetchBookmarkList(t, KEY, "BID");
        expect(t.calls).toHaveLength(1);
        const body = bodyAsRecord(t.calls[0]);
        expect(body.api_name).toBe("/book/bookmarklist");
        expect(body.bookId).toBe("BID");
        expect("bookid" in body).toBe(false);
        expect(body.skill_version).toBe("1.0.5");
        expect(t.calls[0].headers["Authorization"]).toBe(`Bearer ${KEY}`);
        // 解包
        expect(result.rawItems).toHaveLength(2);
        expect(result.rawItems[0].bookmarkId).toBe("b1");
        expect(result.chapters).toEqual({
            1: { idx: 1, title: "第一章" },
            2: { idx: 2, title: "第二章" },
        });
        expect(result.book?.title).toBe("书名");
        expect(result.anomalies).toEqual([]);
        expect(result.complete).toBe(true);
    });

    it("updated 非数组 → anomaly + complete=false", async () => {
        const t = scriptedTransport([() => jsonBody({ errcode: 0, updated: "oops" })]);
        const result = await fetchBookmarkList(t, KEY, "BID");
        expect(result.complete).toBe(false);
        expect(result.rawItems).toEqual([]);
        expect(result.anomalies.some((a) => a.includes("updated"))).toBe(true);
    });

    it("updated 缺失 → 同样 complete=false", async () => {
        const t = scriptedTransport([() => jsonBody({ errcode: 0 })]);
        const result = await fetchBookmarkList(t, KEY, "BID");
        expect(result.complete).toBe(false);
        expect(result.anomalies.some((a) => a.includes("updated"))).toBe(true);
    });

    it("chapters 重复 uid → 保留首个并记 anomaly；不降级 complete", async () => {
        const t = scriptedTransport([
            () =>
                jsonBody({
                    errcode: 0,
                    updated: [bm("b1")],
                    chapters: [
                        { chapterUid: 1, chapterIdx: 1, title: "首章" },
                        { chapterUid: 1, chapterIdx: 9, title: "重复章" },
                    ],
                }),
        ]);
        const result = await fetchBookmarkList(t, KEY, "BID");
        expect(result.chapters[1]).toEqual({ idx: 1, title: "首章" });
        expect(result.anomalies.some((a) => a.includes("chapterUid") && a.includes("1"))).toBe(true);
        expect(result.complete).toBe(true);
    });

    it("updated 条目非对象 / chapters 字段缺失仅记 anomaly，不降级 complete", async () => {
        const t = scriptedTransport([
            () =>
                jsonBody({
                    errcode: 0,
                    updated: [bm("b1"), "not-an-object"],
                    chapters: [{ chapterUid: 1, title: "缺 idx" }],
                }),
        ]);
        const result = await fetchBookmarkList(t, KEY, "BID");
        expect(result.rawItems).toHaveLength(1);
        expect(result.anomalies.some((a) => a.includes("不是对象"))).toBe(true);
        expect(result.anomalies.some((a) => a.includes("chapterIdx"))).toBe(true);
        expect(result.chapters).toEqual({});
        expect(result.complete).toBe(true);
    });
});

// 模拟引擎 #fetchDetail → computePlan 的前半段（纯函数，不触内核）：
// 证明去重发生在 computePlan 输入之前、异常经现有门禁语义使整书不进写入阶段
function planFromFetch(bm: BookmarkListResult) {
    const highlights: NormalizedHighlight[] = [];
    const itemErrors: string[] = [];
    for (const raw of bm.rawItems) {
        const n = normalizeHighlight(raw, bm.chapters);
        if (n.ok) highlights.push(n.value);
        else itemErrors.push(n.error);
    }
    const anomalies = bm.anomalies;
    const detail: BookSourceDetail = {
        bookId: "BID",
        highlights,
        reviews: [],
        anomalies,
        itemErrors,
        complete: bm.complete && anomalies.length === 0,
    };
    return computePlan({ state: undefined, detail, round: 1, accountNamespace: "acct" });
}

describe("updated[] 同 bookmarkId 去重（PR9[8]）", () => {
    it("同一 bookmarkId 完全重复出现 → 只保留一次，computePlan 只建一次块", async () => {
        const t = scriptedTransport([
            () =>
                jsonBody({
                    errcode: 0,
                    updated: [bm("h1"), bm("h1"), bm("h2")],
                    chapters: [{ chapterUid: 1, chapterIdx: 1, title: "第一章" }],
                }),
        ]);
        const result = await fetchBookmarkList(t, KEY, "BID");
        expect(result.rawItems).toHaveLength(2);
        expect(result.rawItems.filter((r) => r.bookmarkId === "h1")).toHaveLength(1);
        expect(result.anomalies).toEqual([]);
        expect(result.complete).toBe(true);
        // 去重后进入 computePlan：h1 只产出一次 create，不产生重复块/重复挂靠
        const plan = planFromFetch(result);
        expect(plan.skipped).toBe(false);
        const h1Creates = plan.creates.filter(
            (c) => c.officialSourceId === "h1",
        );
        expect(h1Creates).toHaveLength(1);
        expect(plan.creates.map((c) => c.officialSourceId).sort()).toEqual(["h1", "h2"]);
    });

    it("同一 bookmarkId 载荷冲突 → 保留首个并记 anomaly，整书不进写入阶段", async () => {
        const t = scriptedTransport([
            () =>
                jsonBody({
                    errcode: 0,
                    updated: [bm("h1"), bm("h1", { markText: "被篡改的文本" }), bm("h2")],
                    chapters: [{ chapterUid: 1, chapterIdx: 1, title: "第一章" }],
                }),
        ]);
        const result = await fetchBookmarkList(t, KEY, "BID");
        // 适配器层：保留首个载荷 + ambiguousId 异常（不静默）
        expect(result.rawItems).toHaveLength(2);
        expect(result.rawItems.find((r) => r.bookmarkId === "h1")?.markText).toBe("文本-h1");
        expect(result.anomalies.some((a) => a.includes("ambiguousId") && a.includes("h1"))).toBe(
            true,
        );
        // 现有 anomaly 门禁语义：anomalies 非空 → complete=false → computePlan 整书跳过、零动作
        const plan = planFromFetch(result);
        expect(plan.skipped).toBe(true);
        expect(plan.creates).toEqual([]);
        expect(plan.skipReason).toContain("整书跳过");
    });
});

describe("listAllReviewsRaw（/review/list/mine 原始条目）", () => {
    it("raws 保形：内层 .review.reviewId/content/abstract/range 与顶层 chapterUid/createTime 原样保留", async () => {
        // 官方契约形态：abstract/range 嵌套在 .review 内
        const item1 = {
            review: { reviewId: "r1", content: "想法一", star: 3, abstract: "划线原文一", range: "100-200" },
            chapterUid: 1,
            createTime: 1700000000,
        };
        const item2 = { review: { reviewId: "r2", content: "整本书评" } };
        const t = scriptedTransport([
            () => jsonBody({ errcode: 0, hasMore: 1, synckey: "s2", reviews: [item1] }),
            () => jsonBody({ errcode: 0, hasMore: 0, synckey: "", reviews: [item2] }),
        ]);
        const result = await listAllReviewsRaw(t, KEY, "BID");
        expect(result.anomalies).toEqual([]);
        expect(result.raws).toEqual([item1, item2]);
        // 未做任何裁剪：嵌套对象与顶层字段逐字段一致
        expect((result.raws[0].review as Record<string, unknown>).abstract).toBe("划线原文一");
        expect((result.raws[0].review as Record<string, unknown>).content).toBe("想法一");
        // 契约：参数全小写 bookid
        const body = bodyAsRecord(t.calls[0]);
        expect(body.api_name).toBe("/review/list/mine");
        expect(body.bookid).toBe("BID");
        expect("bookId" in body).toBe(false);
        expect(body.count).toBe(20);
        expect(bodyAsRecord(t.calls[1]).synckey).toBe("s2");
    });

    it("守卫复用生效：reviewId 缺失 → 跳过记异常；同 ID 载荷不同 → ambiguousId", async () => {
        const t = scriptedTransport([
            () =>
                jsonBody({
                    errcode: 0,
                    hasMore: 1,
                    synckey: "s2",
                    reviews: [
                        { review: {}, abstract: "无 ID" },
                        { review: { reviewId: "r1", content: "第一版" } },
                    ],
                }),
            () =>
                jsonBody({
                    errcode: 0,
                    hasMore: 0,
                    synckey: "",
                    reviews: [{ review: { reviewId: "r1", content: "第二版" } }],
                }),
        ]);
        const result = await listAllReviewsRaw(t, KEY, "BID");
        expect(result.raws).toHaveLength(1);
        expect((result.raws[0].review as Record<string, unknown>).content).toBe("第一版");
        expect(result.anomalies.some((a) => a.includes("reviewId"))).toBe(true);
        expect(result.anomalies.some((a) => a.includes("ambiguousId"))).toBe(true);
    });
});
