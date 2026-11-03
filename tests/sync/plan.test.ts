import { describe, expect, it } from "vitest";
import { computePlan } from "../../src/sync/plan";
import { makeSourceKey } from "../../src/sync/identity";
import { renderHighlightBlock, renderReviewChild } from "../../src/sync/kramdown";
import {
    fingerprintPayload,
    normalizeHighlight,
    normalizeReview,
    type BookSourceDetail,
    type BookSyncState,
    type ItemState,
    type NormalizedHighlight,
    type NormalizedReview,
} from "../../src/sync/model";

const NS = "acct-1";
const BOOK = "BID";
const CHAPTERS: Record<number, { idx: number; title: string }> = {
    1: { idx: 1, title: "第一章" },
    2: { idx: 2, title: "第二章" },
};

function hlRaw(bookmarkId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        bookmarkId,
        markText: `摘录-${bookmarkId}`,
        chapterUid: 1,
        range: "100-200",
        createTime: 1000,
        ...extra,
    };
}

// 外层包装形状：abstract/range/chapterUid 在外层，reviewId/content 在 .review 内
function rvRaw(reviewId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        review: { reviewId, content: `想法-${reviewId}` },
        abstract: "原文",
        range: "100-200",
        chapterUid: 1,
        createTime: 1000,
        ...extra,
    };
}

function buildDetail(
    rawHls: Record<string, unknown>[],
    rawRvs: Record<string, unknown>[],
    overrides: Partial<BookSourceDetail> = {},
): BookSourceDetail {
    const highlights: NormalizedHighlight[] = [];
    const reviews: NormalizedReview[] = [];
    const anomalies: string[] = [];
    for (const raw of rawHls) {
        const res = normalizeHighlight(raw, CHAPTERS);
        if (res.ok) highlights.push(res.value);
        else anomalies.push(res.error);
    }
    for (const raw of rawRvs) {
        const res = normalizeReview(raw);
        if (res.ok) reviews.push(res.value);
        else anomalies.push(res.error);
    }
    return { bookId: BOOK, highlights, reviews, anomalies, complete: true, ...overrides };
}

function hKey(bookmarkId: string): string {
    return makeSourceKey({ accountNamespace: NS, bookId: BOOK, kind: "highlight", officialSourceId: bookmarkId });
}
function rKey(reviewId: string): string {
    return makeSourceKey({ accountNamespace: NS, bookId: BOOK, kind: "review", officialSourceId: reviewId });
}

// 模拟 engine 落账后的状态：versionFingerprint = fingerprintPayload(sourcePayload)，status=active
function activeItem(kind: "highlight" | "review", payload: Record<string, unknown>, round: number): ItemState {
    return {
        kind,
        sourcePayload: payload,
        renderedText: "",
        versionFingerprint: fingerprintPayload(payload),
        status: "active",
        override: false,
        lastSeenRound: round,
    };
}

function stateFromDetail(detail: BookSourceDetail, round: number): BookSyncState {
    const items: Record<string, ItemState> = {};
    for (const h of detail.highlights) items[hKey(h.bookmarkId)] = activeItem("highlight", h.raw, round);
    for (const r of detail.reviews) items[rKey(r.reviewId)] = activeItem("review", r.raw, round);
    return { schemaVersion: 1, bookId: BOOK, title: "书名", generation: round, items };
}

function plan(detail: BookSourceDetail, state?: BookSyncState, round = 1) {
    return computePlan({ state, detail, round, accountNamespace: NS });
}

describe("computePlan a) 首轮全量 creates 与稳定排序", () => {
    const detail = buildDetail(
        [
            hlRaw("bm-2", { chapterUid: 2, createTime: 100 }),
            hlRaw("bm-1", { range: "300-400", createTime: 200 }),
            hlRaw("bm-0", { createTime: 200 }),
            hlRaw("bm-9", { chapterUid: undefined, createTime: 50 }),
        ],
        [],
    );

    it("排序：chapterIdx 升序 → rangeStart 升序 → createTime 升序 → officialSourceId；无章节排最后", () => {
        const p = plan(detail);
        expect(p.skipped).toBe(false);
        expect(p.creates.map((c) => c.officialSourceId)).toEqual(["bm-0", "bm-1", "bm-2", "bm-9"]);
        expect(p.candidates).toEqual([]);
        expect(p.protected).toEqual([]);
    });

    it("章节信息正确传递；无章节条目 chapter=undefined", () => {
        const p = plan(detail);
        expect(p.creates[0].chapter).toEqual({ idx: 1, title: "第一章" });
        expect(p.creates[2].chapter).toEqual({ idx: 2, title: "第二章" });
        expect(p.creates[3].chapter).toBeUndefined();
    });

    it("payload=原始条目、renderedText=kramdown 渲染、kind/sourceKey 正确", () => {
        const p = plan(detail);
        const c = p.creates[0];
        expect(c.kind).toBe("highlight");
        expect(c.sourceKey).toBe(hKey("bm-0"));
        expect(c.payload).toBe(detail.highlights.find((h) => h.bookmarkId === "bm-0")?.raw);
        expect(c.renderedText).toBe(renderHighlightBlock("摘录-bm-0"));
        expect(c.matchedHighlightBlockHint).toBeUndefined();
    });

    it("同键高亮按 officialSourceId 决胜（稳定）", () => {
        const d = buildDetail(
            [hlRaw("bm-b", { createTime: 5 }), hlRaw("bm-a", { createTime: 5 })],
            [],
        );
        const p = plan(d);
        expect(p.creates.map((c) => c.officialSourceId)).toEqual(["bm-a", "bm-b"]);
    });

    it("确定性：同输入两次计算结果一致", () => {
        expect(plan(detail)).toEqual(plan(detail));
    });
});

describe("computePlan b) 二轮同数据 → 零 creates 零 candidates（AC1 核心）", () => {
    it("指纹一致时不产生任何动作", () => {
        const detail = buildDetail([hlRaw("bm-1")], [rvRaw("rv-1", { range: "500-600", chapterUid: 9 })]);
        const state = stateFromDetail(detail, 1);
        const p = plan(detail, state, 2);
        expect(p.skipped).toBe(false);
        expect(p.creates).toEqual([]);
        expect(p.candidates).toEqual([]);
        expect(p.protected).toEqual([]);
    });
});

describe("computePlan c) 指纹变化 → 仅 candidates", () => {
    it("markText 改一字 → candidate，不产生 create/update", () => {
        const d1 = buildDetail([hlRaw("bm-1")], []);
        const state = stateFromDetail(d1, 1);
        const d2 = buildDetail([hlRaw("bm-1", { markText: "摘录-bm-1（改）" })], []);
        const p = plan(d2, state, 2);
        expect(p.creates).toEqual([]);
        expect(p.protected).toEqual([]);
        expect(p.candidates).toHaveLength(1);
        const cand = p.candidates[0];
        expect(cand.sourceKey).toBe(hKey("bm-1"));
        expect(cand.reason).toBe("source-changed");
        expect(cand.oldFingerprint).toBe(fingerprintPayload(d1.highlights[0].raw));
        expect(cand.newFingerprint).toBe(fingerprintPayload(d2.highlights[0].raw));
        expect(cand.oldFingerprint).not.toBe(cand.newFingerprint);
    });

    it("review 载荷变化同样进入 candidates", () => {
        const d1 = buildDetail([], [rvRaw("rv-1")]);
        const state = stateFromDetail(d1, 1);
        const d2 = buildDetail([], [rvRaw("rv-1", { review: { reviewId: "rv-1", content: "想法变了" } })]);
        const p = plan(d2, state, 2);
        expect(p.candidates).toHaveLength(1);
        expect(p.candidates[0].sourceKey).toBe(rKey("rv-1"));
        expect(p.creates).toEqual([]);
    });
});

describe("computePlan d) 来源缺一条 → protected(unseen)，无删除语义", () => {
    it("active 但本轮来源未见 → protected(unseen)；其余条目无动作", () => {
        const d1 = buildDetail([hlRaw("bm-1"), hlRaw("bm-2")], []);
        const state = stateFromDetail(d1, 1);
        const d2 = buildDetail([hlRaw("bm-1")], []);
        const p = plan(d2, state, 2);
        expect(p.creates).toEqual([]);
        expect(p.candidates).toEqual([]);
        expect(p.protected).toEqual([{ sourceKey: hKey("bm-2"), reason: "unseen" }]);
        // 输出结构中不存在任何 delete/移除动作（SyncPlan 只有 creates/candidates/protected/skipped）
        expect(Object.keys(p).sort()).toEqual(["candidates", "creates", "protected", "skipped", "skipReason"].filter((k) => k in p).sort());
    });
});

describe("computePlan e) user-deleted / moved-out / quarantined → protected，不复活不补建", () => {
    it("三种保护状态均进 protected 且无 creates", () => {
        const d = buildDetail([hlRaw("bm-ud"), hlRaw("bm-mo"), hlRaw("bm-q")], []);
        const items: Record<string, ItemState> = {
            [hKey("bm-ud")]: { ...activeItem("highlight", d.highlights[0].raw, 1), status: "user-deleted" },
            [hKey("bm-mo")]: { ...activeItem("highlight", d.highlights[1].raw, 1), status: "moved-out" },
            [hKey("bm-q")]: { ...activeItem("highlight", d.highlights[2].raw, 1), status: "quarantined" },
        };
        const state: BookSyncState = { schemaVersion: 1, bookId: BOOK, title: "书名", generation: 1, items };
        const p = plan(d, state, 2);
        expect(p.creates).toEqual([]);
        expect(p.candidates).toEqual([]);
        expect(p.protected.map((x) => [x.sourceKey, x.reason])).toEqual([
            [hKey("bm-ud"), "user-deleted"],
            [hKey("bm-mo"), "moved-out"],
            [hKey("bm-q"), "ambiguous-attrs"],
        ]);
        const q = p.protected.find((x) => x.reason === "ambiguous-attrs");
        expect(q?.note).toContain("多块歧义");
        expect(q?.note).toContain("人工裁决");
    });

    it("user-deleted 来源返回也不复活（无 create）", () => {
        const d = buildDetail([hlRaw("bm-ud")], []);
        const state: BookSyncState = {
            schemaVersion: 1,
            bookId: BOOK,
            title: "书名",
            generation: 1,
            items: { [hKey("bm-ud")]: { ...activeItem("highlight", d.highlights[0].raw, 1), status: "user-deleted" } },
        };
        const p = plan(d, state, 2);
        expect(p.creates).toEqual([]);
        expect(p.protected).toHaveLength(1);
    });
});

describe("computePlan f) anomalies 非空或 complete=false → 整书 skipped", () => {
    it("anomalies 非空 → 全书无任何动作", () => {
        const d = buildDetail([hlRaw("bm-1")], []);
        d.anomalies.push("reviewId缺失，跳过该条");
        const p = plan(d);
        expect(p.skipped).toBe(true);
        expect(p.skipReason).toBeTruthy();
        expect(p.creates).toEqual([]);
        expect(p.candidates).toEqual([]);
        expect(p.protected).toEqual([]);
    });

    it("complete=false → 全书无任何动作（即使无 anomalies）", () => {
        const d = buildDetail([hlRaw("bm-1")], [], { complete: false });
        const p = plan(d);
        expect(p.skipped).toBe(true);
        expect(p.skipReason).toBeTruthy();
        expect(p.creates).toEqual([]);
        expect(p.candidates).toEqual([]);
        expect(p.protected).toEqual([]);
    });

    it("跳过门禁优先于一切：已有 state 也不产出 candidates/protected", () => {
        const d1 = buildDetail([hlRaw("bm-1")], []);
        const state = stateFromDetail(d1, 1);
        const d2 = buildDetail([hlRaw("bm-1", { markText: "变了" })], [], { complete: false });
        const p = plan(d2, state, 2);
        expect(p.skipped).toBe(true);
        expect(p.creates).toEqual([]);
        expect(p.candidates).toEqual([]);
        expect(p.protected).toEqual([]);
    });
});

describe("computePlan g) review 挂靠（双精确匹配）", () => {
    const detail = buildDetail(
        [hlRaw("bm-1")],
        [
            rvRaw("rv-1"),
            rvRaw("rv-2"),
            rvRaw("rv-x", { chapterUid: 9, range: "500-600" }),
        ],
    );

    it("同 highlight 挂多个 review：紧随该 highlight 且保持来源顺序，hint=bookmarkId", () => {
        const p = plan(detail);
        expect(p.creates.map((c) => c.officialSourceId)).toEqual(["bm-1", "rv-1", "rv-2", "rv-x"]);
        const rv1 = p.creates[1];
        const rv2 = p.creates[2];
        expect(rv1.matchedHighlightBlockHint).toBe("bm-1");
        expect(rv2.matchedHighlightBlockHint).toBe("bm-1");
        expect(rv1.kind).toBe("review");
        expect(rv1.payload).toBe(detail.reviews[0].raw);
        expect(rv1.renderedText).toBe(renderReviewChild("想法-rv-1"));
        // 挂靠 review 继承 highlight 的章节
        expect(rv1.chapter).toEqual({ idx: 1, title: "第一章" });
    });

    it("无匹配 review：hint=undefined、chapter=undefined，排在章节化条目之后", () => {
        const p = plan(detail);
        const standalone = p.creates[3];
        expect(standalone.officialSourceId).toBe("rv-x");
        expect(standalone.matchedHighlightBlockHint).toBeUndefined();
        expect(standalone.chapter).toBeUndefined();
    });

    it("review 挂靠到已存在（本轮非新建）的 highlight 仍给 hint", () => {
        const d1 = buildDetail([hlRaw("bm-1")], []);
        const state = stateFromDetail(d1, 1);
        const d2 = buildDetail([hlRaw("bm-1")], [rvRaw("rv-new")]);
        const p = plan(d2, state, 2);
        expect(p.creates).toHaveLength(1);
        expect(p.creates[0].officialSourceId).toBe("rv-new");
        expect(p.creates[0].matchedHighlightBlockHint).toBe("bm-1");
        expect(p.creates[0].chapter).toEqual({ idx: 1, title: "第一章" });
    });

    it("独立想法按 (createTime, reviewId) 排序", () => {
        const d = buildDetail(
            [hlRaw("bm-1", { chapterUid: 9, range: "900-999" })],
            [
                rvRaw("rv-b", { chapterUid: 5, range: "10-20", createTime: 200 }),
                rvRaw("rv-a", { chapterUid: 5, range: "10-20", createTime: 200 }),
                rvRaw("rv-c", { chapterUid: 5, range: "10-20", createTime: 100 }),
            ],
        );
        const p = plan(d);
        // bm-1 无匹配 review；三个独立想法按 createTime 再 reviewId
        expect(p.creates.map((c) => c.officialSourceId)).toEqual(["bm-1", "rv-c", "rv-a", "rv-b"]);
    });
});

describe("computePlan 身份防御", () => {
    it("officialSourceId 含 / 等非法字符 → 整书 skipped（不猜主键）", () => {
        const d = buildDetail([hlRaw("bm/1")], []);
        const p = plan(d);
        expect(p.skipped).toBe(true);
        expect(p.creates).toEqual([]);
        expect(p.candidates).toEqual([]);
        expect(p.protected).toEqual([]);
    });
});
