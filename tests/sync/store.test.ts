/**
 * 双世代状态存储测试（审阅整改 M1/m4）。
 * 重点：损坏的当前世代绝不允许覆盖完好的 .prev（AC7 最后有效世代保护）。
 */
import { describe, expect, it } from "vitest";
import { GenerationStore, StateCorruptionError } from "../../src/sync/state/store";
import type { StatePersistence } from "../../src/sync/state/store";

interface TestState {
    schemaVersion: number;
    tag: string;
}

function makePersistence(initial: Record<string, unknown> = {}): StatePersistence & { store: Map<string, unknown> } {
    const store = new Map<string, unknown>(Object.entries(initial));
    return {
        store,
        async load(name) {
            return store.get(name) ?? null;
        },
        async save(name, content) {
            store.set(name, content);
        },
    };
}

const isValid = (v: unknown): boolean => {
    if (typeof v !== "object" || v === null) {
        return false;
    }
    return typeof (v as Record<string, unknown>).tag === "string";
};

describe("GenerationStore 双世代", () => {
    it("save → load 往返；第二次 save 把第一代晋升为 .prev", async () => {
        const p = makePersistence();
        const store = new GenerationStore<TestState>(p, "s", isValid);
        await store.save({ schemaVersion: 1, tag: "a" });
        await store.save({ schemaVersion: 1, tag: "b" });
        expect((await store.load())?.tag).toBe("b");
        expect((p.store.get("s.prev") as TestState).tag).toBe("a");
    });

    it("M1：当前世代损坏、.prev 完好 → load 回退 .prev；save 不得用损坏值覆盖 .prev", async () => {
        const p = makePersistence({
            s: { schemaVersion: 1, tag: "好的第一代" },
        });
        const store = new GenerationStore<TestState>(p, "s", isValid);
        await store.save({ schemaVersion: 1, tag: "好的第二代" });
        // 模拟当前世代写坏（.prev 仍是好的第一代）
        p.store.set("s", "不是对象 garbage");
        expect((await store.load())?.tag).toBe("好的第一代");
        // save：当前损坏 → 不晋升；.prev 必须保持完好
        await store.save({ schemaVersion: 1, tag: "第三代" });
        expect((p.store.get("s.prev") as TestState).tag).toBe("好的第一代");
        expect((await store.load())?.tag).toBe("第三代");
    });

    it("两级都坏 → StateCorruptionError（保护模式信号）", async () => {
        const p = makePersistence({ s: 42, "s.prev": null });
        const store = new GenerationStore<TestState>(p, "s", isValid);
        await expect(store.load()).rejects.toBeInstanceOf(StateCorruptionError);
    });

    it("m4：带 schemaVersion 但结构无效的当前世代 → 按无效处理并回退 .prev", async () => {
        const p = makePersistence({
            s: { schemaVersion: 1, tag: "结构完好" },
        });
        const store = new GenerationStore<TestState>(p, "s", isValid);
        await store.save({ schemaVersion: 1, tag: "二代" });
        p.store.set("s", { schemaVersion: 1, noTag: true }); // 有版本号但缺字段
        expect((await store.load())?.tag).toBe("结构完好");
    });

    it("存储缺失 → undefined（首次运行语义，不是损坏）", async () => {
        const store = new GenerationStore<TestState>(makePersistence(), "s", isValid);
        expect(await store.load()).toBeUndefined();
    });
});
