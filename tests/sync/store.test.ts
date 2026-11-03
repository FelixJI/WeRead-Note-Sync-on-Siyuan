/**
 * 双世代状态存储测试（审阅整改 M1/m4 + PR9[2]）。
 * 重点：损坏的当前世代绝不允许覆盖完好的 .prev（AC7 最后有效世代保护）；
 * 读失败必须与"无数据（首次）"区分，绝不静默走重建路径（否则丢 tombstone）。
 *
 * 注：src/sync/runtime.ts（createPluginPersistence 去吞错）无法直接单测——
 * "siyuan" 包仅含类型声明（types-only exports），vite 无法解析其运行时入口，
 * 且共享 vitest 配置不得改动（AGENTS.md 工程约定）；该层修复为纯删除 catch，
 * 其"读失败穿透 → GenerationStore 判保护模式"的语义由本文件覆盖。
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

/** 指定名字读取抛错、其余正常的持久化（PR9[2]：模拟插件存储 IO 故障）。 */
function makeFlakyLoadPersistence(
    initial: Record<string, unknown>,
    failNames: string[],
): StatePersistence & { store: Map<string, unknown> } {
    const base = makePersistence(initial);
    return {
        store: base.store,
        async load(name) {
            if (failNames.includes(name)) {
                throw new Error(`读取失败 ${name}`);
            }
            return base.load(name);
        },
        async save(name, content) {
            await base.save(name, content);
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

describe("PR9[2] 读失败与无数据（首次）区分", () => {
    it("当前世代读取抛错、.prev 完好 → 回退 .prev（读失败不当损坏也不当首次）", async () => {
        const p = makeFlakyLoadPersistence(
            { s: { schemaVersion: 1, tag: "一代" }, "s.prev": { schemaVersion: 1, tag: "零代" } },
            ["s"],
        );
        const store = new GenerationStore<TestState>(p, "s", isValid);
        expect((await store.load())?.tag).toBe("零代");
    });

    it("双世代读取均抛错 → StateCorruptionError（保护模式，绝不静默当首次初始化）", async () => {
        const p = makeFlakyLoadPersistence({}, ["s", "s.prev"]);
        const store = new GenerationStore<TestState>(p, "s", isValid);
        await expect(store.load()).rejects.toBeInstanceOf(StateCorruptionError);
    });

    it("当前世代读取抛错且无 .prev → StateCorruptionError（读失败 ≠ 首次，防重建丢 tombstone）", async () => {
        const p = makeFlakyLoadPersistence({}, ["s"]);
        const store = new GenerationStore<TestState>(p, "s", isValid);
        await expect(store.load()).rejects.toBeInstanceOf(StateCorruptionError);
    });

    it("当前世代缺失（真无数据）、.prev 读取抛错 → StateCorruptionError（无法确认可重建）", async () => {
        const p = makeFlakyLoadPersistence({ "s.prev": { schemaVersion: 1, tag: "零代" } }, ["s.prev"]);
        const store = new GenerationStore<TestState>(p, "s", isValid);
        await expect(store.load()).rejects.toBeInstanceOf(StateCorruptionError);
    });

    it("save：当前世代读取抛错 → 不晋升 .prev（保住最后有效代），新值照写当前世代", async () => {
        const p = makePersistence({ s: { schemaVersion: 1, tag: "好的第一代" } });
        const store = new GenerationStore<TestState>(p, "s", isValid);
        await store.save({ schemaVersion: 1, tag: "二代" }); // s.prev = 好的第一代
        // 当前世代此后读取抛错（IO 故障）：save 不得晋升未知内容、也不得失败
        const flaky = makeFlakyLoadPersistence(
            Object.fromEntries(p.store.entries()),
            ["s"],
        );
        const store2 = new GenerationStore<TestState>(flaky, "s", isValid);
        await store2.save({ schemaVersion: 1, tag: "三代" });
        expect((flaky.store.get("s.prev") as TestState).tag).toBe("好的第一代");
        expect((flaky.store.get("s") as TestState).tag).toBe("三代");
    });
});
