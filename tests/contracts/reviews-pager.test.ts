import { describe, expect, it } from "vitest";
import type { HttpTextResponse, Transport } from "../../src/core/net/transport";
import { listAllReviewsForBook, PaginationAnomalyError } from "../../src/adapters/weread/pagers";

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

// /review/list/mine 回包条目（官方契约）：reviewId/abstract/range 均嵌套在 review 对象内；
// abstract/range 是条件字段（整本书评/章节点评可能缺失）
function rv(reviewId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { review: { reviewId, abstract: `摘要-${reviewId}`, ...extra } };
}

function bodyAsRecord(call: RecordedCall): Record<string, unknown> {
    return call.body as Record<string, unknown>;
}

describe("想法分页（/review/list/mine）", () => {
    it("参数使用全小写 bookid，synckey 作下页游标，多页全量合成", async () => {
        const t = scriptedTransport([
            () => jsonBody({ errcode: 0, hasMore: 1, synckey: "s2", reviews: [rv("r1"), rv("r2")] }),
            () => jsonBody({ errcode: 0, hasMore: 0, synckey: "", reviews: [rv("r3")] }),
        ]);
        const result = await listAllReviewsForBook(t, KEY, "BID");
        expect(result.reviews.map((r) => r.reviewId)).toEqual(["r1", "r2", "r3"]);
        expect(result.reviews[0].abstract).toBe("摘要-r1");
        expect(result.anomalies).toEqual([]);
        expect(t.calls).toHaveLength(2);
        const first = bodyAsRecord(t.calls[0]);
        expect(first.api_name).toBe("/review/list/mine");
        expect(first.skill_version).toBe("1.0.5");
        // 关键契约：bookid 全小写，不得出现驼峰 bookId
        expect(first.bookid).toBe("BID");
        expect("bookId" in first).toBe(false);
        expect(first.synckey).toBeUndefined();
        expect(bodyAsRecord(t.calls[1]).synckey).toBe("s2");
        // 同样注入 Bearer 头
        expect(t.calls[0].headers["Authorization"]).toBe(`Bearer ${KEY}`);
    });

    it("synckey 循环（回包 synckey 与上一页相同且 hasMore=1）→ PaginationAnomalyError", async () => {
        const t = scriptedTransport([
            () => jsonBody({ errcode: 0, hasMore: 1, synckey: "s1", reviews: [rv("r1")] }),
            () => jsonBody({ errcode: 0, hasMore: 1, synckey: "s1", reviews: [rv("r2")] }),
        ]);
        const err = await listAllReviewsForBook(t, KEY, "BID").then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(PaginationAnomalyError);
        expect((err as PaginationAnomalyError).message).toContain("synckey");
    });

    it("reviewId 缺失 → 跳过该条并记录异常，不猜主键", async () => {
        const t = scriptedTransport([
            () =>
                jsonBody({
                    errcode: 0,
                    hasMore: 0,
                    synckey: "",
                    reviews: [{ review: { abstract: "无ID" } }, rv("ok")],
                }),
        ]);
        const result = await listAllReviewsForBook(t, KEY, "BID");
        expect(result.reviews.map((r) => r.reviewId)).toEqual(["ok"]);
        expect(result.anomalies.some((a) => a.includes("reviewId"))).toBe(true);
    });

    it("官方契约：abstract/range 从 reviews[].review 嵌套对象读取（PR8[4] 防回归）", async () => {
        const t = scriptedTransport([
            () =>
                jsonBody({
                    errcode: 0,
                    hasMore: 0,
                    synckey: "",
                    reviews: [
                        { review: { reviewId: "r1", abstract: "划线原文", range: "100-200" } },
                        // 整本书评：无对应划线，abstract/range 缺失属正常，不记异常
                        { review: { reviewId: "r2" } },
                    ],
                }),
        ]);
        const result = await listAllReviewsForBook(t, KEY, "BID");
        expect(result.anomalies).toEqual([]);
        const r1 = result.reviews.find((r) => r.reviewId === "r1");
        expect(r1?.abstract).toBe("划线原文");
        expect(r1?.range).toBe("100-200");
        const r2 = result.reviews.find((r) => r.reviewId === "r2");
        expect(r2?.abstract).toBeUndefined();
        expect(r2?.range).toBeUndefined();
    });

    it("连续两页全部条目无效（空键集）且 synckey 前进 → 不误判整页重复，正常翻页完成", async () => {
        // 回归：空 Set 相等是空真，曾会把两个空页误判为"整页重复"软停止
        const t = scriptedTransport([
            () => jsonBody({ errcode: 0, hasMore: 1, synckey: "s1", reviews: [{ review: {} }] }),
            () => jsonBody({ errcode: 0, hasMore: 1, synckey: "s2", reviews: [{ review: {} }] }),
            () => jsonBody({ errcode: 0, hasMore: 0, synckey: "", reviews: [rv("r1")] }),
        ]);
        const result = await listAllReviewsForBook(t, KEY, "BID");
        expect(result.reviews.map((r) => r.reviewId)).toEqual(["r1"]);
        expect(t.calls).toHaveLength(3);
        expect(result.anomalies.some((a) => a.includes("reviewId"))).toBe(true);
        expect(result.anomalies.some((a) => a.includes("整页重复"))).toBe(false);
    });
});
