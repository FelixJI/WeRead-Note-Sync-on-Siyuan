/**
 * T04 原生阅读总览投影（docs/design/t04-overview.md，冻结契约 §1/§2/§4）。
 *
 * 投影模型（不建第二套事实源）：
 * - 总览文档按 custom-wrs-overview="1" 属性唯一标识（不以标题绑定）；缺失时创建，已存在原位维护。
 * - 骨架 = stats 槽位块 + books 容器块 + recent 容器块 + notes 复盘区块（各带 custom-wrs-section 属性），
 *   全部是可独立更新的稳定子块，绝不整篇重写。
 * - 清单条目按 custom-wrs-entry="<bookId>" 找/建/更新，内容为原生动态块引用 ((docId '标签'))；
 *   最近摘录按 custom-wrs-recent="<槽位>" 原位更新，引用既有 highlight 锚点块 ID，不复制正文。
 * - 单书 meta 块按 custom-wrs-section="bookmeta" 定位，"只更新这一个自有块"。
 * - 全部为原生 kramdown（动态引用/文本/图片），零 HTML/iframe/CSS 注入（AC4 停用可读）。
 *
 * 更新纪律（§2，复用 T02/T03 机制）：
 * - 全部写入走 SiyuanWriter + 意图先行（oplog intent="project"）→ 执行 → 回读核对 → 记账；
 *   块出生即内嵌 IAL（身份原子落地，T02 §8 INFO 裁决同源）。
 * - updateBlock 仅限"带插件投影属性且回读校验归属"的块（T04 例外裁决）；
 *   同属性多块（伪装/复制属性）→ 跳过+上报，绝不任选，绝不碰无属性块（AC3）。
 * - 任何写失败 → 安全停（本轮投影中止，不影响同步本体结果；引擎捕获计为 warning）。
 * - 用户复盘区（notes）创建后投影永不触碰；总览丢失 → 重建骨架并如实上报（复盘区重建为占位）。
 *   骨架四区（stats/books/recent/notes）首次全部建成后落盘 custom-wrs-init="done" 标记，
 *   区分"初始化未完成"（补建骨架，PR11[7]）与"初始化已完成后复盘区缺失"（用户删除，不复活）。
 */
import { likeEscape, type SiyuanWriter } from "../adapters/siyuan/writer";
import type { OpLog } from "../sync/oplog";
import type { SyncIndex } from "../sync/model";
import { stripIal } from "../sync/engine";

// ---------- 文案（i18n：内核注入键见 src/settings/i18n.ts；此处为投影内置兜底） ----------

export interface OverviewTexts {
    /** 总览文档标题（createDocWithMd 路径段） */
    overviewDocTitle: string;
    /** stats 槽位占位（T05 填充真实数据） */
    statsPlaceholder: string;
    booksSectionTitle: string;
    recentSectionTitle: string;
    /** 复盘区提示文本（创建时一次性写入，此后永不触碰） */
    notesSectionHint: string;
    readingLabel: string;
    finishedLabel: string;
    /** 书籍从来源消失（unseen）时条目上的保留标记 */
    unseenWarning: string;
    syncedLabel: string;
    /** 最近摘录槽位不足时的占位（已有槽位收缩时更新为占位，不删除块） */
    recentEmpty: string;
}

export const OVERVIEW_TEXT_FALLBACK: OverviewTexts = {
    overviewDocTitle: "00 阅读总览",
    statsPlaceholder: "暂无统计数据",
    booksSectionTitle: "📚 书籍清单",
    recentSectionTitle: "🕘 最近摘录",
    notesSectionHint: "此处为你的自由复盘区，插件不会修改本区块内容",
    readingLabel: "在读",
    finishedLabel: "读完",
    unseenWarning: "⚠ 来源未返回",
    syncedLabel: "已同步",
    recentEmpty: "（暂无更多摘录）",
};

export const OVERVIEW_RECENT_LIMIT = 5;
/** 清单条目书名截断（AC5：40 字符加 …） */
export const TITLE_MAX_CHARS = 40;
/** 最近摘录摘要截断（AC2：30 字符加 …，不复制正文） */
export const EXCERPT_MAX_CHARS = 30;

// ---------- 纯格式函数（AC5 单测目标） ----------

/** 按码点截断：超长加省略号 */
function truncateChars(text: string, maxChars: number): string {
    const chars = Array.from(text);
    return chars.length <= maxChars ? text : `${chars.slice(0, maxChars).join("")}…`;
}

/**
 * 块引用标签安全化：控制字符压平、单引号/圆括号/尖括号/与号/双引号全角化。
 * 三重防护：`((id '…'))` 引用语法不可逃逸 + 远端文本永不解释为 HTML（T01 不变量）
 * + 审阅整改 MAJOR-1：真实内核（Lute format renderer）对引用标签做 HTML 实体转义
 *   （& → &amp; 等），写入端全角化使标签不含触发字符，回读全等比较才可长期成立。
 */
function sanitizeRefLabel(text: string): string {
    return text
        .replace(/[\u0000-\u001F\u007F]/g, " ")
        .replace(/'/g, "＇")
        .replace(/\(/g, "（")
        .replace(/\)/g, "）")
        .replace(/</g, "＜")
        .replace(/>/g, "＞")
        .replace(/&/g, "＆")
        .replace(/"/g, "＂")
        .replace(/\{:/g, "｛:")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * 行内文本安全化（meta 段落）：单行、纯字面文本（PR11[1] 整改）。
 * 远端作者名等来源文本中的 Markdown 元字符（图片 `![a](u)`、链接 `[a](u)`、
 * 强调 `*`/`_`/`~~`、行内代码、autolink、IAL 前缀、行内公式 `$` 等）一律全角化，
 * 使其成为字面字符——注入后不构成任何可渲染语法（AGENTS.md L17 远端文本纯文本纪律）。
 * 采用全角化而非反斜杠转义：与 sanitizeRefLabel 同源约定——真实内核 format renderer
 * 会做 HTML 实体转义/归一化，反斜杠转义无法保证回读全等；全角字符原样落地、原样回读。
 */
const INLINE_MARKDOWN_FULLWIDTH: Record<string, string> = {
    "\\": "＼",
    "`": "｀",
    "*": "＊",
    "_": "＿",
    "~": "～",
    "[": "［",
    "]": "］",
    "(": "（",
    ")": "）",
    "!": "！",
    "<": "＜",
    ">": "＞",
    "&": "＆",
    '"': "＂",
    "'": "＇",
    "{": "｛",
    "}": "｝",
    $: "＄",
};

function sanitizeInlineText(text: string): string {
    return text
        .replace(/[\u0000-\u001F\u007F]/g, " ")
        .replace(/[\\`*_~[\]()!<>&"'{}$]/g, (ch) => INLINE_MARKDOWN_FULLWIDTH[ch] ?? ch)
        .replace(/\s+/g, " ")
        .trim();
}

export interface BookEntryLabelInput {
    title: string;
    author?: string;
    /** 读进度百分比（0-100，越界钳制） */
    progressPercent?: number;
    finished?: boolean;
}

/** 清单条目标签：`书名 · 作者 · 进度% · [在读|读完]`（§3 统一格式；缺省段省略，书名截 40 字符加 …） */
export function formatBookEntryLabel(
    input: BookEntryLabelInput,
    texts: OverviewTexts = OVERVIEW_TEXT_FALLBACK,
): string {
    const parts: string[] = [truncateChars(sanitizeRefLabel(input.title), TITLE_MAX_CHARS)];
    if (typeof input.author === "string" && input.author.trim().length > 0) {
        parts.push(sanitizeRefLabel(input.author));
    }
    if (typeof input.progressPercent === "number" && Number.isFinite(input.progressPercent)) {
        parts.push(`${clampPercent(input.progressPercent)}%`);
    }
    parts.push(input.finished === true ? texts.finishedLabel : texts.readingLabel);
    return parts.join(" · ");
}

function clampPercent(value: number): number {
    return Math.min(100, Math.max(0, Math.round(value)));
}

/** 最近摘录摘要：30 字符截断（AC2：引用既有锚点，不复制正文） */
export function formatRecentExcerptLabel(text: string): string {
    return truncateChars(sanitizeRefLabel(text), EXCERPT_MAX_CHARS);
}

/** 清单条目块 markdown：原生动态块引用 `((<docId> '<标签>'))` */
export function renderBookEntryMarkdown(targetBlockId: string, label: string): string {
    return `((${targetBlockId} '${label}'))`;
}

/** kramdown 行内图片 URL 校验：拒绝空白/控制字符/括号/尖括号（防语法逃逸与 HTML 注入，AC4） */
function isSafeImageUrl(url: string | undefined): url is string {
    return typeof url === "string" && url.length > 0 && !/[)<>\s\u0000-\u001F\u007F]/u.test(url);
}

export interface BookMetaInput {
    title: string;
    author?: string;
    progressPercent?: number;
    finished?: boolean;
    /** 同步时间（ISO；取日期部分展示） */
    syncedAt: string;
    /** 封面 URL（缺省则不渲染图片；经 isSafeImageUrl 校验） */
    cover?: string;
}

/** 单书 meta 行：`📖 作者 · 进度% · [在读|读完] · 已同步 <日期>`（有安全封面时前置行内图片） */
export function formatBookMetaLine(input: BookMetaInput, texts: OverviewTexts = OVERVIEW_TEXT_FALLBACK): string {
    const info: string[] = [];
    if (typeof input.author === "string" && input.author.trim().length > 0) {
        info.push(sanitizeInlineText(input.author));
    }
    if (typeof input.progressPercent === "number" && Number.isFinite(input.progressPercent)) {
        info.push(`${clampPercent(input.progressPercent)}%`);
    }
    info.push(input.finished === true ? texts.finishedLabel : texts.readingLabel);
    info.push(`${texts.syncedLabel} ${input.syncedAt.slice(0, 10)}`);
    const textPart = `📖 ${info.join(" · ")}`;
    if (isSafeImageUrl(input.cover)) {
        return `![](${input.cover}) ${textPart}`;
    }
    return textPart;
}

/**
 * 从条目状态还原摘录纯文本：优先 sourcePayload.markText；
 * 无载荷（收养条目）时从 blockquote 渲染快照去 `> ` 前缀取首个非空行。
 */
// ---------- 投影输入 ----------

export interface BookProjectionInfo {
    bookId: string;
    /** 书籍文档根块 ID（清单条目动态引用目标） */
    docId: string;
    title: string;
    author?: string;
    progressPercent?: number;
    finished?: boolean;
    /** 本轮书目概览未返回该书（unseen）：条目保留并标记，绝不删除 */
    unseen: boolean;
    /** 本轮同步成功（单书 meta 块按此刷新同步状态） */
    syncedThisRound: boolean;
    /** 封面 URL（当前网关书目概览无此字段；预留 T05 书 doc meta 接入） */
    cover?: string;
}

export interface RecentHighlightCandidate {
    /** 既有 highlight 锚点块 ID（引用前回读确认存在） */
    blockId: string;
    sourceKey: string;
    /** 来源 createTime（毫秒）；缺失排最后 */
    createTime?: number;
    text: string;
}

export interface ProjectOverviewDeps {
    writer: SiyuanWriter;
    oplog: OpLog;
    notebookId: string;
    /** 本轮后 index（含 books 映射与 overviewDocId 缓存） */
    index: SyncIndex;
    books: BookProjectionInfo[];
    loadRecentHighlights: () => Promise<RecentHighlightCandidate[]>;
    now: () => string;
    newOpId: () => string;
    texts?: OverviewTexts;
    /** 最近摘录条数（默认 5） */
    recentLimit?: number;
}

export interface ProjectOverviewResult {
    /** 已定位/创建的总览文档 ID（硬失败时可能缺失） */
    overviewDocId?: string;
    /** 成功写操作数（创建+更新；稳态为 0） */
    writes: number;
    /** 如实上报：属性歧义跳过、总览重建、复盘区缺失等 */
    anomalies: string[];
    /** 硬失败原因（安全停；由引擎计为 warning，不影响同步本体结果） */
    error?: string;
}

// ---------- 内部机制 ----------

/** 写失败 → 投影安全停（本轮不再写任何块） */
class ProjectionStopError extends Error {}

interface ProjectionCtx {
    deps: ProjectOverviewDeps;
    texts: OverviewTexts;
    anomalies: string[];
    countWrite(): void;
}

function sqlQuote(text: string): string {
    return text.replaceAll("'", "''");
}

function extractIalAttr(ial: string, name: string): string | undefined {
    const m = ial.match(new RegExp(`${name}="([^"]*)"`));
    return m !== null ? m[1] : undefined;
}

function ialSuffix(attrs: Record<string, string>): string {
    return `{: ${Object.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ")}}`;
}

/** 按属性 + root_id 作用域查块（作用域隔离防跨文档认领伪装块） */
async function findAttrBlockIds(
    ctx: ProjectionCtx,
    rootDocId: string,
    attrName: string,
    attrValue: string,
): Promise<string[]> {
    const rows = await ctx.deps.writer.sql(
        `select id from blocks where root_id='${sqlQuote(rootDocId)}' and ial like '%${attrName}="${likeEscape(attrValue)}"%' escape '\\'`,
    );
    return rows.map((r) => r.id);
}

type LocateOwned =
    | { kind: "found"; id: string; content: string }
    | { kind: "missing" }
    | { kind: "skip" };

/**
 * 按属性定位插件自有投影块，回读校验归属（存在性以回读为准）：
 * 0 → missing；多块 → 属性歧义，跳过+上报；回读失败/属性不符 → 跳过+上报。
 */
async function locateOwnedBlock(
    ctx: ProjectionCtx,
    rootDocId: string,
    attrName: string,
    attrValue: string,
    label: string,
): Promise<LocateOwned> {
    const ids = await findAttrBlockIds(ctx, rootDocId, attrName, attrValue);
    if (ids.length > 1) {
        ctx.anomalies.push(`${label}：发现 ${ids.length} 个同属性块（属性歧义），跳过更新待人工处理`);
        return { kind: "skip" };
    }
    if (ids.length === 0) {
        return { kind: "missing" };
    }
    const id = ids[0]!;
    const kramdown = await ctx.deps.writer.getBlockKramdown(id);
    if (kramdown === undefined) {
        ctx.anomalies.push(`${label}：SQL 命中但回读失败，跳过`);
        return { kind: "skip" };
    }
    if (extractIalAttr(kramdown, attrName) !== attrValue) {
        ctx.anomalies.push(`${label}：回读属性归属校验不符，跳过`);
        return { kind: "skip" };
    }
    return { kind: "found", id, content: stripIal(kramdown) };
}

/** 创建投影块：意图先行 → 创建（markdown 内嵌 IAL，身份原子落地）→ 回读核对 → 记账 */
async function createProjectionBlock(
    ctx: ProjectionCtx,
    parentBlockId: string,
    content: string,
    attrs: Record<string, string>,
): Promise<string> {
    const markdown = `${content} ${ialSuffix(attrs)}`;
    const opId = ctx.deps.newOpId();
    await ctx.deps.oplog.append({
        opId,
        ts: ctx.deps.now(),
        intent: "project",
        payloadText: markdown,
        status: "pending",
    });
    let blockId: string;
    try {
        blockId = await ctx.deps.writer.appendChildBlock(markdown, parentBlockId);
        const kramdown = await ctx.deps.writer.getBlockKramdown(blockId);
        if (kramdown === undefined) {
            throw new Error(`回读失败 blockId=${blockId}`);
        }
        if (stripIal(kramdown).trim() !== content.trim()) {
            throw new Error("回读内容与写入不符");
        }
        for (const [k, v] of Object.entries(attrs)) {
            if (extractIalAttr(kramdown, k) !== v) {
                throw new Error(`回读属性 ${k} 未保持`);
            }
        }
    } catch (e) {
        await ctx.deps.oplog.fail(opId, (e as Error).message);
        throw new ProjectionStopError(`投影块创建失败：${(e as Error).message}`);
    }
    await ctx.deps.oplog.complete(opId, { blockId });
    ctx.countWrite();
    return blockId;
}

/** 更新投影块（T04 例外裁决：仅限已校验归属的自有块）：markdown 自带 id+身份属性保身份 */
async function updateProjectionBlock(
    ctx: ProjectionCtx,
    blockId: string,
    content: string,
    attrs: Record<string, string>,
): Promise<void> {
    const markdown = `${content} {: id="${blockId}" ${Object.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ")}}`;
    const opId = ctx.deps.newOpId();
    await ctx.deps.oplog.append({
        opId,
        ts: ctx.deps.now(),
        intent: "project",
        payloadText: markdown,
        status: "pending",
    });
    try {
        await ctx.deps.writer.updateBlockContent(markdown, blockId);
        const kramdown = await ctx.deps.writer.getBlockKramdown(blockId);
        if (kramdown === undefined) {
            throw new Error("更新后回读失败");
        }
        if (stripIal(kramdown).trim() !== content.trim()) {
            throw new Error("更新后回读内容不符");
        }
        for (const [k, v] of Object.entries(attrs)) {
            if (extractIalAttr(kramdown, k) !== v) {
                throw new Error(`更新后属性 ${k} 未保持`);
            }
        }
    } catch (e) {
        await ctx.deps.oplog.fail(opId, (e as Error).message);
        throw new ProjectionStopError(`投影块更新失败（blockId=${blockId}）：${(e as Error).message}`);
    }
    await ctx.deps.oplog.complete(opId, { blockId });
    ctx.countWrite();
}

/**
 * 总览文档定位/创建：index 缓存（回读核实 + 重复身份检查）→ 属性 SQL 找回（回读验归属）→ 重建骨架。
 * initDone：custom-wrs-init="done" 标记（骨架四区首次全部建成后落盘）——
 * 区分"初始化未完成"（补建骨架）与"用户本地删除复盘区"（不复活，AGENTS.md L19）。
 */
async function resolveOverviewDoc(
    ctx: ProjectionCtx,
): Promise<{ docId: string; created: boolean; initDone: boolean }> {
    const { writer, index } = ctx.deps;
    const ns = index.accountNamespace;
    if (index.overviewDocId !== undefined) {
        const cachedId = index.overviewDocId;
        const kramdown = await writer.getBlockKramdown(cachedId);
        // 审阅整改 MINOR-2：缓存命中须验属性（防属性被清/错乱文档被当总览写入骨架）
        if (kramdown !== undefined && isOverviewOwner(kramdown, ns)) {
            // PR11[4] 整改：缓存命中同样做重复身份检查——用户复制总览（带属性）后，
            // 多份 custom-wrs-overview 身份必须按歧义语义安全停，不得绕过 SQL 唯一性检查。
            // SQL 行不作为存在性证据：除缓存外的候选逐一回读核实，回读可验才计为重复。
            const others = (await findOverviewDocIds(ctx)).filter((id) => id !== cachedId);
            for (const id of others) {
                const other = await writer.getBlockKramdown(id);
                if (other !== undefined && isOverviewOwner(other, ns)) {
                    throw new ProjectionStopError(
                        "发现多份总览文档（custom-wrs-overview 属性歧义），投影安全停待人工处理",
                    );
                }
            }
            return { docId: cachedId, created: false, initDone: isInitDone(kramdown) };
        }
    }
    const rows = await findOverviewDocIds(ctx);
    if (rows.length > 1) {
        throw new ProjectionStopError("发现多份总览文档（custom-wrs-overview 属性歧义），投影安全停待人工处理");
    }
    if (rows.length === 1) {
        const docId = rows[0]!;
        const kramdown = await writer.getBlockKramdown(docId);
        if (kramdown !== undefined) {
            // PR11[6] 整改：SQL 恢复路径与缓存路径同规——回读校验 custom-wrs-overview 与
            // custom-wrs-account 归属；不符（属性被清/篡改而索引滞留旧值）→ 安全停，绝不写入。
            if (!isOverviewOwner(kramdown, ns)) {
                throw new ProjectionStopError(
                    "总览文档归属校验失败（custom-wrs-overview/custom-wrs-account 与 SQL 索引不符，疑似属性被清除或篡改），投影安全停",
                );
            }
            return { docId, created: false, initDone: isInitDone(kramdown) };
        }
        // SQL 命中但回读失败（索引滞后或已删）：不写该块，走重建
    }
    const lost = index.overviewDocId !== undefined; // 有缓存却找不到 → 曾丢失
    // 审阅整改 MINOR-3：半程失败孤儿认领——仅认领"空且无 custom-wrs-overview"的同名文档，
    // 防止 createBookDoc 成功而 setBlockAttrs 失败的窗口累积空副本
    {
        const esc = (x: string): string => x.replaceAll("'", "''");
        const byTitle = await writer.sql(
            `select id from blocks where type='d' and content='${esc(ctx.texts.overviewDocTitle)}' and box='${esc(ctx.deps.notebookId)}' and ial not like '%custom-wrs-overview=%'`,
        );
        if (byTitle.length === 1) {
            const cand = byTitle[0].id;
            const children = await writer.sql(
                `select id from blocks where root_id='${esc(cand)}' and id != '${esc(cand)}'`,
            );
            if (children.length === 0) {
                await writer.setBlockAttrs(cand, { "custom-wrs-overview": "1", "custom-wrs-account": ns });
                ctx.anomalies.push("认领了创建中断遗留的空总览孤儿文档");
                return { docId: cand, created: true, initDone: false };
            }
        }
    }
    const opId = ctx.deps.newOpId();
    await ctx.deps.oplog.append({
        opId,
        ts: ctx.deps.now(),
        intent: "project",
        payloadText: `createDocWithMd /${ctx.texts.overviewDocTitle}`,
        status: "pending",
    });
    let createdId = "";
    try {
        const docId = await writer.createBookDoc(ctx.deps.notebookId, ctx.texts.overviewDocTitle);
        await writer.setBlockAttrs(docId, {
            "custom-wrs-overview": "1",
            "custom-wrs-account": ns,
        });
        const kramdown = await writer.getBlockKramdown(docId);
        if (kramdown === undefined || !isOverviewOwner(kramdown, ns)) {
            throw new Error("总览文档属性回读校验失败");
        }
        await ctx.deps.oplog.complete(opId, { blockId: docId });
        ctx.countWrite();
        createdId = docId;
    } catch (e) {
        await ctx.deps.oplog.fail(opId, (e as Error).message);
        throw new ProjectionStopError(`总览文档创建失败：${(e as Error).message}`);
    }
    if (lost) {
        ctx.anomalies.push("总览文档曾丢失，已重建骨架（用户复盘区重建为占位文本）");
    }
    // PR11[2] 整改（已落地，此为契约注释）：创建且回读已验证后直接返回该 docId，
    // 不再以 SQL 二次查询取 docId——SQL 索引滞后时会拿到空结果，破坏骨架创建与缓存。
    return { docId: createdId, created: true, initDone: false };
}

/** 按 custom-wrs-overview="1" + 账号命名空间查总览文档块 ID（SQL 仅为线索，存在性以回读为准） */
async function findOverviewDocIds(ctx: ProjectionCtx): Promise<string[]> {
    const ns = ctx.deps.index.accountNamespace;
    const rows = await ctx.deps.writer.sql(
        `select id from blocks where type='d' and ial like '%custom-wrs-overview="1"%' escape '\\' and ial like '%custom-wrs-account="${likeEscape(ns)}"%' escape '\\'`,
    );
    return rows.map((r) => r.id);
}

/** 回读 kramdown 的总览归属校验：custom-wrs-overview="1" 且 custom-wrs-account=本账号 */
function isOverviewOwner(kramdown: string, ns: string): boolean {
    return (
        extractIalAttr(kramdown, "custom-wrs-overview") === "1" &&
        extractIalAttr(kramdown, "custom-wrs-account") === ns
    );
}

/** 初始化完成标记（custom-wrs-init="done"）：骨架四区首次全部建成后落盘 */
function isInitDone(kramdown: string): boolean {
    return extractIalAttr(kramdown, "custom-wrs-init") === "done";
}

/**
 * 落盘初始化完成标记：意图先行 → setBlockAttrs → 回读核对 → 记账。
 * 此标记之后复盘区缺失才按"用户本地删除"处理（不自动复活，AGENTS.md L19）。
 */
async function markOverviewInitDone(ctx: ProjectionCtx, docId: string): Promise<void> {
    const opId = ctx.deps.newOpId();
    await ctx.deps.oplog.append({
        opId,
        ts: ctx.deps.now(),
        intent: "project",
        payloadText: `setBlockAttrs custom-wrs-init=done ${docId}`,
        status: "pending",
    });
    try {
        await ctx.deps.writer.setBlockAttrs(docId, { "custom-wrs-init": "done" });
        const kramdown = await ctx.deps.writer.getBlockKramdown(docId);
        if (kramdown === undefined || !isInitDone(kramdown)) {
            throw new Error("初始化完成标记回读校验失败");
        }
    } catch (e) {
        await ctx.deps.oplog.fail(opId, (e as Error).message);
        throw new ProjectionStopError(`总览初始化标记写入失败：${(e as Error).message}`);
    }
    await ctx.deps.oplog.complete(opId, { blockId: docId });
    ctx.countWrite();
}

/** 骨架区确保：按 custom-wrs-section 找/建；歧义 → undefined（已上报） */
async function ensureSection(
    ctx: ProjectionCtx,
    overviewDocId: string,
    section: string,
    content: string,
): Promise<string | undefined> {
    const located = await locateOwnedBlock(ctx, overviewDocId, "custom-wrs-section", section, `总览区 ${section}`);
    if (located.kind === "found") {
        return located.id;
    }
    if (located.kind === "skip") {
        return undefined;
    }
    return createProjectionBlock(ctx, overviewDocId, content, { "custom-wrs-section": section });
}

/** 最近摘录排序（最近优先）+ 引用锚点存在性回读确认，取前 limit 条 */
async function collectRecent(ctx: ProjectionCtx, limit: number): Promise<RecentHighlightCandidate[]> {
    const all = await ctx.deps.loadRecentHighlights();
    const sorted = [...all].sort((a, b) => {
        if (a.createTime === undefined && b.createTime === undefined) {
            return a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0;
        }
        if (a.createTime === undefined) return 1;
        if (b.createTime === undefined) return -1;
        if (b.createTime !== a.createTime) return b.createTime - a.createTime;
        return a.sourceKey < b.sourceKey ? -1 : 1;
    });
    const out: RecentHighlightCandidate[] = [];
    for (const candidate of sorted) {
        if (out.length >= limit) {
            break;
        }
        const kramdown = await ctx.deps.writer.getBlockKramdown(candidate.blockId);
        if (kramdown === undefined) {
            continue; // 锚点已不存在（本地删除等）：不引用，跳过
        }
        out.push(candidate);
    }
    return out;
}

// ---------- 主入口 ----------

/**
 * 轮末投影（由引擎在 syncRound 成功末尾调用，§4）：
 * 1) 本轮同步成功各书的 meta 块；2) 总览文档（stats/books/recent/notes 骨架 + 清单条目 + 最近摘录）。
 * 任何写失败安全停（error 返回，不抛出）；歧义/重建等如实上报 anomalies。
 */
export async function projectOverview(deps: ProjectOverviewDeps): Promise<ProjectOverviewResult> {
    const texts = deps.texts ?? OVERVIEW_TEXT_FALLBACK;
    const recentLimit = deps.recentLimit ?? OVERVIEW_RECENT_LIMIT;
    const anomalies: string[] = [];
    let writes = 0;
    let error: string | undefined;
    let overviewDocId: string | undefined;
    const ctx: ProjectionCtx = {
        deps,
        texts,
        anomalies,
        countWrite: () => {
            writes += 1;
        },
    };

    try {
        // ---- 1. 单书 meta 块（本轮同步成功的书；§1"只更新这一个自有块"）----
        for (const book of deps.books) {
            if (!book.syncedThisRound) {
                continue;
            }
            const metaLine = formatBookMetaLine(
                {
                    title: book.title,
                    author: book.author,
                    progressPercent: book.progressPercent,
                    finished: book.finished,
                    syncedAt: deps.now(),
                    cover: book.cover,
                },
                texts,
            );
            const located = await locateOwnedBlock(
                ctx,
                book.docId,
                "custom-wrs-section",
                "bookmeta",
                `书籍元数据 ${book.bookId}`,
            );
            if (located.kind === "missing") {
                await createProjectionBlock(ctx, book.docId, metaLine, { "custom-wrs-section": "bookmeta" });
            } else if (located.kind === "found" && located.content.trim() !== metaLine.trim()) {
                await updateProjectionBlock(ctx, located.id, metaLine, { "custom-wrs-section": "bookmeta" });
            }
        }

        // ---- 2. 总览文档定位/创建 ----
        const resolved = await resolveOverviewDoc(ctx);
        overviewDocId = resolved.docId;

        // stats 槽位（本任务仅占位，永不更新；T05 填充真实数据）
        const statsSectionId = await ensureSection(ctx, resolved.docId, "stats", texts.statsPlaceholder);

        // 用户复盘区：存在即永不触碰（AC3）；首建随骨架创建。
        // PR11[7] 整改：区分"初始化未完成"（custom-wrs-init 标记未落盘 → 骨架此前创建中断，
        // 补建而非误报删除）与"初始化已完成后缺失"（疑似用户删除 → 不自动复活，如实上报）。
        let notesPresent = false;
        const notesIds = await findAttrBlockIds(ctx, resolved.docId, "custom-wrs-section", "notes");
        if (notesIds.length === 1) {
            notesPresent = true; // 投影永不触碰
        } else if (notesIds.length > 1) {
            anomalies.push("复盘区属性歧义（多块），未触碰");
        } else if (resolved.created || !resolved.initDone) {
            await createProjectionBlock(ctx, resolved.docId, texts.notesSectionHint, {
                "custom-wrs-section": "notes",
            });
            notesPresent = true;
            if (!resolved.created) {
                anomalies.push("复盘区因初始化未完成而补建（此前骨架创建中断，并非用户删除）");
            }
        } else {
            anomalies.push("复盘区缺失（疑似被用户删除），按纪律不自动重建、不触碰");
        }

        // ---- 3. 书籍清单条目（找/建/更新；unseen 保留并标记，绝不删除）----
        const booksContainerId = await ensureSection(ctx, resolved.docId, "books", `> ${texts.booksSectionTitle}`);
        if (booksContainerId !== undefined) {
            for (const book of deps.books) {
                const label = formatBookEntryLabel(
                    {
                        title: book.title,
                        author: book.author,
                        progressPercent: book.progressPercent,
                        finished: book.finished,
                    },
                    texts,
                );
                const ref = renderBookEntryMarkdown(book.docId, label);
                const desired = book.unseen ? `${ref} ${texts.unseenWarning}` : ref;
                const located = await locateOwnedBlock(
                    ctx,
                    resolved.docId,
                    "custom-wrs-entry",
                    book.bookId,
                    `清单条目 ${book.bookId}`,
                );
                if (located.kind === "missing") {
                    await createProjectionBlock(ctx, booksContainerId, desired, {
                        "custom-wrs-entry": book.bookId,
                    });
                } else if (located.kind === "found" && located.content.trim() !== desired.trim()) {
                    await updateProjectionBlock(ctx, located.id, desired, { "custom-wrs-entry": book.bookId });
                }
            }
        }

        // ---- 4. 最近摘录槽位（原位更新，槽位数有界；引用既有锚点不复制正文）----
        const recentContainerId = await ensureSection(
            ctx,
            resolved.docId,
            "recent",
            `> ${texts.recentSectionTitle}`,
        );
        if (recentContainerId !== undefined) {
            const recent = await collectRecent(ctx, recentLimit);
            for (let rank = 1; rank <= recentLimit; rank += 1) {
                const item = recent[rank - 1];
                const desired =
                    item === undefined
                        ? texts.recentEmpty
                        : renderBookEntryMarkdown(item.blockId, formatRecentExcerptLabel(item.text));
                const located = await locateOwnedBlock(
                    ctx,
                    resolved.docId,
                    "custom-wrs-recent",
                    String(rank),
                    `最近摘录槽 ${rank}`,
                );
                if (located.kind === "missing") {
                    if (item === undefined) {
                        continue; // 不足 N 条时不建空槽
                    }
                    await createProjectionBlock(ctx, recentContainerId, desired, {
                        "custom-wrs-recent": String(rank),
                    });
                } else if (located.kind === "found" && located.content.trim() !== desired.trim()) {
                    await updateProjectionBlock(ctx, located.id, desired, {
                        "custom-wrs-recent": String(rank),
                    });
                }
            }
        }

        // ---- 5. 初始化完成标记（PR11[7]）：骨架四区俱全 → 首次一次性落盘 custom-wrs-init ----
        // 此后复盘区缺失即按用户删除纪律处理（不自动复活，AGENTS.md L19）；任一区缺失/歧义则不落标记。
        if (
            !resolved.initDone &&
            statsSectionId !== undefined &&
            notesPresent &&
            booksContainerId !== undefined &&
            recentContainerId !== undefined
        ) {
            await markOverviewInitDone(ctx, resolved.docId);
        }
    } catch (e) {
        error = e instanceof ProjectionStopError ? e.message : `投影失败（安全停）：${(e as Error).message}`;
    }

    return {
        overviewDocId,
        writes,
        anomalies,
        ...(error !== undefined ? { error } : {}),
    };
}
