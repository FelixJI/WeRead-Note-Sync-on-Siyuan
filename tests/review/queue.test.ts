/**
 * 审阅会话队列测试（PR10[2] 决策快照纪律 + PR10[5] 手工合并幂等回归）。
 *
 * 复用 T02/T03 测试的 Fake 全家桶；只覆盖 src/review/queue.ts 会话层与
 * src/review/ui/view-model.ts 的 UI 契约（预填/快照随决策携带），
 * engine 决策协议本体见 tests/review/decisions.test.ts。
 */
import { describe, expect, it } from "vitest";
import { SyncEngine } from "../../src/sync/engine";
import {
    FakeKernel,
    FakeTransport,
    MemoryPersistence,
    fixture,
    type BookScript,
    type FakeBlock,
    type RawReview,
} from "../sync/engine.test";
import { applyDecision, buildReviewQueue, initReviewSession } from "../../src/review/queue";
import { toItemView } from "../../src/review/ui/view-model";

const KEY = "wrk-test-key-0001";
const NS = "测试账号";
const SRC_H1 = `${NS}/10001/highlight/h1`;
const SRC_H3 = `${NS}/10001/highlight/h3`;
const SRC_R1 = `${NS}/10001/review/r1`;

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

function changeHighlight(books: Record<string, BookScript>, id: string, text: string): void {
    books["10001"]!.highlights = books["10001"]!.highlights.map((h) =>
        h.bookmarkId === id ? { ...h, markText: text } : h,
    );
}

function changeReview(books: Record<string, BookScript>, id: string, content: string): void {
    books["10001"]!.reviews = books["10001"]!.reviews.map((r: RawReview) =>
        r.review.reviewId === id ? { ...r, review: { ...r.review, content } } : r,
    );
}

function blockOf(deps: ReturnType<typeof makeDeps>, sourceKey: string): FakeBlock {
    const block = deps.kernel.itemBlocks().find((b) => b.ial["custom-wrs-src"] === sourceKey);
    if (block === undefined) {
        throw new Error(`块不存在 ${sourceKey}`);
    }
    return block;
}

/** 构造两个 both-changed 候选（本地块手改 + 远端文本变化）。 */
async function setupTwoCandidates(): Promise<ReturnType<typeof makeDeps>> {
    const books = fixture();
    const deps = makeDeps(books);
    await deps.engine.syncRound();
    changeHighlight(books, "h1", "远端新文一");
    changeHighlight(books, "h3", "远端新文三");
    // 两个条目都本地变更（both-changed）
    blockOf(deps, SRC_H1).markdown = "> 本地改动一";
    blockOf(deps, SRC_H3).markdown = "> 本地改动三";
    await deps.engine.syncRound();
    initReviewSession({ engine: deps.engine });
    const q = await buildReviewQueue();
    const h1 = q.items.find((i) => i.sourceKey === SRC_H1);
    const h3 = q.items.find((i) => i.sourceKey === SRC_H3);
    if (h1 === undefined || h3 === undefined) {
        throw new Error("候选构造失败");
    }
    return deps;
}

describe("审阅会话队列：决策快照纪律（PR10[2]）", () => {
    it("refreshItem 重建队列不得替换无关条目的展示快照——第二条决策以展示时快照判定为过期", async () => {
        const deps = await setupTwoCandidates();
        const q = await buildReviewQueue();
        const viewH1 = q.items.find((i) => i.sourceKey === SRC_H1)!;
        const viewH3 = q.items.find((i) => i.sourceKey === SRC_H3)!;

        // 展示之后、决策之前：两个块又被编辑（用户在对话框外继续修改）
        blockOf(deps, SRC_H1).markdown = "> 中间编辑一";
        blockOf(deps, SRC_H3).markdown = "> 中间编辑三";

        // 第一条决策（携带展示时快照）→ 过期；UI 随后 refreshItem → 会话层重建整队
        const r1 = await applyDecision(SRC_H1, "apply-remote", undefined, {
            local: viewH1.local,
            remoteFingerprint: viewH1.remoteFingerprint,
        });
        expect(r1.ok).toBe(false);
        if (!r1.ok) {
            expect(r1.kind).toBe("stale");
        }
        await buildReviewQueue(); // refreshItem 的会话层效果（重建整个队列）

        // 第二条决策：必须仍以"展示时快照"锚定 → 过期拒绝；
        // 不得用队列重建刷新出的新缓存通过过期检查、静默覆盖中间编辑
        const r3 = await applyDecision(SRC_H3, "apply-remote", undefined, {
            local: viewH3.local,
            remoteFingerprint: viewH3.remoteFingerprint,
        });
        expect(r3.ok).toBe(false);
        if (!r3.ok) {
            expect(r3.kind).toBe("stale");
        }
        expect(blockOf(deps, SRC_H3).markdown).toBe("> 中间编辑三"); // 中间编辑未被静默覆盖
    });

    it("队列重建不得覆盖存活条目的缓存快照（无显式快照时以首次展示值为准，宁可过期拒绝）", async () => {
        const deps = await setupTwoCandidates();
        // 展示之后、队列重建之前：块 3 被继续编辑
        blockOf(deps, SRC_H3).markdown = "> 中间编辑三";
        await buildReviewQueue(); // 重建（refreshItem / 手动刷新触发）

        const r3 = await applyDecision(SRC_H3, "apply-remote"); // 未携带显式快照 → 会话缓存兜底
        expect(r3.ok).toBe(false);
        if (!r3.ok) {
            expect(r3.kind).toBe("stale");
        }
        expect(blockOf(deps, SRC_H3).markdown).toBe("> 中间编辑三");
    });

    it("展示快照与现状一致 → 决策正常应用并清理缓存", async () => {
        const books = fixture();
        const deps = makeDeps(books);
        await deps.engine.syncRound();
        changeHighlight(books, "h1", "远端新文一");
        await deps.engine.syncRound();
        initReviewSession({ engine: deps.engine });
        const q = await buildReviewQueue();
        const view = q.items.find((i) => i.sourceKey === SRC_H1)!;

        const r = await applyDecision(SRC_H1, "apply-remote", undefined, {
            local: view.local,
            remoteFingerprint: view.remoteFingerprint,
        });
        expect(r.ok).toBe(true);
        expect(blockOf(deps, SRC_H1).markdown).toBe("> 远端新文一");
        const r3 = await deps.engine.syncRound();
        expect(r3.books[0]?.candidates).toBe(0); // 候选已清理
    });
});

describe("审阅会话队列：手工合并预填幂等（PR10[5] 回归）", () => {
    it("预填远端渲染文本→确认：落块与预填逐字一致，无二次前缀（highlight 与 review）", async () => {
        const books = fixture();
        const deps = makeDeps(books);
        await deps.engine.syncRound();
        changeHighlight(books, "h1", "远端第三版");
        changeReview(books, "r1", "新想法内容");
        await deps.engine.syncRound();
        initReviewSession({ engine: deps.engine });
        const q = await buildReviewQueue();

        // highlight：预填 = item.remote（renderHighlightBlock 输出 `> 文本`）
        const hv = q.items.find((i) => i.sourceKey === SRC_H1)!;
        const hView = toItemView(hv);
        expect(hView.manualText).toBe(hv.remote); // 预填契约：编辑器初始值为远端渲染文本
        expect(hView.manualText.startsWith("> ")).toBe(true);
        const hr = await applyDecision(SRC_H1, "manual-merge", hView.manualText, {
            local: hv.local,
            remoteFingerprint: hv.remoteFingerprint,
        });
        expect(hr.ok).toBe(true);
        expect(blockOf(deps, SRC_H1).markdown).toBe(hv.remote); // 幂等：无 "> \> " 双重前缀
        expect(blockOf(deps, SRC_H1).markdown).not.toContain("\\>");

        // review：预填 = item.remote（renderReviewChild 输出 `- 💭 文本`）
        const rv = q.items.find((i) => i.sourceKey === SRC_R1)!;
        const rView = toItemView(rv);
        expect(rView.manualText.startsWith("- 💭 ")).toBe(true);
        const rr = await applyDecision(SRC_R1, "manual-merge", rView.manualText, {
            local: rv.local,
            remoteFingerprint: rv.remoteFingerprint,
        });
        expect(rr.ok).toBe(true);
        expect(blockOf(deps, SRC_R1).markdown).toBe(rv.remote); // 幂等：无转义列表标记/重复想法前缀
    });
});
