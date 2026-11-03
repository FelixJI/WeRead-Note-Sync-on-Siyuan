import { describe, expect, it } from "vitest";
import {
    classifyConflict,
    isDecisionStale,
    renderManualMerge,
    sortCandidates,
    type DecisionRecord,
} from "../../src/review/model";

// T03 设计契约 §1：冲突四分类（trim 后全文相等比较）、决策过期判定、手动合并规范化、
// 候选稳定排序（chapterIdx 缺失殿后、不修改入参）。

describe("classifyConflict 四分类（trim 后比较）", () => {
    it("identical：三者一致", () => {
        expect(classifyConflict("正文", "正文", "正文")).toBe("identical");
    });

    it("identical：首尾空白差异视为一致（trim 后相等）", () => {
        expect(classifyConflict(" 正文\n", "正文", "正文 ")).toBe("identical");
    });

    it("remote-only：本地与基线一致、远端偏离", () => {
        expect(classifyConflict("原文", "原文", "远端新")).toBe("remote-only");
        expect(classifyConflict("原文", " 原文 ", "远端新")).toBe("remote-only");
    });

    it("local-only：远端与基线一致、本地偏离", () => {
        expect(classifyConflict("原文", "本地新", "原文")).toBe("local-only");
        expect(classifyConflict(" 原文 ", "本地新", "原文")).toBe("local-only");
    });

    it("both-changed：两侧均偏离基线", () => {
        expect(classifyConflict("原文", "本地新", "远端新")).toBe("both-changed");
    });

    it("both-changed：两侧一致但均偏离基线（按契约归 both-changed，而非 identical）", () => {
        expect(classifyConflict("原文", "相同新", "相同新")).toBe("both-changed");
    });
});

describe("isDecisionStale 决策过期判定", () => {
    const record: DecisionRecord = {
        sourceKey: "测试账号/10001/highlight/h1",
        action: "apply-remote",
        decidedAt: "2026-11-03T00:00:00.000Z",
        expectedLocal: "决策时的本地文本",
        remoteRendered: "远端渲染文本",
    };

    it("当前内容与决策时一致 → 未过期", () => {
        expect(isDecisionStale(record, "决策时的本地文本")).toBe(false);
    });

    it("仅首尾空白差异 → 未过期（trim 后比较）", () => {
        expect(isDecisionStale(record, "  决策时的本地文本 \n")).toBe(false);
    });

    it("当前内容已变化 → 过期", () => {
        expect(isDecisionStale(record, "被并发修改的文本")).toBe(true);
    });

    it("manual-merge 记录（含 manualText）同样按 expectedLocal 判定", () => {
        const manual: DecisionRecord = {
            ...record,
            action: "manual-merge",
            manualText: "手动合并结果",
        };
        expect(isDecisionStale(manual, "决策时的本地文本")).toBe(false);
        expect(isDecisionStale(manual, "其他文本")).toBe(true);
    });
});

describe("renderManualMerge 手动合并规范化", () => {
    it("去除首尾空白", () => {
        expect(renderManualMerge("基线文本", "  手动合并文本 \n")).toBe("手动合并文本");
    });

    it("纯空白手动文本 → 空串", () => {
        expect(renderManualMerge("基线文本", "   \n")).toBe("");
    });

    it("规范化不依赖基线：不同基线同输入 → 同输出", () => {
        expect(renderManualMerge("基线A", "同一份手动文本")).toBe(
            renderManualMerge("基线B", "同一份手动文本"),
        );
    });
});

describe("sortCandidates 稳定排序", () => {
    interface Item {
        bookTitle: string;
        chapterIdx?: number;
        sourceKey: string;
        tag: string;
    }

    it("按 (bookTitle 码元序, chapterIdx, sourceKey) 排序；chapterIdx 缺失殿后", () => {
        const list: Item[] = [
            { bookTitle: "球状闪电", sourceKey: "k-e", tag: "E" }, // 书名码元序在“三体”之后
            { bookTitle: "三体", chapterIdx: 3, sourceKey: "k-c", tag: "C" },
            { bookTitle: "三体", sourceKey: "k-d", tag: "D" }, // 无章序 → 同书内殿后
            { bookTitle: "三体", chapterIdx: 1, sourceKey: "k-a", tag: "A" },
            { bookTitle: "三体", chapterIdx: 2, sourceKey: "k-b", tag: "B" },
        ];
        expect(sortCandidates(list).map((x) => x.tag)).toEqual(["A", "B", "C", "D", "E"]);
    });

    it("同书同章内按 sourceKey 排序", () => {
        const list: Item[] = [
            { bookTitle: "三体", chapterIdx: 1, sourceKey: "b", tag: "b" },
            { bookTitle: "三体", chapterIdx: 1, sourceKey: "a", tag: "a" },
        ];
        expect(sortCandidates(list).map((x) => x.tag)).toEqual(["a", "b"]);
    });

    it("完全相同排序键 → 保持原始相对顺序（稳定）", () => {
        const list: Item[] = [
            { bookTitle: "三体", chapterIdx: 1, sourceKey: "same", tag: "first" },
            { bookTitle: "三体", chapterIdx: 1, sourceKey: "same", tag: "second" },
            { bookTitle: "三体", chapterIdx: 1, sourceKey: "same", tag: "third" },
        ];
        expect(sortCandidates(list).map((x) => x.tag)).toEqual(["first", "second", "third"]);
    });

    it("chapterIdx 数值序而非字符串序（10 排在 9 之后）", () => {
        const list: Item[] = [
            { bookTitle: "三体", chapterIdx: 10, sourceKey: "k", tag: "ten" },
            { bookTitle: "三体", chapterIdx: 9, sourceKey: "k", tag: "nine" },
            { bookTitle: "三体", chapterIdx: 2, sourceKey: "k", tag: "two" },
        ];
        expect(sortCandidates(list).map((x) => x.tag)).toEqual(["two", "nine", "ten"]);
    });

    it("不修改入参：返回新数组，原数组顺序不变", () => {
        const list: Item[] = [
            { bookTitle: "三体", chapterIdx: 2, sourceKey: "k2", tag: "second-chapter" },
            { bookTitle: "三体", chapterIdx: 1, sourceKey: "k1", tag: "first-chapter" },
        ];
        const snapshot = [...list];
        const sorted = sortCandidates(list);
        expect(sorted).not.toBe(list);
        expect(list).toEqual(snapshot);
        expect(sorted.map((x) => x.tag)).toEqual(["first-chapter", "second-chapter"]);
    });

    it("空列表 → 空列表", () => {
        expect(sortCandidates([])).toEqual([]);
    });
});
