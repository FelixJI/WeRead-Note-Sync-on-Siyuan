/**
 * T03 决策协议测试（Issue #4 AC1-AC5 核心语义；复用 T02 测试的 Fake 全家桶）。
 */
import { describe, expect, it } from "vitest";
import { SyncEngine, stripIal } from "../../src/sync/engine";
import { FakeKernel, FakeTransport, MemoryPersistence, fixture, type BookScript, type FakeBlock } from "../sync/engine.test";

const KEY = "wrk-test-key-0001";
const NS = "测试账号";
const SRC_H1 = `${NS}/10001/highlight/h1`;

function makeDeps(books: Record<string, BookScript>) {
    const transport = new FakeTransport(books);
    const kernel = new FakeKernel();
    const persistence = new MemoryPersistence();
    let seq = 0;
    const engine = new SyncEngine({
        persistence,
        kernel: kernel.call,
        transport,
        apiKey: KEY,
        accountNamespace: NS,
        now: () => "2026-11-03T00:00:00Z",
        newOpId: () => `op-${String((seq += 1)).padStart(4, "0")}`,
        projectOverview: false,
    });
    return { transport, kernel, persistence, engine };
}

function changeH1(books: Record<string, BookScript>, text: string): void {
    books["10001"]!.highlights = books["10001"]!.highlights.map((h) =>
        h.bookmarkId === "h1" ? { ...h, markText: text } : h,
    );
}

function kernel_doc(d: ReturnType<typeof makeDeps>): FakeBlock {
    const doc = d.kernel.allBlocks().find((b) => b.type === "d");
    if (doc === undefined) {
        throw new Error("doc 不存在");
    }
    return doc;
}

describe("T03 审阅队列与受控决策", () => {
    it("AC1：来源变化→队列呈现候选（remote-only，local 为块实况）", async () => {
        const books = fixture();
        const deps = makeDeps(books);
        await deps.engine.syncRound();
        changeH1(books, "给岁月以文明，而不是给文明以岁月");
        await deps.engine.syncRound();

        const queue = await deps.engine.buildReviewQueue();
        expect(queue).toHaveLength(1);
        const c = queue[0]!;
        expect(c.sourceKey).toBe(SRC_H1);
        expect(c.conflict).toBe("remote-only");
        expect(c.local).toBe("> 给岁月以文明");
        expect(c.remote).toContain("而不是给文明以岁月");
    });

    it("AC2：apply-remote 全协议——原 ID/身份保留、基线推进、下轮零候选", async () => {
        const books = fixture();
        const deps = makeDeps(books);
        await deps.engine.syncRound();
        changeH1(books, "给岁月以文明，而不是给文明以岁月");
        await deps.engine.syncRound();
        const queue = await deps.engine.buildReviewQueue();
        const before = deps.kernel.itemBlocks().find((b) => b.ial["custom-wrs-src"] === SRC_H1)!;
        const idBefore = before.id;

        const r = await deps.engine.applyDecision(SRC_H1, "apply-remote", undefined, queue[0]!.local);
        expect(r.ok).toBe(true);
        // 原位：同块 ID、身份保留、内容更新
        const after = deps.kernel.blocks.get(idBefore)!;
        expect(after.markdown).toBe("> 给岁月以文明，而不是给文明以岁月");
        expect(after.ial["custom-wrs-src"]).toBe(SRC_H1);
        // 基线推进：第三轮同数据零候选（不再打扰）
        const r3 = await deps.engine.syncRound();
        expect(r3.books[0]?.candidates).toBe(0);
        const queue3 = await deps.engine.buildReviewQueue();
        expect(queue3).toHaveLength(0);
    });

    it("AC4：决策后内容再变 → 过期计划拒绝应用，块保持手改内容", async () => {
        const books = fixture();
        const deps = makeDeps(books);
        await deps.engine.syncRound();
        changeH1(books, "远端新文本");
        await deps.engine.syncRound();
        const queue = await deps.engine.buildReviewQueue();
        // 决策后用户又编辑了块（快照过期）
        const block = deps.kernel.itemBlocks().find((b) => b.ial["custom-wrs-src"] === SRC_H1)!;
        block.markdown = "> 用户手改的最新内容";

        const r = await deps.engine.applyDecision(SRC_H1, "apply-remote", undefined, queue[0]!.local);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.kind).toBe("stale");
        }
        expect(block.markdown).toBe("> 用户手改的最新内容"); // 未被应用
        // 候选保留，重新审阅
        const queue2 = await deps.engine.buildReviewQueue();
        expect(queue2).toHaveLength(1);
        expect(queue2[0]!.conflict).toBe("both-changed");
    });

    it("AC3：keep-local——不写块、同远端版本下轮不再提示", async () => {
        const books = fixture();
        const deps = makeDeps(books);
        await deps.engine.syncRound();
        changeH1(books, "远端又一次变更");
        await deps.engine.syncRound();
        const queue = await deps.engine.buildReviewQueue();
        const blockBefore = deps.kernel.itemBlocks().find((b) => b.ial["custom-wrs-src"] === SRC_H1)!;
        const mdBefore = blockBefore.markdown;

        const r = await deps.engine.applyDecision(SRC_H1, "keep-local", undefined, queue[0]!.local);
        expect(r.ok).toBe(true);
        expect(blockBefore.markdown).toBe(mdBefore); // 块未动
        const r3 = await deps.engine.syncRound();
        expect(r3.books[0]?.candidates).toBe(0); // 同版本不重复打扰
        // 新的远端版本会重新出现
        changeH1(books, "更新一代的远端文本");
        const r4 = await deps.engine.syncRound();
        expect(r4.books[0]?.candidates).toBe(1);
    });

    it("save-copy——副本无规范身份属性、原块未动、下轮零候选", async () => {
        const books = fixture();
        const deps = makeDeps(books);
        await deps.engine.syncRound();
        changeH1(books, "要另存的远端文本");
        await deps.engine.syncRound();
        const queue = await deps.engine.buildReviewQueue();
        const original = deps.kernel.itemBlocks().find((b) => b.ial["custom-wrs-src"] === SRC_H1)!;

        const r = await deps.engine.applyDecision(SRC_H1, "save-copy", undefined, queue[0]!.local);
        expect(r.ok).toBe(true);
        const copies = deps.kernel.allBlocks().filter((b) => b.ial["custom-wrs-copy-of"] === SRC_H1);
        expect(copies).toHaveLength(1);
        expect(copies[0]!.ial["custom-wrs-src"]).toBeUndefined(); // 不建第二规范映射
        expect(original.markdown).toBe("> 给岁月以文明"); // 原块未动
        const r3 = await deps.engine.syncRound();
        expect(r3.books[0]?.candidates).toBe(0);
    });

    it("manual-merge——手动文本渲染写入、override 置位、下轮零候选", async () => {
        const books = fixture();
        const deps = makeDeps(books);
        await deps.engine.syncRound();
        changeH1(books, "远端第三版");
        await deps.engine.syncRound();
        const queue = await deps.engine.buildReviewQueue();
        const block = deps.kernel.itemBlocks().find((b) => b.ial["custom-wrs-src"] === SRC_H1)!;

        // 整改 B1 语义：manualText 即最终 markdown（UI 预填远端渲染文本，幂等确认）
        const r = await deps.engine.applyDecision(SRC_H1, "manual-merge", "> 我手动合并的最终文本", queue[0]!.local);
        expect(r.ok).toBe(true);
        expect(block.markdown).toBe("> 我手动合并的最终文本");
        expect(block.ial["custom-wrs-src"]).toBe(SRC_H1);
        const state = deps.persistence.store.get("book-10001") as {
            items: Record<string, { override: boolean }>;
        };
        expect(state.items[SRC_H1]?.override).toBe(true);
        const r3 = await deps.engine.syncRound();
        expect(r3.books[0]?.candidates).toBe(0);
    });

    it("AC4：更新中断（响应丢失）→ 下轮 reconcile 清除重议，候选保留", async () => {
        const books = fixture();
        const deps = makeDeps(books);
        await deps.engine.syncRound();
        changeH1(books, "会中断的更新");
        await deps.engine.syncRound();
        const queue = await deps.engine.buildReviewQueue();
        // failNext：更新请求未执行（未落地）
        deps.kernel.failNext.add("/api/block/updateBlock");

        const r = await deps.engine.applyDecision(SRC_H1, "apply-remote", undefined, queue[0]!.local);
        expect(r.ok).toBe(false);
        // 下一轮：pendingUpdate 未落地（before 保持）→ 清除重议；候选仍在
        const r2 = await deps.engine.syncRound();
        expect(r2.books[0]?.candidates).toBe(1);
        const queue2 = await deps.engine.buildReviewQueue();
        expect(queue2).toHaveLength(1);
    });

    it("AC4：更新落地但验证读失败 → 下轮 reconcile 收养（基线推进、候选清除）", async () => {
        const books = fixture();
        const deps = makeDeps(books);
        await deps.engine.syncRound();
        changeH1(books, "落地但验证失败的更新");
        await deps.engine.syncRound();
        const queue = await deps.engine.buildReviewQueue();
        // updateBlock 会成功；阻断协议步骤 4 的验证回读（本测试内第 2 次 getBlockKramdown）
        const block = deps.kernel.itemBlocks().find((b) => b.ial["custom-wrs-src"] === SRC_H1)!;
        deps.kernel.failReadAt.add(deps.kernel.readCount + 2); // 下一次=步骤2前置重读，再下一次=步骤4验证回读
        const r = await deps.engine.applyDecision(SRC_H1, "apply-remote", undefined, queue[0]!.local);
        expect(r.ok).toBe(false);
        // 块实际已更新
        expect(block.markdown).toContain("落地但验证失败");
        // 下一轮 reconcile：内容 == after → 收养
        const r2 = await deps.engine.syncRound();
        expect(r2.books[0]?.candidates).toBe(0);
        const state = deps.persistence.store.get("book-10001") as {
            items: Record<string, { localBaseline?: string; status: string }>;
        };
        expect(state.items[SRC_H1]?.status).toBe("active");
        expect(stripIal(state.items[SRC_H1]?.localBaseline ?? "")).toContain("落地但验证失败");
    });

    it("整改M2组合：更新落地+身份丢失+验证读失败 → 下轮收养分支拒绝（隔离而非当健康收养）", async () => {
        const books = fixture();
        const deps = makeDeps(books);
        await deps.engine.syncRound();
        changeH1(books, "组合故障文本");
        await deps.engine.syncRound();
        const queue = await deps.engine.buildReviewQueue();
        deps.kernel.dropIdentityOnUpdate = true;
        // 验证回读（步骤4）失败：决策流程内第 2 次 getBlockKramdown
        deps.kernel.failReadAt.add(deps.kernel.readCount + 2);
        const r = await deps.engine.applyDecision(SRC_H1, "apply-remote", undefined, queue[0]!.local);
        expect(r.ok).toBe(false);
        // 块内容已落地但身份属性丢失
        const block = deps.kernel.allBlocks().find((b) => b.markdown.includes("组合故障文本"))!;
        expect(block).toBeDefined();
        expect(block.ial["custom-wrs-src"]).toBeUndefined();
        // 下一轮 reconcile：内容==after 但身份缺失 → 不收养，隔离
        const r2 = await deps.engine.syncRound();
        expect(r2.books[0]?.quarantined).toBeGreaterThanOrEqual(1);
        const state = deps.persistence.store.get("book-10001") as {
            items: Record<string, { status: string }>;
        };
        expect(state.items[SRC_H1]?.status).toBe("quarantined");
    });

    it("整改M4：隔离态条目不入队列、决策被拒绝（防绕过多块歧义保护）", async () => {
        const books = fixture();
        const deps = makeDeps(books);
        await deps.engine.syncRound();
        changeH1(books, "会被隔离的变更");
        await deps.engine.syncRound(); // 候选正常落盘（pendingRemote 持久化）
        // 制造隔离+pendingRemote 共存的持久态：复制属性 → 下轮 audit 隔离（立即落盘），随后 fetchDetail 注入失败使轮早退（pendingRemote 保留）
        const doc = kernel_doc(deps);
        const h1 = deps.kernel.itemBlocks().find((b) => b.ial["custom-wrs-src"] === SRC_H1)!;
        const clone = { ...h1, id: "clone-x", ial: { ...h1.ial, id: "clone-x" }, children: [] as string[] };
        deps.kernel.blocks.set("clone-x", clone as typeof h1);
        doc.children.push("clone-x");
        // 下轮：audit 隔离（保存）→ fetchDetail 失败早退 → 持久态 = quarantined + pendingRemote
        const origPost = deps.transport.post.bind(deps.transport);
        let brokeFetch = false;
        deps.transport.post = async (url: string, body: unknown) => {
            const req = body as Record<string, unknown>;
            if (req.api_name === "/book/bookmarklist" && !brokeFetch) {
                brokeFetch = true;
                return { status: 200, body: JSON.stringify({ errcode: 0, updated: null }), contentType: "application/json" };
            }
            return origPost(url, body);
        };
        await deps.engine.syncRound();
        const state = deps.persistence.store.get("book-10001") as {
            items: Record<string, { status: string; pendingRemote?: unknown }>;
        };
        expect(state.items[SRC_H1]?.status).toBe("quarantined");
        expect(state.items[SRC_H1]?.pendingRemote).toBeDefined();
        // 队列不含隔离条目
        const queue = await deps.engine.buildReviewQueue();
        expect(queue.some((c) => c.sourceKey === SRC_H1)).toBe(false);
        // 决策被拒
        const r = await deps.engine.applyDecision(SRC_H1, "apply-remote", undefined, "whatever");
        expect(r.ok).toBe(false);
    });

    it("整改M5：文档确保失败轮 → 候选已落盘，队列可审", async () => {
        const books = fixture();
        const deps = makeDeps(books);
        await deps.engine.syncRound();
        // 制造文档属性歧义：删除原 doc 本身（条目块保留为可读孤儿），并放两份带相同
        // custom-wrs-book-id 的克隆 → state.docId 失效 → by-attr 命中 2 份 → 人工裁决错误
        const doc = kernel_doc(deps);
        const mkClone = (id: string): FakeBlock => ({ ...doc, id, ial: { ...doc.ial, id }, children: [] });
        deps.kernel.blocks.set("doc-clone-1", mkClone("doc-clone-1"));
        deps.kernel.blocks.set("doc-clone-2", mkClone("doc-clone-2"));
        deps.kernel.blocks.delete(doc.id);
        changeH1(books, "文档失败轮的变更");

        const r2 = await deps.engine.syncRound();
        expect(r2.books[0]?.error).toBeDefined(); // 文档歧义失败（人工裁决）
        // 候选已落盘（M5）：失败轮后队列仍可审
        const queue = await deps.engine.buildReviewQueue();
        expect(queue.some((c) => c.sourceKey === SRC_H1)).toBe(true);
    });

    it("回读验证失败（身份属性丢失）→ 隔离 + 快照留存，不自动补救", async () => {
        const books = fixture();
        const deps = makeDeps(books);
        await deps.engine.syncRound();
        changeH1(books, "会丢身份的更新");
        await deps.engine.syncRound();
        const queue = await deps.engine.buildReviewQueue();
        deps.kernel.dropIdentityOnUpdate = true;

        const r = await deps.engine.applyDecision(SRC_H1, "apply-remote", undefined, queue[0]!.local);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.kind).toBe("kernel");
            expect(r.message).toContain("隔离");
        }
        const state = deps.persistence.store.get("book-10001") as {
            items: Record<string, { status: string }>;
        };
        expect(state.items[SRC_H1]?.status).toBe("quarantined");
    });
});
