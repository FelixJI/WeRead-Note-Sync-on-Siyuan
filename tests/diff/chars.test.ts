import { describe, expect, it } from "vitest";
import { diffChars, diffLines, type DiffOp } from "../../src/diff/chars";

// T03 设计契约 §1：公共前后缀修剪 + 中段 LCS；相邻同类型合并、equal/insert/delete 交替；
// 字符串按 Unicode 码点切分（代理对/ZWJ emoji 不拆半）；CRLF/空串输入确定、无随机性。

/** reconstruct(ops, "delete") === 原文 a；reconstruct(ops, "insert") === 新文 b。 */
function reconstruct(ops: DiffOp[], pick: "delete" | "insert"): string {
    return ops
        .filter((op) => op.type === "equal" || op.type === pick)
        .map((op) => op.text)
        .join("");
}

/** 合并性：无空 text 的 op；任意相邻两 op 类型不同。 */
function expectAlternating(ops: DiffOp[]): void {
    for (const op of ops) {
        expect(op.text.length, `op(${op.type}) 不应为空文本`).toBeGreaterThan(0);
    }
    for (let i = 1; i < ops.length; i++) {
        expect(
            ops[i]!.type === ops[i - 1]!.type,
            `第 ${i} 个 op 与前一个同为 ${ops[i]!.type}，未合并`,
        ).toBe(false);
    }
}

describe("diffChars 中文逐字 diff", () => {
    it("中文插入：给岁月以文明 → 给岁月以文明，而不是给文明以岁月（逐字断言）", () => {
        const ops = diffChars("给岁月以文明", "给岁月以文明，而不是给文明以岁月");
        expect(ops).toEqual([
            { type: "equal", text: "给岁月以文明" },
            { type: "insert", text: "，而不是给文明以岁月" },
        ]);
    });

    it("中文替换：黑色 → 明亮（delete+insert 相邻交替）", () => {
        const ops = diffChars("黑夜给了我黑色的眼睛", "黑夜给了我明亮的眼睛");
        expect(ops).toEqual([
            { type: "equal", text: "黑夜给了我" },
            { type: "delete", text: "黑色" },
            { type: "insert", text: "明亮" },
            { type: "equal", text: "的眼睛" },
        ]);
    });

    it("中文删除：给时光以生命 → 给生命（中段整体删除）", () => {
        const ops = diffChars("给时光以生命", "给生命");
        expect(ops).toEqual([
            { type: "equal", text: "给" },
            { type: "delete", text: "时光以" },
            { type: "equal", text: "生命" },
        ]);
    });

    it("中文插入虚词：不是 → 都不是（前后缀修剪后仅单点插入）", () => {
        const ops = diffChars("弱小和无知不是生存的障碍，傲慢才是", "弱小和无知都不是生存的障碍，傲慢才是");
        expect(ops).toEqual([
            { type: "equal", text: "弱小和无知" },
            { type: "insert", text: "都" },
            { type: "equal", text: "不是生存的障碍，傲慢才是" },
        ]);
    });

    it("中文完全不同：整体替换为 delete 全文 + insert 全文", () => {
        expect(diffChars("甲乙丙", "丁戊己")).toEqual([
            { type: "delete", text: "甲乙丙" },
            { type: "insert", text: "丁戊己" },
        ]);
    });
});

describe("diffChars ASCII 与边界", () => {
    it("纯 ASCII 插入词：hello world → hello brave world", () => {
        expect(diffChars("hello world", "hello brave world")).toEqual([
            { type: "equal", text: "hello " },
            { type: "insert", text: "brave " },
            { type: "equal", text: "world" },
        ]);
    });

    it("纯 ASCII 单字符替换：cat → cot", () => {
        expect(diffChars("cat", "cot")).toEqual([
            { type: "equal", text: "c" },
            { type: "delete", text: "a" },
            { type: "insert", text: "o" },
            { type: "equal", text: "t" },
        ]);
    });

    it("纯 ASCII 完全不同：abc → xyz", () => {
        expect(diffChars("abc", "xyz")).toEqual([
            { type: "delete", text: "abc" },
            { type: "insert", text: "xyz" },
        ]);
    });

    it("空串 ↔ 非空：单侧整体 insert/delete；双空串 → 空 op 数组", () => {
        expect(diffChars("", "abc")).toEqual([{ type: "insert", text: "abc" }]);
        expect(diffChars("abc", "")).toEqual([{ type: "delete", text: "abc" }]);
        expect(diffChars("", "")).toEqual([]);
    });

    it("完全相同：单个 equal 覆盖全文（含前后空白不 trim）", () => {
        expect(diffChars("三体", "三体")).toEqual([{ type: "equal", text: "三体" }]);
        expect(diffChars("  keep spaces  ", "  keep spaces  ")).toEqual([
            { type: "equal", text: "  keep spaces  " },
        ]);
    });
});

describe("diffChars Unicode 码点（代理对/ZWJ emoji）", () => {
    it("ZWJ 组合 emoji 生长：👨‍👩‍👧 → 👨‍👩‍👧‍👦 追加 ZWJ+👦，基础组合不拆半", () => {
        const ops = diffChars("👨‍👩‍👧", "👨‍👩‍👧‍👦");
        expect(ops).toEqual([
            { type: "equal", text: "👨‍👩‍👧" },
            { type: "insert", text: "\u200D👦" },
        ]);
    });

    it("emoji 交换顺序（👨‍👩 ↔ 👩‍👨）：重构两侧原文且保持交替", () => {
        const ops = diffChars("👨‍👩", "👩‍👨");
        expectAlternating(ops);
        expect(reconstruct(ops, "delete")).toBe("👨‍👩");
        expect(reconstruct(ops, "insert")).toBe("👩‍👨");
        // 至少保留 1 个 equal（ZWJ 序列共享 👨 码点）
        expect(ops.filter((op) => op.type === "equal").length).toBeGreaterThanOrEqual(1);
    });

    it("单个代理对字符删除：😀 → 空串", () => {
        expect(diffChars("😀", "")).toEqual([{ type: "delete", text: "😀" }]);
    });
});

describe("diffChars 前后缀修剪正确性", () => {
    const SENTENCE = "给岁月以文明，而不是给文明以岁月。";
    const longBase = SENTENCE.repeat(12); // 17 × 12 = 204 码点

    it("长文本中段小改：仅 4 个 op（前缀 equal + 小段删/插 + 后缀 equal）", () => {
        // 位置 100..102 的原文为 “月。给”，替换为 “三体！”（与被删字符零交集 → 中段 LCS 为空）
        const b = `${longBase.slice(0, 100)}三体！${longBase.slice(103)}`;
        const ops = diffChars(longBase, b);
        expect(ops).toEqual([
            { type: "equal", text: longBase.slice(0, 100) },
            { type: "delete", text: "月。给" },
            { type: "insert", text: "三体！" },
            { type: "equal", text: longBase.slice(103) },
        ]);
        expect(ops).toHaveLength(4);
    });

    it("长文本完全相同：单个 equal 覆盖全文（前缀整体消费，不进入 DP）", () => {
        expect(diffChars(longBase, longBase)).toEqual([{ type: "equal", text: longBase }]);
    });
});

describe("diffChars 合并性与往返重构（性质测试）", () => {
    const cases: Array<[string, string]> = [
        ["给岁月以文明", "给岁月以文明，而不是给文明以岁月"],
        ["弱小和无知不是生存的障碍，傲慢才是", "弱小和无知都不是生存的障碍，傲慢才是"],
        ["hello world", "hello brave world"],
        ["abcdef", "acf"],
        ["abc", "xyz"],
        ["", "abc"],
        ["abc", ""],
        ["", ""],
        ["abc", "abc"],
        ["👨‍👩‍👧", "👨‍👩‍👧‍👦"],
        ["abcabcabc", "abcabc"],
        ["  纯空白变化  ", "纯空白变化"],
    ];

    it("全部用例：重构原文/新文一致，且不出现连续同类型 op", () => {
        for (const [a, b] of cases) {
            const ops = diffChars(a, b);
            expectAlternating(ops);
            expect(reconstruct(ops, "delete"), `a 侧重构失败: ${a}`).toBe(a);
            expect(reconstruct(ops, "insert"), `b 侧重构失败: ${b}`).toBe(b);
        }
    });
});

describe("diffLines 行级 diff（行尾符保留在行文本内）", () => {
    it("多行增删改混合：删一行、插两行", () => {
        const ops = diffLines("第一行\n第二行\n第三行\n", "第一行\n插入行\n第三行\n第四行\n");
        expect(ops).toEqual([
            { type: "equal", text: "第一行\n" },
            { type: "delete", text: "第二行\n" },
            { type: "insert", text: "插入行\n" },
            { type: "equal", text: "第三行\n" },
            { type: "insert", text: "第四行\n" },
        ]);
    });

    it("纯增行与纯删行", () => {
        expect(diffLines("一\n二\n", "一\n二\n三\n")).toEqual([
            { type: "equal", text: "一\n二\n" },
            { type: "insert", text: "三\n" },
        ]);
        expect(diffLines("一\n二\n三\n", "一\n二\n")).toEqual([
            { type: "equal", text: "一\n二\n" },
            { type: "delete", text: "三\n" },
        ]);
    });

    it("CRLF：\r 完整保留在行文本内，跨行内容可读", () => {
        const ops = diffLines("行一\r\n行二\r\n", "行一\r\n行二改\r\n行三\r\n");
        expect(ops).toEqual([
            { type: "equal", text: "行一\r\n" },
            { type: "delete", text: "行二\r\n" },
            { type: "insert", text: "行二改\r\n行三\r\n" },
        ]);
    });

    it("CRLF ↔ LF：行尾符差异视为行内容差异（delete+insert，不吞 \r）", () => {
        const ops = diffLines("甲\r\n乙\r\n", "甲\n乙\n");
        expect(ops).toEqual([
            { type: "delete", text: "甲\r\n乙\r\n" },
            { type: "insert", text: "甲\n乙\n" },
        ]);
    });

    it("末行无行尾符：末行仍作为独立行单元参与 diff", () => {
        expect(diffLines("a\nb", "a\nb")).toEqual([{ type: "equal", text: "a\nb" }]);
        expect(diffLines("a\nb", "a\nc")).toEqual([
            { type: "equal", text: "a\n" },
            { type: "delete", text: "b" },
            { type: "insert", text: "c" },
        ]);
    });

    it("空串与空行：空串 → 无行；连续空行是独立行单元", () => {
        expect(diffLines("", "x\n")).toEqual([{ type: "insert", text: "x\n" }]);
        expect(diffLines("x\n", "")).toEqual([{ type: "delete", text: "x\n" }]);
        expect(diffLines("", "")).toEqual([]);
        expect(diffLines("a\n\nb\n", "a\n\nb\n")).toEqual([{ type: "equal", text: "a\n\nb\n" }]);
    });

    it("多行重构性质：交替 + 双侧原文一致", () => {
        const cases: Array<[string, string]> = [
            ["第一行\n第二行\n第三行\n", "第一行\n插入行\n第三行\n第四行\n"],
            ["一\n二\n三\n", "一\n二\n"],
            ["行一\r\n行二\r\n", "行一\r\n行二改\r\n行三\r\n"],
            ["甲\r\n乙\r\n", "甲\n乙\n"],
            ["a\nb\nc\nd\ne\n", "a\ne\n"],
        ];
        for (const [a, b] of cases) {
            const ops = diffLines(a, b);
            expectAlternating(ops);
            expect(reconstruct(ops, "delete"), `a 侧重构失败: ${JSON.stringify(a)}`).toBe(a);
            expect(reconstruct(ops, "insert"), `b 侧重构失败: ${JSON.stringify(b)}`).toBe(b);
        }
    });
});
