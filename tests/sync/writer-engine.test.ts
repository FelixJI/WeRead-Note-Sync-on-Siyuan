/**
 * T06 写入端守卫——引擎级测试（审阅 B1/M1：生产路径真实锁语义）。
 */
import { describe, expect, it } from "vitest";
import { SyncEngine } from "../../src/sync/engine";
import { FakeKernel, FakeTransport, MemoryPersistence, fixture } from "./engine.test";

const KEY = "wrk-test-key-0001";
const NS = "测试账号";

function makeDeps(identity: { writerId: string; label: string }) {
    const transport = new FakeTransport(fixture());
    const kernel = new FakeKernel();
    const persistence = new MemoryPersistence();
    const engine = new SyncEngine({
        persistence,
        kernel: kernel.call,
        transport,
        apiKey: KEY,
        accountNamespace: NS,
        now: () => "2026-11-03T12:00:00Z",
        newOpId: () => "op-w1",
        writerIdentity: identity,
    });
    return { kernel, persistence, engine };
}

const SELF = { writerId: "w-self", label: "桌面端" };
const OTHER = { writerId: "w-other", label: "浏览器端" };

function makeDepsShared(
    persistence: MemoryPersistence,
    kernel: FakeKernel,
    identity: { writerId: string; label: string },
) {
    const transport = new FakeTransport(fixture());
    const engine = new SyncEngine({
        persistence,
        kernel: kernel.call,
        transport,
        apiKey: KEY,
        accountNamespace: NS,
        now: () => "2026-11-03T12:00:00Z",
        newOpId: () => "op-w2",
        writerIdentity: identity,
    });
    return { kernel, persistence, engine };
}

describe("T06 写入端守卫（引擎级）", () => {
    it("同一持久身份连续两轮同步正常（B1：不得自锁）", async () => {
        const { engine, kernel } = makeDeps(SELF);
        const r1 = await engine.syncRound();
        const r2 = await engine.syncRound();
        expect(r1.ok).toBe(true);
        expect(r2.ok).toBe(true);
        expect(r2.takeoverNotice).toBeUndefined();
        expect(kernel.itemBlocks().length).toBe(5);
    });

    it("他端租约活跃 → 整轮停写（零内核写入）并说明持有者", async () => {
        const a = makeDeps(SELF);
        await a.engine.syncRound(); // 认领
        const before = a.kernel.allBlocks().length;
        // 共享同一持久化与内核的另一端
        const b = makeDepsShared(a.persistence, a.kernel, OTHER);
        const r = await b.engine.syncRound();
        expect(r.ok).toBe(false);
        expect(r.abortedReason).toContain("桌面端");
        expect(a.kernel.allBlocks().length).toBe(before); // 零写入
    });

    it("他端租约过期 → 显式接管（takeoverNotice 可追溯）", async () => {
        const a = makeDeps(SELF);
        await a.engine.syncRound();
        // 时间推进 31 分钟（now 钩子注入）
        const transport = new FakeTransport(fixture());
        const persistence = a.persistence;
        let seq = 0;
        const engine2 = new SyncEngine({
            persistence,
            kernel: a.kernel.call,
            transport,
            apiKey: KEY,
            accountNamespace: NS,
            now: () => "2026-11-03T12:31:00Z",
            newOpId: () => `op-t${(seq += 1)}`,
            writerIdentity: OTHER,
        });
        const r = await engine2.syncRound();
        expect(r.ok).toBe(true);
        expect(r.takeoverNotice).toContain("接管");
    });

    it("决策写入路径同样受守卫约束（他端活跃 → applyDecision 拒绝）", async () => {
        const a = makeDeps(SELF);
        await a.engine.syncRound();
        // 直接注入 pendingRemote（模拟待审候选存在的持久态）
        const st = a.persistence.store.get("book-10001") as {
            items: Record<string, { pendingRemote?: unknown }>;
        };
        st.items["测试账号/10001/highlight/h1"]!.pendingRemote = {
            renderedText: "> 新文本",
            fingerprint: "fp-2",
            payload: {},
            detectedAt: "t",
        };
        const b = makeDepsShared(a.persistence, a.kernel, OTHER);
        const r = await b.engine.applyDecision("测试账号/10001/highlight/h1", "keep-local", undefined, "x");
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.message).toContain("只读");
        }
        // SELF 端自身不受阻
        const r2 = await a.engine.applyDecision("测试账号/10001/highlight/h1", "keep-local", undefined, "> 旧");
        expect(r2.ok).toBe(true);
    });

    it("releaseWriter：停用即释放，他端立即可接管", async () => {
        const a = makeDeps(SELF);
        await a.engine.syncRound();
        await a.engine.releaseWriter();
        const b = makeDeps(OTHER);
        const r = await b.engine.syncRound();
        expect(r.ok).toBe(true);
        expect(r.takeoverNotice).toBeUndefined(); // 无租约=直接认领，非接管
    });
});
