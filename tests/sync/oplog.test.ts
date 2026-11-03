import { describe, expect, it } from "vitest";
import { OpLog, type OpLogEntry } from "../../src/sync/oplog";

// 确定性：ts 由测试给定，无随机、无时间依赖。

function baseEntry(opId: string): Omit<OpLogEntry, "status"> {
    return {
        opId,
        ts: "2026-01-01T00:00:00Z",
        intent: "create-block",
        sourceKey: "ns/book/highlight/bm-1",
        payloadText: "> 文本",
    };
}

function recorder(): { persisted: OpLogEntry[][]; persist: (es: OpLogEntry[]) => Promise<void> } {
    const persisted: OpLogEntry[][] = [];
    return {
        persisted,
        persist: async (es) => {
            persisted.push(es);
        },
    };
}

describe("OpLog append/complete/fail", () => {
    it("append 补默认 status=pending，返回完整条目并持久化", async () => {
        const rec = recorder();
        const log = new OpLog(rec.persist, []);
        const e = await log.append(baseEntry("op-1"));
        expect(e.opId).toBe("op-1");
        expect(e.status).toBe("pending");
        expect(e.intent).toBe("create-block");
        expect(log.entries()).toHaveLength(1);
        expect(log.entries()[0].status).toBe("pending");
        expect(log.pending()).toHaveLength(1);
        expect(rec.persisted).toHaveLength(1);
        expect(rec.persisted[0]).toHaveLength(1);
        expect(rec.persisted[0][0].opId).toBe("op-1");
    });

    it("append 显式 status=done 时保留调用方给定值", async () => {
        const rec = recorder();
        const log = new OpLog(rec.persist, []);
        const e = await log.append({ ...baseEntry("op-1"), status: "done" });
        expect(e.status).toBe("done");
        expect(log.pending()).toHaveLength(0);
    });

    it("complete → status=done 并落 blockId，持久化收到更新后的数组", async () => {
        const rec = recorder();
        const log = new OpLog(rec.persist, []);
        await log.append(baseEntry("op-1"));
        await log.complete("op-1", { blockId: "20260101120000-abc" });
        const entry = log.entries()[0];
        expect(entry.status).toBe("done");
        expect(entry.blockId).toBe("20260101120000-abc");
        expect(log.pending()).toHaveLength(0);
        const last = rec.persisted[rec.persisted.length - 1];
        expect(last).toHaveLength(1);
        expect(last[0].status).toBe("done");
    });

    it("complete 携带 error → status=failed", async () => {
        const rec = recorder();
        const log = new OpLog(rec.persist, []);
        await log.append(baseEntry("op-1"));
        await log.complete("op-1", { blockId: "b1", error: "内核 500" });
        const entry = log.entries()[0];
        expect(entry.status).toBe("failed");
        expect(entry.error).toBe("内核 500");
        expect(entry.blockId).toBe("b1");
    });

    it("fail → status=failed + error", async () => {
        const rec = recorder();
        const log = new OpLog(rec.persist, []);
        await log.append(baseEntry("op-1"));
        await log.fail("op-1", "插入块失败");
        expect(log.entries()[0].status).toBe("failed");
        expect(log.entries()[0].error).toBe("插入块失败");
        expect(log.pending()).toHaveLength(0);
    });

    it("未知 opId：complete/fail 均 throw", async () => {
        const log = new OpLog(async () => {}, []);
        await log.append(baseEntry("op-1"));
        await expect(log.complete("nope", {})).rejects.toThrow(/opId/);
        await expect(log.fail("nope", "x")).rejects.toThrow(/opId/);
    });

    it("initial 载入：entries/pending 正确反映初值", async () => {
        const initial: OpLogEntry[] = [
            { ...baseEntry("op-1"), status: "done", blockId: "b1" },
            { ...baseEntry("op-2"), status: "pending" },
        ];
        const log = new OpLog(async () => {}, initial);
        expect(log.entries()).toHaveLength(2);
        expect(log.pending().map((e) => e.opId)).toEqual(["op-2"]);
    });
});

describe("OpLog 环形上限", () => {
    it("默认上限 500：超限丢最旧", async () => {
        const rec = recorder();
        const log = new OpLog(rec.persist, []);
        for (let i = 0; i < 503; i += 1) {
            await log.append(baseEntry(`op-${i}`));
        }
        expect(log.entries()).toHaveLength(500);
        expect(log.entries()[0].opId).toBe("op-3");
        expect(log.entries()[499].opId).toBe("op-502");
    });

    it("自定义上限：append 超限丢最旧且持久化回调收到新数组", async () => {
        const rec = recorder();
        const log = new OpLog(rec.persist, [], 3);
        for (const id of ["op-1", "op-2", "op-3"]) {
            await log.append(baseEntry(id));
        }
        expect(log.entries().map((e) => e.opId)).toEqual(["op-1", "op-2", "op-3"]);
        await log.append(baseEntry("op-4"));
        expect(log.entries().map((e) => e.opId)).toEqual(["op-2", "op-3", "op-4"]);
        // 每次变更都触发持久化，且收到的是新数组（非同一引用）
        expect(rec.persisted).toHaveLength(4);
        const last = rec.persisted[3];
        expect(last.map((e) => e.opId)).toEqual(["op-2", "op-3", "op-4"]);
        expect(last).not.toBe(log.entries());
    });

    it("complete/fail 后仍持久化（环形内不变长）", async () => {
        const rec = recorder();
        const log = new OpLog(rec.persist, [], 2);
        await log.append(baseEntry("op-1"));
        await log.append(baseEntry("op-2"));
        await log.fail("op-1", "失败");
        expect(rec.persisted).toHaveLength(3);
        expect(rec.persisted[2].map((e) => e.status)).toEqual(["failed", "pending"]);
    });
});
