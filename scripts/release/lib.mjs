/**
 * 发版纯函数库（Issue #16）：版本三档递增、中文 Conventional Commits 解析、
 * 更新日志分组渲染、CHANGELOG 头部插入、package.json/plugin.json 双源版本同步。
 * 零依赖；提交信息一律按纯文本处理（转义方括号/反引号），不作为可执行 Markdown 注入。
 */

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const BUMPS = new Set(["patch", "minor", "major"]);

/** semver 三档递增；非法当前版本或非法档位抛错（先校验后计算，不静默兜底） */
export function nextVersion(current, bump) {
    if (typeof current !== "string" || !SEMVER_RE.test(current)) {
        throw new Error(`非法当前版本：${current}`);
    }
    if (typeof bump !== "string" || !BUMPS.has(bump)) {
        throw new Error(`非法档位：${bump}（仅 patch/minor/major）`);
    }
    const [major, minor, patch] = current.split(".").map(Number);
    if (bump === "major") return `${major + 1}.0.0`;
    if (bump === "minor") return `${major}.${minor + 1}.0`;
    return `${major}.${minor}.${patch + 1}`;
}

// type(中文scope)!: 描述 —— type 限 ASCII 词（可带连字符），scope 允许任意非右括号字符
const COMMIT_RE = /^([a-zA-Z][a-zA-Z0-9-]*)(?:\(([^)]*)\))?!?:\s+(.+)$/;
// PR squash 尾缀：描述以 "(#N)" 结尾（前面必须有空白）
const PR_RE = /\s+\(#(\d+)\)$/;

/**
 * 解析单条提交 subject → { type, scope, subject, pr }。
 * 不符合 Conventional Commits 的行（如 Initial commit、merge 说明）type 为 null，渲染时归“其他”。
 */
export function parseCommitLine(subject) {
    const raw = typeof subject === "string" ? subject.trim() : "";
    const stripPr = (text) => {
        const m = text.match(PR_RE);
        return m ? { text: text.slice(0, text.length - m[0].length), pr: Number(m[1]) } : { text, pr: null };
    };
    const m = raw.match(COMMIT_RE);
    if (!m) {
        const noPr = stripPr(raw);
        return { type: null, scope: "", subject: noPr.text, pr: noPr.pr };
    }
    const desc = stripPr(m[3].trim());
    return {
        type: m[1].toLowerCase(),
        scope: m[2] ?? "",
        subject: desc.text,
        pr: desc.pr,
    };
}

// 分组次序即输出次序；key 为 null 的桶收留未知 type 与无 type 提交
const SECTIONS = [
    { key: "feat", title: "🎉 新增" },
    { key: "fix", title: "🐛 修复" },
    { key: "test", title: "✅ 测试" },
    { key: "docs", title: "📝 文档" },
    { key: "refactor", title: "♻️ 重构" },
    { key: null, title: "🔧 其他" },
];

/** 行内纯文本转义：防提交信息里的 Markdown 语法破坏日志结构 */
function escapeInline(text) {
    return text.replace(/([[\]`])/g, "\\$1");
}

/** 渲染单个版本的更新日志节（不含“# 更新日志”总标题；空提交列表只输出标题行） */
export function renderChangelog({ version, prevTag, date, commits, repoUrl }) {
    const title = prevTag
        ? `## [v${version}](${repoUrl}/compare/${prevTag}...v${version})（${date}）`
        : `## v${version}（${date}）`;
    const groups = new Map();
    for (const c of commits) {
        const known = SECTIONS.some((s) => s.key === c.type);
        const key = known ? c.type : null;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(c);
    }
    const parts = [title];
    for (const s of SECTIONS) {
        const list = groups.get(s.key);
        if (!list) continue;
        parts.push("", `### ${s.title}`, "");
        for (const c of list) {
            const scope = c.scope ? `**${escapeInline(c.scope)}**：` : "";
            const pr = c.pr != null ? `（[#${c.pr}](${repoUrl}/pull/${c.pr})）` : "";
            parts.push(`- ${scope}${escapeInline(c.subject)}${pr}`);
        }
    }
    return parts.join("\n");
}

const CHANGELOG_HEADER = "# 更新日志";

/** 向 CHANGELOG.md 头部插入新节；文件不存在/为空则带总标题创建，旧内容原样保留 */
export function mergeChangelog(existingMd, newSection) {
    const trimmed = typeof existingMd === "string" ? existingMd.trim() : "";
    if (trimmed === "") {
        return `${CHANGELOG_HEADER}\n\n${newSection}\n`;
    }
    const lines = trimmed.split("\n");
    const rest = (lines[0].trim() === CHANGELOG_HEADER ? lines.slice(1).join("\n") : trimmed).trim();
    return rest === ""
        ? `${CHANGELOG_HEADER}\n\n${newSection}\n`
        : `${CHANGELOG_HEADER}\n\n${newSection}\n\n${rest}\n`;
}

/** 探测 JSON 文件缩进（取第一个属性行的前导空白），探测失败回退 2 空格 */
function detectIndent(text) {
    const m = text.match(/^[^\n]*\n([ \t]+)"/);
    return m ? m[1] : "  ";
}

function rewriteVersion(text, newVersion, label) {
    let obj;
    try {
        obj = JSON.parse(text);
    } catch {
        throw new Error(`${label} 不是合法 JSON`);
    }
    if (typeof obj?.version !== "string") {
        throw new Error(`${label} 缺少 version 字段`);
    }
    const indent = detectIndent(text);
    const trailingNewline = text.endsWith("\n");
    obj.version = newVersion;
    return JSON.stringify(obj, null, indent) + (trailingNewline ? "\n" : "");
}

/** 同步改写 package.json 与 plugin.json 的 version；保持各自缩进、键序与行尾不变 */
export function updateVersionFields(pkgText, pluginText, newVersion) {
    if (typeof newVersion !== "string" || !SEMVER_RE.test(newVersion)) {
        throw new Error(`非法目标版本：${newVersion}`);
    }
    return {
        pkgText: rewriteVersion(pkgText, newVersion, "package.json"),
        pluginText: rewriteVersion(pluginText, newVersion, "plugin.json"),
    };
}
