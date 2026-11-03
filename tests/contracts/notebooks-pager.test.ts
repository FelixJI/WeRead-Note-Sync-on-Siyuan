import { describe, expect, it } from "vitest";
import type { HttpTextResponse, Transport } from "../../src/core/net/transport";
import { createWereadClient } from "../../src/adapters/weread/client";
import { PaginationAnomalyError } from "../../src/adapters/weread/pagers";

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

// 服务端原始条目形状（官方契约：title/author 嵌套在 books[].book 对象内）
function nb(bookId: string, sort: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        bookId,
        book: { title: `书-${bookId}`, author: "作者" },
        reviewCount: 1,
        noteCount: 2,
        bookmarkCount: 3,
        sort,
        ...extra,
    };
}

function bodyAsRecord(call: RecordedCall): Record<string, unknown> {
    return call.body as Record<string, unknown>;
}

describe("书目分页（/user/notebooks）", () => {
    it("多页合成数据全量读取：游标传递正确、结果完整无异常", async () => {
        const t = scriptedTransport([
            () => jsonBody({ errcode: 0, hasMore: 1, books: [nb("A", 100), nb("B", 90)] }),
            () => jsonBody({ errcode: 0, hasMore: 1, books: [nb("C", 80), nb("D", 70)] }),
            () => jsonBody({ errcode: 0, hasMore: 0, totalBookCount: 5, books: [nb("E", 60)] }),
        ]);
        const client = createWereadClient(t, KEY);
        const result = await client.listAllNotebooks();
        expect(result.books.map((b) => b.bookId)).toEqual(["A", "B", "C", "D", "E"]);
        expect(result.anomalies).toEqual([]);
        expect(t.calls).toHaveLength(3);
        expect(bodyAsRecord(t.calls[0]).lastSort).toBeUndefined();
        expect(bodyAsRecord(t.calls[0]).count).toBe(20);
        expect(bodyAsRecord(t.calls[1]).lastSort).toBe(90);
        expect(bodyAsRecord(t.calls[2]).lastSort).toBe(70);
    });

    it("游标不前进 → PaginationAnomalyError，不得当作已完成", async () => {
        const t = scriptedTransport([
            () => jsonBody({ errcode: 0, hasMore: 1, books: [nb("A", 100), nb("B", 90)] }),
            // 最后一行 sort 仍是 90，与上一页游标相同且内容不同 → 游标循环
            () => jsonBody({ errcode: 0, hasMore: 1, books: [nb("C", 95), nb("D", 90)] }),
        ]);
        const client = createWereadClient(t, KEY);
        const err = await client.listAllNotebooks().then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(PaginationAnomalyError);
        const pae = err as PaginationAnomalyError;
        expect(pae.message).toContain("游标循环");
        expect(pae.anomalies.length).toBeGreaterThan(0);
    });

    it("整页重复（bookId 集合与上页相同）→ 停止翻页并记录异常", async () => {
        const t = scriptedTransport([
            () => jsonBody({ errcode: 0, hasMore: 1, books: [nb("A", 100), nb("B", 90)] }),
            () => jsonBody({ errcode: 0, hasMore: 1, books: [nb("A", 100), nb("B", 90)] }),
        ]);
        const client = createWereadClient(t, KEY);
        const result = await client.listAllNotebooks();
        expect(result.books.map((b) => b.bookId)).toEqual(["A", "B"]);
        expect(result.anomalies.some((a) => a.includes("整页重复"))).toBe(true);
        expect(t.calls).toHaveLength(2);
    });

    it("同 bookId 不同载荷 → 保留首个并记 ambiguousId 异常", async () => {
        const t = scriptedTransport([
            () => jsonBody({ errcode: 0, hasMore: 1, books: [nb("A", 100, { book: { title: "第一版" } })] }),
            () => jsonBody({ errcode: 0, hasMore: 0, books: [nb("A", 100, { book: { title: "第二版" } }), nb("F", 90)] }),
        ]);
        const client = createWereadClient(t, KEY);
        const result = await client.listAllNotebooks();
        expect(result.books.map((b) => b.bookId)).toEqual(["A", "F"]);
        const aEntry = result.books.find((b) => b.bookId === "A");
        expect(aEntry?.title).toBe("第一版");
        expect(result.anomalies.some((a) => a.includes("ambiguousId") && a.includes("A"))).toBe(true);
    });

    it("必填 bookId 缺失 → 单页跳过该条并收集异常；totalBookCount 正常透传", async () => {
        const pageResponse = () =>
            jsonBody({
                errcode: 0,
                hasMore: 0,
                totalBookCount: 7,
                books: [{ book: { title: "没有ID的书" }, sort: 1 }, nb("X", 2)],
            });
        const t = scriptedTransport([pageResponse]);
        const client = createWereadClient(t, KEY);
        const page = await client.listNotebooksPage({ count: 20 });
        expect(page.books.map((b) => b.bookId)).toEqual(["X"]);
        expect(page.totalBookCount).toBe(7);
        expect(page.anomalies.some((a) => a.includes("bookId"))).toBe(true);
        // listAllNotebooks 同样透传该异常
        const t2 = scriptedTransport([pageResponse]);
        const all = await createWereadClient(t2, KEY).listAllNotebooks();
        expect(all.books.map((b) => b.bookId)).toEqual(["X"]);
        expect(all.anomalies.some((a) => a.includes("bookId"))).toBe(true);
    });

    it("maxPages 上限：达到上限仍有未读完数据 → PaginationAnomalyError，不把不完整结果当完整返回", async () => {
        const t = scriptedTransport(
            Array.from({ length: 10 }, (_, i) => () =>
                jsonBody({ errcode: 0, hasMore: 1, books: [nb(`b${i}`, 1000 - i * 10)] }),
            ),
        );
        const client = createWereadClient(t, KEY);
        const err = await client.listAllNotebooks(3).then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(PaginationAnomalyError);
        expect((err as PaginationAnomalyError).message).toContain("maxPages");
        expect(t.calls).toHaveLength(3);
    });

    it("listAllNotebooks 默认 maxPages=200 兜底（无 hasMore 时一页完成）", async () => {
        const t = scriptedTransport([
            () => jsonBody({ errcode: 0, hasMore: 0, books: [nb("A", 10)] }),
        ]);
        const client = createWereadClient(t, KEY);
        const result = await client.listAllNotebooks();
        expect(result.books).toHaveLength(1);
        expect(t.calls).toHaveLength(1);
    });

    it("官方契约：title/author 从 books[].book 嵌套对象读取，不被静默丢弃（PR8[3] 防回归）", async () => {
        const t = scriptedTransport([
            () =>
                jsonBody({
                    errcode: 0,
                    hasMore: 0,
                    books: [{ bookId: "A", book: { title: "Book A", author: "Author A" }, sort: 100 }],
                }),
        ]);
        const client = createWereadClient(t, KEY);
        const result = await client.listAllNotebooks();
        expect(result.anomalies).toEqual([]);
        const entry = result.books.find((b) => b.bookId === "A");
        expect(entry?.title).toBe("Book A");
        expect(entry?.author).toBe("Author A");
        // 元数据进入载荷指纹：同 ID 仅元数据不同也必须触发 ambiguousId 而非静默消失
        expect(result.books).toHaveLength(1);
    });

    it("嵌套与平铺同时出现 → 以官方契约的嵌套 book 对象为准", async () => {
        const t = scriptedTransport([
            () =>
                jsonBody({
                    errcode: 0,
                    hasMore: 0,
                    books: [{ bookId: "A", book: { title: "嵌套书名" }, title: "平铺书名", sort: 1 }],
                }),
        ]);
        const client = createWereadClient(t, KEY);
        const result = await client.listAllNotebooks();
        expect(result.books[0]?.title).toBe("嵌套书名");
    });

    it("回包仅有顶层平铺 title/author（兼容形态）→ 回退读取不丢弃", async () => {
        const t = scriptedTransport([
            () =>
                jsonBody({
                    errcode: 0,
                    hasMore: 0,
                    books: [{ bookId: "A", title: "平铺书名", author: "平铺作者", sort: 1 }],
                }),
        ]);
        const client = createWereadClient(t, KEY);
        const result = await client.listAllNotebooks();
        expect(result.books[0]?.title).toBe("平铺书名");
        expect(result.books[0]?.author).toBe("平铺作者");
    });
});
