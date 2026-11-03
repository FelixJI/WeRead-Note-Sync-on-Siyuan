import { describe, expect, it } from "vitest";
import {
    fingerprintPayload,
    matchReviewToHighlight,
    normalizeHighlight,
    normalizeReview,
    type NormalizedHighlight,
    type NormalizedReview,
} from "../../src/sync/model";

const CHAPTERS: Record<number, { idx: number; title: string }> = {
    1: { idx: 1, title: "第一章" },
    3: { idx: 7, title: "第七章" },
};

describe("normalizeHighlight", () => {
    it("缺 bookmarkId → error（不猜主键）", () => {
        const res = normalizeHighlight({ markText: "文本" }, CHAPTERS);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toContain("bookmarkId");
    });

    it("bookmarkId 非字符串或空串 → error", () => {
        expect(normalizeHighlight({ bookmarkId: 123, markText: "x" }, CHAPTERS).ok).toBe(false);
        expect(normalizeHighlight({ bookmarkId: "", markText: "x" }, CHAPTERS).ok).toBe(false);
    });

    it("缺 markText → error", () => {
        const res = normalizeHighlight({ bookmarkId: "bm-1" }, CHAPTERS);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toContain("markText");
    });

    it("正常条目：range 首数字、章节映射、raw 保留", () => {
        const raw = {
            bookmarkId: "bm-1",
            markText: "划线文本",
            chapterUid: 3,
            range: "2959-3007",
            createTime: 1700000000,
            colorStyle: "yellow",
        };
        const res = normalizeHighlight(raw, CHAPTERS);
        expect(res.ok).toBe(true);
        if (!res.ok) throw new Error(res.error);
        expect(res.value.bookmarkId).toBe("bm-1");
        expect(res.value.markText).toBe("划线文本");
        expect(res.value.rangeStart).toBe(2959);
        expect(res.value.chapterUid).toBe(3);
        expect(res.value.chapterIdx).toBe(7);
        expect(res.value.chapterTitle).toBe("第七章");
        expect(res.value.createTime).toBe(1700000000);
        expect(res.value.raw).toBe(raw);
    });

    it("非法 range 不崩：rangeStart 不设置", () => {
        for (const range of ["abc-def", "", "x", "-", "  ", undefined, 42]) {
            const res = normalizeHighlight(
                { bookmarkId: "bm-1", markText: "t", range },
                CHAPTERS,
            );
            expect(res.ok).toBe(true);
            if (res.ok) expect(res.value.rangeStart).toBeUndefined();
        }
    });

    it("chapterUid 不在 chapters 映射 → 不猜章节", () => {
        const res = normalizeHighlight(
            { bookmarkId: "bm-1", markText: "t", chapterUid: 99 },
            CHAPTERS,
        );
        expect(res.ok).toBe(true);
        if (!res.ok) throw new Error(res.error);
        expect(res.value.chapterUid).toBe(99);
        expect(res.value.chapterIdx).toBeUndefined();
        expect(res.value.chapterTitle).toBeUndefined();
    });

    it("无 chapterUid 时保留原始 chapterIdx（若为有限数字）", () => {
        const res = normalizeHighlight(
            { bookmarkId: "bm-1", markText: "t", chapterIdx: 5 },
            CHAPTERS,
        );
        expect(res.ok).toBe(true);
        if (!res.ok) throw new Error(res.error);
        expect(res.value.chapterIdx).toBe(5);
        expect(res.value.chapterTitle).toBeUndefined();
    });
});

describe("normalizeReview", () => {
    it("缺 reviewId → error（不猜主键）", () => {
        const res = normalizeReview({ review: { content: "想法" }, abstract: "a" });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toContain("reviewId");
    });

    it("缺 content → error", () => {
        const res = normalizeReview({ review: { reviewId: "rv-1" }, abstract: "a" });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toContain("content");
    });

    it("reviewId/content 必填：空串同样视为缺失", () => {
        expect(normalizeReview({ review: { reviewId: "", content: "c" } }).ok).toBe(false);
        expect(normalizeReview({ review: { reviewId: "rv-1", content: "" } }).ok).toBe(false);
    });

    it("外层包装形状：abstract/range/chapterUid/createTime 取外层，reviewId/content 取内层", () => {
        const raw = {
            review: { reviewId: "rv-1", content: "这是想法内容", star: 5 },
            abstract: "对应划线原文",
            range: "2959-3007",
            chapterUid: 3,
            createTime: 1700000100,
        };
        const res = normalizeReview(raw);
        expect(res.ok).toBe(true);
        if (!res.ok) throw new Error(res.error);
        expect(res.value.reviewId).toBe("rv-1");
        expect(res.value.content).toBe("这是想法内容");
        expect(res.value.abstract).toBe("对应划线原文");
        expect(res.value.rangeStart).toBe(2959);
        expect(res.value.chapterUid).toBe(3);
        expect(res.value.createTime).toBe(1700000100);
        expect(res.value.raw).toBe(raw);
    });

    it("非法 range 不崩：rangeStart 不设置", () => {
        const res = normalizeReview({
            review: { reviewId: "rv-1", content: "c" },
            range: "not-a-range",
        });
        expect(res.ok).toBe(true);
        if (!res.ok) throw new Error(res.error);
        expect(res.value.rangeStart).toBeUndefined();
    });
});

describe("fingerprintPayload（稳定序列化，键序无关）", () => {
    it("顶层与嵌套键序无关，数组保序", () => {
        const a = fingerprintPayload({ a: 1, b: { y: [3, 4], x: "s" }, c: null });
        const b = fingerprintPayload({ c: null, b: { x: "s", y: [3, 4] }, a: 1 });
        expect(a).toBe(b);
    });

    it("与 JSON.stringify 的键序敏感性不同：两个键序不同对象指纹一致", () => {
        const o1 = { z: 1, a: 2 };
        const o2 = { a: 2, z: 1 };
        expect(JSON.stringify(o1)).not.toBe(JSON.stringify(o2));
        expect(fingerprintPayload(o1)).toBe(fingerprintPayload(o2));
    });

    it("内容不同 → 指纹不同", () => {
        expect(fingerprintPayload({ a: 1 })).not.toBe(fingerprintPayload({ a: 2 }));
        expect(fingerprintPayload({ a: 1 })).not.toBe(fingerprintPayload({ a: 1, b: 2 }));
        // 数组保序：顺序不同即指纹不同
        expect(fingerprintPayload({ arr: [1, 2] })).not.toBe(fingerprintPayload({ arr: [2, 1] }));
    });

    it("确定性：同一输入重复计算结果一致", () => {
        const payload = { b: { n: [1, { q: true }] }, a: "文" };
        expect(fingerprintPayload(payload)).toBe(fingerprintPayload(payload));
    });
});

describe("matchReviewToHighlight（双精确匹配，禁止模糊）", () => {
    const h = (bookmarkId: string, chapterUid: number | undefined, rangeStart: number | undefined): NormalizedHighlight => ({
        bookmarkId,
        markText: `t-${bookmarkId}`,
        ...(chapterUid === undefined ? {} : { chapterUid }),
        ...(rangeStart === undefined ? {} : { rangeStart }),
        raw: {},
    });
    const r = (chapterUid: number | undefined, rangeStart: number | undefined): NormalizedReview => ({
        reviewId: "rv-x",
        content: "c",
        ...(chapterUid === undefined ? {} : { chapterUid }),
        ...(rangeStart === undefined ? {} : { rangeStart }),
        raw: {},
    });

    it("chapterUid+rangeStart 双精确命中 → bookmarkId", () => {
        const hs = [h("bm-a", 3, 2959), h("bm-b", 4, 100)];
        expect(matchReviewToHighlight(r(3, 2959), hs)).toBe("bm-a");
    });

    it("仅 range 相同但 chapterUid 不同 → undefined", () => {
        const hs = [h("bm-a", 3, 2959)];
        expect(matchReviewToHighlight(r(4, 2959), hs)).toBeUndefined();
    });

    it("review 缺 chapterUid → undefined（保守，不做仅 range 匹配）", () => {
        const hs = [h("bm-a", 3, 2959)];
        expect(matchReviewToHighlight(r(undefined, 2959), hs)).toBeUndefined();
    });

    it("review 缺 rangeStart → undefined（保守）", () => {
        const hs = [h("bm-a", 3, 2959)];
        expect(matchReviewToHighlight(r(3, undefined), hs)).toBeUndefined();
    });

    it("同 chapterUid+range 多 highlight → 取数组中第一个（顺序语义在测试中固定）", () => {
        const hs = [h("bm-first", 3, 2959), h("bm-second", 3, 2959)];
        expect(matchReviewToHighlight(r(3, 2959), hs)).toBe("bm-first");
        const reversed = [h("bm-second", 3, 2959), h("bm-first", 3, 2959)];
        expect(matchReviewToHighlight(r(3, 2959), reversed)).toBe("bm-second");
    });

    it("无任何匹配 → undefined", () => {
        expect(matchReviewToHighlight(r(9, 9), [h("bm-a", 3, 2959)])).toBeUndefined();
        expect(matchReviewToHighlight(r(3, 2959), [])).toBeUndefined();
    });

    it("禁止模糊/文本相似：abstract 与 markText 完全相同也不匹配", () => {
        const hs: NormalizedHighlight[] = [{ bookmarkId: "bm-a", markText: "相同文本", raw: {} }];
        const review: NormalizedReview = { reviewId: "rv", content: "相同文本", abstract: "相同文本", raw: {} };
        expect(matchReviewToHighlight(review, hs)).toBeUndefined();
    });
});
