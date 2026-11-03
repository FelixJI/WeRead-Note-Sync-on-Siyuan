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

// /review/list/mine 回包条目：reviewId 在 review 内，abstract/range 是顶层条件字段
function rv(reviewId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { review: { reviewId, ...extra }, abstract: `摘要-${reviewId}` };
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
                    reviews: [{ review: {}, abstract: "无ID" }, rv("ok")],
                }),
        ]);
        const result = await listAllReviewsForBook(t, KEY, "BID");
        expect(result.reviews.map((r) => r.reviewId)).toEqual(["ok"]);
        expect(result.anomalies.some((a) => a.includes("reviewId"))).toBe(true);
    });
});
