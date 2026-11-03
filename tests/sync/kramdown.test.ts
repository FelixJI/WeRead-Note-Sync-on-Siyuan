import { describe, expect, it } from "vitest";
import {
    escapeKramdownText,
    renderChapterHeading,
    renderHighlightBlock,
    renderHighlightsSectionHeading,
    renderReviewChild,
    renderReviewSectionHeading,
    sanitizeDocTitle,
} from "../../src/sync/kramdown";

// 设计契约 §5：远端文本按纯文本行处理；反斜杠先行；行首 >/#/-/*/+/数字. 强制转义；
// <...> 标签形全转义；{:...} IAL 转义。远端文本永不解释为 HTML/脚本。

describe("escapeKramdownText 注入防护", () => {
    it("HTML 标签全转义：<script> 无法以未转义 < 开头成标签", () => {
        expect(escapeKramdownText("<script>alert(1)</script>")).toBe(
            "\\<script>alert(1)\\</script>",
        );
    });

    it("IAL 属性注入被转义（行首 {: 与行中 {: 均覆盖）", () => {
        expect(escapeKramdownText('{: id="evil"}')).toBe('\\{: id="evil"}');
        expect(escapeKramdownText('正文 {: id="evil"}')).toBe('正文 \\{: id="evil"}');
    });

    it("行首块引用/标题/列表/有序列表标记强制转义", () => {
        expect(escapeKramdownText("> 引用")).toBe("\\> 引用");
        expect(escapeKramdownText("# 标题")).toBe("\\# 标题");
        expect(escapeKramdownText("- 列表")).toBe("\\- 列表");
        expect(escapeKramdownText("* 强调")).toBe("\\* 强调");
        expect(escapeKramdownText("+ 列表")).toBe("\\+ 列表");
        expect(escapeKramdownText("1. 有序")).toBe("1\\. 有序");
        expect(escapeKramdownText("*em*")).toBe("\\*em*");
        expect(escapeKramdownText("12. 数字")).toBe("12\\. 数字");
    });

    it("缩进行首标记同样转义", () => {
        expect(escapeKramdownText("  - 缩进列表")).toBe("  \\- 缩进列表");
        expect(escapeKramdownText("   > 缩进引用")).toBe("   \\> 缩进引用");
    });

    it("反斜杠先行转义，防止自带转义序列被二次利用", () => {
        expect(escapeKramdownText("a\\b")).toBe("a\\\\b");
        // 用户文本 "\<script>"：先 \\ 再 \< → 渲染为字面 "\<script>"，不会打开标签
        expect(escapeKramdownText("\\<script>")).toBe("\\\\\\<script>");
    });

    it("多行逐行处理，CRLF/CR 归一为 LF", () => {
        expect(escapeKramdownText("第一行\n第二行")).toBe("第一行\n第二行");
        expect(escapeKramdownText("第一行\r\n> 第二行")).toBe("第一行\n\\> 第二行");
        expect(escapeKramdownText("a\r>b")).toBe("a\n\\>b");
    });

    it("空串与纯空白行保持原样", () => {
        expect(escapeKramdownText("")).toBe("");
        expect(escapeKramdownText("   ")).toBe("   ");
        expect(escapeKramdownText("a\n \nb")).toBe("a\n \nb");
    });

    it("无特殊字符的普通文本不被改动", () => {
        expect(escapeKramdownText("普通文本，含中文与 English mixed 123。")).toBe(
            "普通文本，含中文与 English mixed 123。",
        );
    });
});

describe("kramdown 渲染函数", () => {
    it("renderHighlightBlock：多行每行加 > 前缀，空行以 > 保持引用不断", () => {
        expect(renderHighlightBlock("单行")).toBe("> 单行");
        expect(renderHighlightBlock("第一行\n\n第三行")).toBe("> 第一行\n>\n> 第三行");
        expect(renderHighlightBlock("a\nb\nc").split("\n")).toEqual(["> a", "> b", "> c"]);
    });

    it("renderHighlightBlock：注入文本在块引用内仍逐行转义", () => {
        expect(renderHighlightBlock("# 标题注入")).toBe("> \\# 标题注入");
        expect(renderHighlightBlock("行一\n<script>alert(1)</script>")).toBe(
            "> 行一\n> \\<script>alert(1)\\</script>",
        );
    });

    it("renderReviewChild：首行 - 💭 前缀，续行缩进对齐", () => {
        expect(renderReviewChild("单行想法")).toBe("- 💭 单行想法");
        expect(renderReviewChild("第一行\n第二行")).toBe("- 💭 第一行\n    第二行");
        expect(renderReviewChild("第一行\n\n第三行")).toBe("- 💭 第一行\n    \n    第三行");
    });

    it("renderChapterHeading：### 前缀且转义", () => {
        expect(renderChapterHeading("第 1 章")).toBe("### 第 1 章");
        expect(renderChapterHeading("# 注入")).toBe("### \\# 注入");
    });

    it("区块标题固定文本", () => {
        expect(renderReviewSectionHeading()).toBe("## 📝 想法");
        expect(renderHighlightsSectionHeading()).toBe("## ✂️ 摘录");
    });
});

describe("sanitizeDocTitle", () => {
    it("/ 替换全角斜杠", () => {
        expect(sanitizeDocTitle("三体/黑暗森林", "BID")).toBe("三体／黑暗森林");
    });

    it("去首尾空白", () => {
        expect(sanitizeDocTitle("  活着  ", "BID")).toBe("活着");
        expect(sanitizeDocTitle("\t书名\n", "BID")).toBe("书名");
    });

    it("剔除控制字符", () => {
        expect(sanitizeDocTitle("控\u0000制\u007F符", "BID")).toBe("控制符");
    });

    it("清洗后为空 → bookId 兜底", () => {
        expect(sanitizeDocTitle("", "book-1")).toBe("book-1");
        expect(sanitizeDocTitle("   ", "book-1")).toBe("book-1");
        expect(sanitizeDocTitle("\u0001\u001F", "book-1")).toBe("book-1");
    });
});
