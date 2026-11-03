import { describe, expect, it } from "vitest";
import { testConnection } from "../../src/core/connection-test";
import type { NotebooksPage, NotebookSummaryEntry } from "../../src/adapters/weread/types";
import type { WereadClient } from "../../src/adapters/weread/client";
import { InvalidWereadApiKeyError } from "../../src/adapters/weread/client";
import { AuthError, GatewayError, TransportError, UpgradeRequiredError } from "../../src/adapters/weread/gateway";
import { PaginationAnomalyError } from "../../src/adapters/weread/pagers";

const LEAK = "wrk-leak12345";

function okPage(books: NotebookSummaryEntry[], totalBookCount?: number): NotebooksPage {
    return totalBookCount === undefined
        ? { books, hasMore: false, anomalies: [] }
        : { books, hasMore: false, totalBookCount, anomalies: [] };
}

function mockClient(
    impl: (params?: { count?: number; lastSort?: number }) => Promise<NotebooksPage>,
): WereadClient & { calls: Array<{ count?: number; lastSort?: number } | undefined> } {
    const calls: Array<{ count?: number; lastSort?: number } | undefined> = [];
    return {
        calls,
        async listNotebooksPage(params) {
            calls.push(params);
            return impl(params);
        },
        async listAllNotebooks() {
            throw new Error("连接测试不应调用 listAllNotebooks");
        },
    };
}

function failClient(e: () => Promise<never>): WereadClient {
    return mockClient(() => e());
}

describe("连接测试", () => {
    it("成功路径：以 count=1 只读探测，返回 totalBookCount 与计时", async () => {
        const client = mockClient(async () => okPage([{ bookId: "b1" }], 42));
        const result = await testConnection(client);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.totalBookCount).toBe(42);
            expect(typeof result.elapsedMs).toBe("number");
            expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
        }
        expect(client.calls).toEqual([{ count: 1 }]);
    });

    it("成功但无 totalBookCount 时不携带该字段", async () => {
        const client = mockClient(async () => okPage([]));
        const result = await testConnection(client);
        expect(result).toEqual({ ok: true, elapsedMs: expect.any(Number) });
    });

    it("AuthError → kind=auth，消息为中文且脱敏", async () => {
        const client = failClient(() => Promise.reject(new AuthError(`鉴权失败 ${LEAK}`, 401)));
        const result = await testConnection(client);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.kind).toBe("auth");
            expect(result.message).not.toContain(LEAK);
            expect(result.message).toContain("鉴权");
            expect(result.message.length).toBeLessThanOrEqual(500);
        }
    });

    it("TransportError → kind=network", async () => {
        const client = failClient(() => Promise.reject(new TransportError(`超时 ${LEAK}`, 504)));
        const result = await testConnection(client);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.kind).toBe("network");
            expect(result.message).not.toContain(LEAK);
        }
    });

    it("UpgradeRequiredError → kind=upgrade，包含服务端消息（脱敏）", async () => {
        const client = failClient(
            () => Promise.reject(new UpgradeRequiredError("需升级", 0, `请升级插件 ${LEAK}`)),
        );
        const result = await testConnection(client);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.kind).toBe("upgrade");
            expect(result.message).toContain("请升级插件");
            expect(result.message).not.toContain(LEAK);
        }
    });

    it("GatewayError → kind=gateway，含 errcode", async () => {
        const client = failClient(() => Promise.reject(new GatewayError("系统繁忙", 5001)));
        const result = await testConnection(client);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.kind).toBe("gateway");
            expect(result.message).toContain("5001");
        }
    });

    it("InvalidWereadApiKeyError → kind=invalid-key", async () => {
        const client = failClient(() => Promise.reject(new InvalidWereadApiKeyError("Key 格式不正确")));
        const result = await testConnection(client);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.kind).toBe("invalid-key");
            expect(result.message).toContain("wrk-");
        }
    });

    it("PaginationAnomalyError → kind=gateway（数据异常防御映射）", async () => {
        const client = failClient(
            () => Promise.reject(new PaginationAnomalyError(`游标循环 ${LEAK}`, ["游标循环"])),
        );
        const result = await testConnection(client);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.kind).toBe("gateway");
            expect(result.message).not.toContain(LEAK);
        }
    });

    it("未知异常 → kind=network，不泄露 Key", async () => {
        const client = failClient(() => Promise.reject(new Error(`未知错误 ${LEAK}`)));
        const result = await testConnection(client);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.kind).toBe("network");
            expect(result.message).not.toContain(LEAK);
        }
    });
});
