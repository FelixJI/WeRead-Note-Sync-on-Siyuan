/**
 * T06 写入端守卫——引擎级测试（审阅 B1/M1：生产路径真实锁语义）。
 */
import { describe, expect, it } from "vitest";
import { SyncEngine } from "../../src/sync/engine";
import { FakeKernel, FakeTransport, MemoryPersistence, fixture } from "./engine.test";
import {
    DocPathCollisionError,
    KernelApiError,
    SiyuanWriter,
    type KernelCallFn,
} from "../../src/adapters/siyuan/writer";

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

// ---------- PR9[5]：getBlockKramdown 三态（存在 / 确认不存在 / 瞬时错误） ----------

function makeReaderKernel(respFactory: () => unknown): KernelCallFn {
    return async () => respFactory();
}

describe("PR9[5] getBlockKramdown 三态语义", () => {
    it("存在：code 0 + kramdown 字符串 → 原样返回", async () => {
        const w = new SiyuanWriter(
            makeReaderKernel(() => ({ code: 0, msg: "", data: { kramdown: "> 正文 {: id=\"b-1\"}" } })),
        );
        expect(await w.getBlockKramdown("b-1")).toBe("> 正文 {: id=\"b-1\"}");
    });

    it("确认不存在（真实内核形态）：code 0 + 空串 kramdown → undefined", async () => {
        // 真实内核（v2.12.8/v3.0.0 kernel/api/block.go getBlockKramdown → model.GetBlockKramdown）
        // 对缺失块返回 code 0 且 kramdown 为空串，不是 code!=0
        const w = new SiyuanWriter(makeReaderKernel(() => ({ code: 0, msg: "", data: { kramdown: "" } })));
        expect(await w.getBlockKramdown("missing-1")).toBeUndefined();
    });

    it("确认不存在（测试 FakeKernel 契约形态）：code!=0 + 块不存在/not found 消息 → undefined", async () => {
        const a = new SiyuanWriter(makeReaderKernel(() => ({ code: -1, msg: "块不存在" })));
        expect(await a.getBlockKramdown("missing-2")).toBeUndefined();
        const b = new SiyuanWriter(makeReaderKernel(() => ({ code: -1, msg: "get block [missing-3] not found" })));
        expect(await b.getBlockKramdown("missing-3")).toBeUndefined();
    });

    it("瞬时错误：code!=0 且消息不含不存在特征 → 抛 KernelApiError（不得误判 user-deleted）", async () => {
        const w = new SiyuanWriter(
            makeReaderKernel(() => ({ code: -1, msg: "注入故障 /api/block/getBlockKramdown" })),
        );
        await expect(w.getBlockKramdown("b-2")).rejects.toBeInstanceOf(KernelApiError);
        const w2 = new SiyuanWriter(makeReaderKernel(() => ({ code: 3, msg: "内核索引重建中" })));
        await expect(w2.getBlockKramdown("b-2")).rejects.toBeInstanceOf(KernelApiError);
    });

    it("响应格式异常（code 0 但 data 无 kramdown 字符串）→ 抛错（无法确认存在性，保守失败）", async () => {
        const w = new SiyuanWriter(makeReaderKernel(() => ({ code: 0, msg: "", data: null })));
        await expect(w.getBlockKramdown("b-3")).rejects.toBeInstanceOf(KernelApiError);
        const w2 = new SiyuanWriter(makeReaderKernel(() => ({ code: 0, msg: "", data: { kramdown: 42 } })));
        await expect(w2.getBlockKramdown("b-3")).rejects.toBeInstanceOf(KernelApiError);
    });

    it("传输层异常（fn 抛错/响应非内核形状）→ 抛 KernelApiError", async () => {
        const w = new SiyuanWriter(makeReaderKernel(() => {
            throw new Error("network down");
        }));
        await expect(w.getBlockKramdown("b-4")).rejects.toBeInstanceOf(KernelApiError);
        const w2 = new SiyuanWriter(makeReaderKernel(() => "not a kernel response"));
        await expect(w2.getBlockKramdown("b-4")).rejects.toBeInstanceOf(KernelApiError);
    });
});

// ---------- PR9[3]：createBookDoc 同路径冲突守卫 ----------

interface FaithfulBlock {
    id: string;
    type: string;
    content: string;
    ial: Record<string, string>;
    rootId: string;
    children: string[];
}

/**
 * 路径忠实 FakeKernel：只实现 createBookDoc 守卫用到的端点，
 * 关键差异——createDocWithMd 对同 path 返回既有文档 ID（真实内核语义，
 * v3.0.0 kernel/model/path.go createDocsByHPath：GetBlockTreeRootByPath 命中即 retID=root.ID），
 * 而引擎测试的 FakeKernel 总是新建（评审 PR9[3] 指出该差异掩盖了同名冲突）。
 */
function makeFaithfulFileTreeKernel() {
    const blocks = new Map<string, FaithfulBlock>();
    const docsByPath = new Map<string, string>();
    let seq = 0;
    const call: KernelCallFn = async (path: string, data: unknown): Promise<unknown> => {
        const rec = data as Record<string, unknown>;
        switch (path) {
            case "/api/filetree/createDocWithMd": {
                const key = `${String(rec.notebook)}${String(rec.path)}`;
                const existing = docsByPath.get(key);
                if (existing !== undefined) {
                    return { code: 0, msg: "", data: existing };
                }
                seq += 1;
                const id = `doc-${String(seq).padStart(4, "0")}`;
                blocks.set(id, {
                    id,
                    type: "d",
                    content: String(rec.path).replace(/^\//u, ""),
                    ial: { id },
                    rootId: id,
                    children: [],
                });
                docsByPath.set(key, id);
                return { code: 0, msg: "", data: id };
            }
            case "/api/block/appendBlock": {
                seq += 1;
                const id = `b-${String(seq).padStart(4, "0")}`;
                const parent = blocks.get(String(rec.parentID));
                blocks.set(id, {
                    id,
                    type: "p",
                    content: String(rec.data),
                    ial: { id },
                    rootId: parent !== undefined ? parent.rootId : id,
                    children: [],
                });
                if (parent !== undefined) {
                    parent.children.push(id);
                }
                return { code: 0, msg: "", data: [{ doOperations: [{ action: "insert", id }] }] };
            }
            case "/api/attr/setBlockAttrs": {
                const block = blocks.get(String(rec.id));
                if (block !== undefined) {
                    Object.assign(block.ial, rec.attrs as Record<string, string>);
                }
                return { code: 0, msg: "", data: null };
            }
            case "/api/query/sql": {
                const sql = String(rec.sql);
                let m = sql.match(/^select id from blocks where root_id='([^']+)' and id != '([^']+)'$/u);
                if (m !== null) {
                    const rows = [...blocks.values()]
                        .filter((b) => b.rootId === m![1] && b.id !== m![2])
                        .map((b) => ({ id: b.id }));
                    return { code: 0, msg: "", data: rows };
                }
                m = sql.match(/^select id from blocks where id='([^']+)' and ial like/u);
                if (m !== null) {
                    const block = blocks.get(m[1]!);
                    const bound = block !== undefined && "custom-wrs-book-id" in block.ial;
                    return { code: 0, msg: "", data: bound ? [{ id: block!.id }] : [] };
                }
                return { code: 0, msg: "", data: [] };
            }
            default:
                throw new Error(`路径忠实 FakeKernel 未实现 ${path}`);
        }
    };
    return { blocks, call };
}

describe("PR9[3] createBookDoc 同路径冲突守卫", () => {
    it("正常首次创建（新文档空且无身份）→ 返回新文档 ID", async () => {
        const fake = makeFaithfulFileTreeKernel();
        const w = new SiyuanWriter(fake.call);
        const id = await w.createBookDoc("nb-1", "三体");
        expect(id).toMatch(/^doc-\d{4}$/u);
    });

    it("同名第二本书：真实内核同 path 交回既有非空文档 → 抛 DocPathCollisionError，不返回可被改绑的 ID", async () => {
        const fake = makeFaithfulFileTreeKernel();
        const w = new SiyuanWriter(fake.call);
        // 第一本书：建文档 + 骨架子块 + 绑定身份（与引擎 #ensureDoc 时序一致）
        const firstId = await w.createBookDoc("nb-1", "三体");
        await w.appendChildBlock("## ✂️ 摘录", firstId);
        await w.setBlockAttrs(firstId, { "custom-wrs-book-id": "10001" });

        // 第二本书同名：真实内核 createDocWithMd 同 path 返回既有文档 ID（code 0）
        await expect(w.createBookDoc("nb-1", "三体")).rejects.toBeInstanceOf(DocPathCollisionError);
        // 第一本书的文档身份未被触碰（若放行该 ID，#ensureDoc 随后的 setBlockAttrs 会改绑它）
        expect(fake.blocks.get(firstId)?.ial["custom-wrs-book-id"]).toBe("10001");
    });

    it("同 path 既有文档为空但已被他书绑定 → 同样拒绝（防空文档身份被改绑）", async () => {
        const fake = makeFaithfulFileTreeKernel();
        const w = new SiyuanWriter(fake.call);
        const firstId = await w.createBookDoc("nb-1", "活着");
        await w.setBlockAttrs(firstId, { "custom-wrs-book-id": "20001" }); // 空文档但已绑定
        await expect(w.createBookDoc("nb-1", "活着")).rejects.toBeInstanceOf(DocPathCollisionError);
    });

    it("创建窗口遗留的同 path 空且无主文档 → 允许接管（返回该 ID 供调用方补身份）", async () => {
        const fake = makeFaithfulFileTreeKernel();
        const w = new SiyuanWriter(fake.call);
        const orphanId = await w.createBookDoc("nb-1", "围城"); // 建后中断：无子块、无 custom 属性
        const adopted = await w.createBookDoc("nb-1", "围城");
        expect(adopted).toBe(orphanId);
    });
});
