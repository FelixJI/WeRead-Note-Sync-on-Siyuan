// kramdown 渲染与转义（设计契约 §5，冻结）：
// - 远端文本按纯文本行处理，永不解释为 HTML/脚本（T01 不变量延续）；
// - 反斜杠先行转义（防止远端自带转义序列与我们的转义拼接出标记）；
// - 行首 >/#/-/*/+/数字. 强制转义（允许缩进前缀）；
// - `<` 全量转义（HTML 标签形 <...> 因此无法成形）；行首 `>` 由行首规则覆盖；
// - `{: ` 属性 IAL 形态全量转义（kramdown 行首/行尾 IAL 与行内 IAL 均无法成形）。

/** 逐行转义：单行内的 kramdown/HTML 注入防护。 */
function escapeLine(line: string): string {
    // 1. 反斜杠先行：远端已有的 `\` 变 `\\`，不能与我们追加的转义拼接
    let out = line.replace(/\\/g, "\\\\");
    // 2. `<` 全量转义：任何 HTML 标签形 <...> 失去起始符
    out = out.replace(/</g, "\\<");
    // 3. 属性 IAL：`{` 紧跟 `:` 即转义（行首/行中均覆盖）
    out = out.replace(/\{:/g, "\\{:");
    // 4. 行首块级标记（允许缩进）：> / # / - / * / +
    out = out.replace(/^(?<ws>\s*)(?<marker>[>#*+-])/, "$<ws>\\$<marker>");
    // 5. 行首有序列表标记（允许缩进）：数字 + `.`
    out = out.replace(/^(?<ws>\s*)(?<digits>\d+)\./, "$<ws>$<digits>\\.");
    return out;
}

/**
 * kramdown 注入防护转义（纯函数）。CRLF/CR 归一为 LF，逐行应用行级规则。
 * 普通文本（无特殊字符）原样通过。
 */
export function escapeKramdownText(text: string): string {
    return text
        .split(/\r\n|\r|\n/)
        .map(escapeLine)
        .join("\n");
}

/** highlight → blockquote：`> ` 逐行前缀；空行输出 `>` 保持引用不断。 */
export function renderHighlightBlock(markText: string): string {
    return escapeKramdownText(markText)
        .split("\n")
        .map((line) => (line.length > 0 ? `> ${line}` : ">"))
        .join("\n");
}

/** 挂靠/独立 review → list item：首行 `- 💭 `，续行缩进对齐（4 空格）。 */
export function renderReviewChild(content: string): string {
    return escapeKramdownText(content)
        .split("\n")
        .map((line, index) => (index === 0 ? `- 💭 ${line}` : `    ${line}`))
        .join("\n");
}

/** 章节 h3。 */
export function renderChapterHeading(title: string): string {
    return `### ${escapeKramdownText(title)}`;
}

/** "## 📝 想法" 独立想法区标题。 */
export function renderReviewSectionHeading(): string {
    return "## 📝 想法";
}

/** "## ✂️ 摘录" 书首摘录区标题。 */
export function renderHighlightsSectionHeading(): string {
    return "## ✂️ 摘录";
}

/**
 * 文档标题清洗（用于 createDocWithMd 的 "/"+title 路径段）：
 * 剔除控制字符（C0 + DEL）→ `/` 替换全角 → 去首尾空白 → 空则 bookId 兜底。
 */
export function sanitizeDocTitle(title: string, bookId: string): string {
    const cleaned = title
        .replace(/[\u0000-\u001F\u007F]/g, "")
        .replace(/\//g, "／")
        .trim();
    return cleaned.length > 0 ? cleaned : bookId;
}
