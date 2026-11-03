/**
 * T04 原生阅读总览投影测试（Issue #5 AC1–AC5 + 总览重建 + 失败隔离）。
 * 复用 T02 测试的 Fake 全家桶（FakeTransport/FakeKernel/MemoryPersistence，直接 import）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SyncEngine } from "../../src/sync/engine";
import {
    FakeKernel,
    FakeTransport,
    MemoryPersistence,
    fixture,
    type BookScript,
    type FakeBlock,
} from "../sync/engine.test";
import type { KernelCallFn } from "../../src/adapters/siyuan/writer";
import {
    formatBookEntryLabel,
    formatBookMetaLine,
    formatRecentExcerptLabel,
} from "../../src/projections/overview";

const KEY = "wrk-test-key-0001";
const NS = "测试账号";

function makeDeps(
    books: Record<string, BookScript>,
    overviewFields?: { readingProgress?: number; markedStatus?: number; author?: string },
) {
    const transport = new FakeTransport(books);
    if (overviewFields !== undefined) {
        // 向 /user/notebooks 回包注入 readingProgress/markedStatus/author（NotebookSummaryEntry 契约字段）
        const origPost = transport.post.bind(transport);
        transport.post = async (url: string, body: unknown) => {
            const req = body as Record<string, unknown>;
            if (req.api_name === "/user/notebooks") {
                const resp = await origPost(url, body);
                const parsed = JSON.parse(resp.body) as { books: Array<Record<string, unknown>> };
                for (const entry of parsed.books) {
                    if (overviewFields.readingProgress !== undefined) {
                        entry.readingProgress = overviewFields.readingProgress;
                    }
                    if (overviewFields.markedStatus !== undefined) {
                        entry.markedStatus = overviewFields.markedStatus;
                    }
                    if (overviewFields.author !== undefined) {
                        // 官方契约：author 嵌套在 books[].book
                        (entry.book as Record<string, unknown>).author = overviewFields.author;
                    }
                }
                return { ...resp, body: JSON.stringify(parsed) };
            }
            return origPost(url, body);
        };
    }
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
    });
    return { transport, kernel, persistence, engine };
}

function withSecondBook(books: Record<string, BookScript>): Record<string, BookScript> {
    books["10002"] = {
        title: "球状闪电",
        highlights: [{ bookmarkId: "h1", chapterUid: 1, markText: "量子玫瑰", range: "1-9", createTime: 1700000004 }],
        reviews: [],
    };
    return books;
}

// ---------- 查找工具（按 T04 投影属性定位，不按标题） ----------

function overviewDocs(kernel: FakeKernel): FakeBlock[] {
    return kernel.allBlocks().filter((b) => b.type === "d" && b.ial["custom-wrs-overview"] === "1");
}

function overviewDoc(kernel: FakeKernel): FakeBlock {
    const docs = overviewDocs(kernel);
    if (docs.length !== 1) {
        throw new Error(`总览文档数应为 1，实际 ${docs.length}`);
    }
    return docs[0]!;
}

function sectionBlock(kernel: FakeKernel, rootId: string, section: string): FakeBlock | undefined {
    return kernel.allBlocks().find((b) => b.rootId === rootId && b.ial["custom-wrs-section"] === section);
}

function entryBlocks(kernel: FakeKernel, rootId: string): FakeBlock[] {
    return kernel.allBlocks().filter((b) => b.rootId === rootId && b.ial["custom-wrs-entry"] !== undefined);
}

function recentBlocks(kernel: FakeKernel, rootId: string): FakeBlock[] {
    return kernel
        .allBlocks()
        .filter((b) => b.rootId === rootId && b.ial["custom-wrs-recent"] !== undefined)
        .sort((a, b) => Number(a.ial["custom-wrs-recent"]) - Number(b.ial["custom-wrs-recent"]));
}

function metaBlocks(kernel: FakeKernel, bookDocId: string): FakeBlock[] {
    return kernel.allBlocks().filter((b) => b.rootId === bookDocId && b.ial["custom-wrs-section"] === "bookmeta");
}

function bookDocOf(kernel: FakeKernel, bookId: string): FakeBlock {
    const doc = kernel.allBlocks().find((b) => b.ial["custom-wrs-book-id"] === bookId);
    if (doc === undefined) {
        throw new Error(`书籍文档不存在 ${bookId}`);
    }
    return doc;
}

function insertUserBlock(kernel: FakeKernel, parentDocId: string, id: string, content: string): void {
    const doc = kernel.blocks.get(parentDocId)!;
    const block: FakeBlock = {
        id,
        type: "p",
        content,
        markdown: content,
        ial: { id },
        parentId: doc.id,
        rootId: doc.id,
        box: doc.box,
        children: [],
    };
    kernel.blocks.set(id, block);
    doc.children.push(id);
}

// ---------- 测试 ----------

describe("T04 原生阅读总览投影", () => {
    it("AC1：两轮同步总览唯一、清单条目数=书数、条目块 ID 跨轮稳定；改书名/改文档标题绑定不变", async () => {
        const books = withSecondBook(fixture());
        const { kernel, engine } = makeDeps(books);
        await engine.syncRound();
        await engine.syncRound();

        const docs = overviewDocs(kernel);
        expect(docs.length).toBe(1); // 总览唯一（按属性标识）
        const ov = docs[0]!;
        expect(ov.content).toBe("00 阅读总览");
        expect(ov.box).toBe(kernel.notebooks[0]?.id); // 位于"微信读书"笔记本
        expect(sectionBlock(kernel, ov.id, "stats")?.markdown).toContain("阅读时长"); // T05 起轮末填充真实快照（Fake 网关无统计→未知行）

        const entries1 = entryBlocks(kernel, ov.id);
        expect(entries1.length).toBe(2); // 条目数 = 书数
        const ids1 = entries1.map((b) => b.id).sort();

        // 改书文档标题内容（内容改名不改 ID）+ 远端书名变化 → 绑定（docId 引用 + 条目块 ID）不变
        const doc = bookDocOf(kernel, "10001");
        doc.content = "三体（用户改名版）";
        books["10001"]!.title = "三体：新版";
        const r3 = await engine.syncRound();
        expect(r3.ok).toBe(true);
        expect(overviewDocs(kernel).length).toBe(1);
        const entries3 = entryBlocks(kernel, overviewDoc(kernel).id);
        expect(entries3.map((b) => b.id).sort()).toEqual(ids1); // 条目块 ID 跨轮稳定
        const entry = entries3.find((b) => b.ial["custom-wrs-entry"] === "10001")!;
        expect(entry.markdown).toContain(`((${doc.id} `); // 动态引用仍指向原 docId
        expect(entry.markdown).toContain("三体：新版"); // 标签随来源刷新
    });

    it("整改MAJOR1：标签含 & \" > 的书名/摘录 → 全角化写入（规避内核实体转义），两轮幂等无安全停", async () => {
        const books = fixture();
        books["10001"]!.title = '三体&"地球>往事';
        books["10001"]!.highlights[0]!.markText = '给岁月以文明&"而不是>给文明以岁月';
        const { kernel, engine } = makeDeps(books);
        const r1 = await engine.syncRound();
        expect(r1.ok).toBe(true);
        expect(r1.projectionErrors).toBeUndefined();
        const ov = overviewDocs(kernel)[0]!;
        // 全部投影块写入内容不含触发实体转义的半角字符
        const proj = kernel.allBlocks().filter((b) => b.rootId === ov.id || b.ial["custom-wrs-entry"] !== undefined || b.ial["custom-wrs-section"] === "bookmeta");
        for (const b of proj) {
            // 仅动态引用行（((...)) 标签）必须不含实体转义触发字符；> 亦为 blockquote 语法故按行判
            const refLines = b.markdown.split("\n").filter((l) => l.includes("(("));
            for (const line of refLines) {
                expect(line).not.toContain("&");
                expect(line).not.toContain('"');
            }
        }
        expect(kernel.allBlocks().some((b) => b.markdown.includes("三体＆＂地球＞往事"))).toBe(true);
        const r2 = await engine.syncRound();
        expect(r2.ok).toBe(true);
        expect(r2.projectionErrors).toBeUndefined(); // 回读全等成立，无死循环
    });

    it("AC2：清单条目为原生动态块引用；最近摘录引用真实锚点块且不复制正文（30 字截断）", async () => {
        const books = fixture();
        const longText = "这是一条超过三十个字符长度限制的划线内容用于验证截断行为是否生效ABC";
        books["10001"]!.highlights[0]!.markText = longText;
        const { kernel, engine } = makeDeps(books);
        await engine.syncRound();

        const ov = overviewDoc(kernel);
        const doc = bookDocOf(kernel, "10001");
        const entry = entryBlocks(kernel, ov.id).find((b) => b.ial["custom-wrs-entry"] === "10001")!;
        expect(entry.markdown).toMatch(/^\(\(\S+ '.*'\)\)$/u); // ((id '标签')) 结构
        expect(entry.markdown).toContain(`((${doc.id} '`);
        expect(entry.markdown).toContain("三体");
        expect(entry.markdown).toContain("作者");

        // 最近摘录：引用真实 highlight 锚点块（非正文复制）
        const highlightIds = new Set(
            kernel.itemBlocks().filter((b) => b.ial["custom-wrs-src"]!.includes("/highlight/")).map((b) => b.id),
        );
        const recents = recentBlocks(kernel, ov.id);
        expect(recents.length).toBe(3); // fixture 3 条划线
        for (const r of recents) {
            const m = r.markdown.match(/^\(\((\S+) '(.*)'\)\)$/u);
            expect(m).not.toBeNull();
            expect(highlightIds.has(m![1]!)).toBe(true); // 引用既有锚点块 ID
            expect(Array.from(m![2]!).length).toBeLessThanOrEqual(31); // 30 字 + 省略号
        }
        const joined = recents.map((r) => r.markdown).join("\n");
        expect(joined).not.toContain("生效ABC"); // 超长正文被截断，不整段复制
        expect(joined).toContain("…");
    });

    it("AC3：复盘区跨轮逐字不变；无属性用户块零触碰；同属性歧义块（伪装）跳过+上报", async () => {
        const books = fixture();
        const deps = makeDeps(books);
        await deps.engine.syncRound();
        const ov = overviewDoc(deps.kernel);
        const notes = sectionBlock(deps.kernel, ov.id, "notes")!;
        const notesMd = notes.markdown;
        const bookDoc = bookDocOf(deps.kernel, "10001");

        // 手动插入无属性用户块（总览文档内 + 书文档内）
        insertUserBlock(deps.kernel, ov.id, "user-ov-1", "用户自己的总览批注");
        insertUserBlock(deps.kernel, bookDoc.id, "user-bk-1", "用户自己的书内批注");

        // 属性伪装 1：克隆清单条目（同 custom-wrs-entry）→ 属性歧义，必须跳过+上报
        const entry = entryBlocks(deps.kernel, ov.id).find((b) => b.ial["custom-wrs-entry"] === "10001")!;
        const entryParent = deps.kernel.blocks.get(entry.parentId!)!;
        const cloneEntry: FakeBlock = { ...entry, id: "clone-entry", ial: { ...entry.ial, id: "clone-entry" }, children: [] };
        deps.kernel.blocks.set(cloneEntry.id, cloneEntry);
        entryParent.children.push(cloneEntry.id);

        // 属性伪装 2：克隆单书 meta 块（同 custom-wrs-section="bookmeta"）
        const meta = metaBlocks(deps.kernel, bookDoc.id)[0]!;
        const cloneMeta: FakeBlock = { ...meta, id: "clone-meta", ial: { ...meta.ial, id: "clone-meta" }, children: [] };
        deps.kernel.blocks.set(cloneMeta.id, cloneMeta);
        bookDoc.children.push(cloneMeta.id);

        const entryMdBefore = entry.markdown;
        const cloneEntryMdBefore = cloneEntry.markdown;
        const metaMdBefore = meta.markdown;
        const cloneMetaMdBefore = cloneMeta.markdown;

        books["10001"]!.title = "会被跳过的新标题"; // 若误更新，两块内容都会变
        const r2 = await deps.engine.syncRound();
        const r3 = await deps.engine.syncRound();
        expect(r2.ok).toBe(true);
        expect(r3.ok).toBe(true);

        // 复盘区逐字不变
        expect(deps.kernel.blocks.get(notes.id)?.markdown).toBe(notesMd);
        // 无属性用户块零触碰
        expect(deps.kernel.blocks.get("user-ov-1")?.markdown).toBe("用户自己的总览批注");
        expect(deps.kernel.blocks.get("user-bk-1")?.markdown).toBe("用户自己的书内批注");
        // 歧义块全部跳过（未被更新为新标题）
        expect(deps.kernel.blocks.get(entry.id)?.markdown).toBe(entryMdBefore);
        expect(deps.kernel.blocks.get(cloneEntry.id)?.markdown).toBe(cloneEntryMdBefore);
        expect(deps.kernel.blocks.get(meta.id)?.markdown).toBe(metaMdBefore);
        expect(deps.kernel.blocks.get(cloneMeta.id)?.markdown).toBe(cloneMetaMdBefore);
        // 如实上报
        expect(r2.projectionAnomalies?.some((a) => a.includes("清单条目 10001") && a.includes("歧义"))).toBe(true);
        expect(r2.projectionAnomalies?.some((a) => a.includes("书籍元数据 10001") && a.includes("歧义"))).toBe(true);
    });

    it("AC3：他处伪装同属性块不被认领（root_id 作用域隔离）", async () => {
        const books = fixture();
        const deps = makeDeps(books);
        await deps.engine.syncRound();
        const bookDoc = bookDocOf(deps.kernel, "10001");
        // 在书文档里伪造 custom-wrs-entry 属性块（不在总览文档作用域内）
        const fake: FakeBlock = {
            id: "fake-entry",
            type: "p",
            content: "伪装条目",
            markdown: "伪装条目",
            ial: { id: "fake-entry", "custom-wrs-entry": "10001" },
            parentId: bookDoc.id,
            rootId: bookDoc.id,
            box: bookDoc.box,
            children: [],
        };
        deps.kernel.blocks.set(fake.id, fake);
        bookDoc.children.push(fake.id);

        books["10001"]!.title = "总览条目应当更新";
        const r2 = await deps.engine.syncRound();
        expect(r2.ok).toBe(true);
        const ov = overviewDoc(deps.kernel);
        const entries = entryBlocks(deps.kernel, ov.id);
        expect(entries.length).toBe(1); // 总览内条目仍唯一
        expect(entries[0]!.markdown).toContain("总览条目应当更新"); // 正常条目照常更新
        expect(deps.kernel.blocks.get("fake-entry")?.markdown).toBe("伪装条目"); // 伪装块未被认领/触碰
    });

    it("AC4：投影产生的所有块 markdown 无 HTML 标签（含敌意输入）", async () => {
        const books = fixture();
        books["10001"]!.title = "坏<script>书名";
        books["10001"]!.highlights.push({
            bookmarkId: "hx",
            chapterUid: 9,
            markText: "带 <img src=x> 的划线 <iframe onload=alert(1)>",
            range: "1-2",
            createTime: 1700000005,
        });
        const { kernel, engine } = makeDeps(books);
        await engine.syncRound();
        await engine.syncRound();

        const t04Attrs = ["custom-wrs-overview", "custom-wrs-section", "custom-wrs-entry", "custom-wrs-recent"];
        const projected = kernel.allBlocks().filter((b) => t04Attrs.some((a) => b.ial[a] !== undefined));
        expect(projected.length).toBeGreaterThan(0);
        for (const b of projected) {
            expect(b.markdown).not.toContain("<"); // 零 HTML/iframe（停用可读）
        }
        // 敌意划线仍进入最近摘录（以转义形态）
        const ov = overviewDoc(kernel);
        const joined = recentBlocks(kernel, ov.id).map((b) => b.markdown).join("\n");
        expect(joined).toContain("＜img");
    });

    it("AC5：清单文本格式函数——长书名截断 40、在读/读完、进度%、缺省段省略", () => {
        expect(formatBookEntryLabel({ title: "三体", author: "刘慈欣", progressPercent: 45, finished: false })).toBe(
            "三体 · 刘慈欣 · 45% · 在读",
        );
        expect(formatBookEntryLabel({ title: "秘".repeat(41), progressPercent: 100, finished: true })).toBe(
            `${"秘".repeat(40)}… · 100% · 读完`,
        );
        expect(formatBookEntryLabel({ title: "无进度之书" })).toBe("无进度之书 · 在读");
        expect(formatBookEntryLabel({ title: "T", author: "作者甲", progressPercent: 45.6 })).toBe("T · 作者甲 · 46% · 在读");
        expect(formatBookEntryLabel({ title: "T", progressPercent: 120 })).toBe("T · 100% · 在读"); // 越界钳制
        // 摘要 30 字截断（AC2 不复制正文的格式层）
        expect(formatRecentExcerptLabel("长".repeat(35))).toBe(`${"长".repeat(30)}…`);
        expect(formatRecentExcerptLabel("短摘录")).toBe("短摘录");
        // 引号/括号安全化（((id '…')) 语法防护）
        const label = formatBookEntryLabel({ title: "带'引号'与(括号)的书" });
        expect(label).not.toContain("'");
        expect(label).not.toContain("(");
        expect(label).toContain("带＇引号＇与（括号）的书");
    });

    it("AC5：index.scss 仅含插件作用域选择器（零笔记内容 CSS 注入）", () => {
        const scssPath = new URL("../../src/index.scss", import.meta.url);
        const scss = readFileSync(scssPath, "utf8");
        const selectorLines = scss
            .split(/\r\n|\r|\n/)
            .map((l) => l.trim())
            .filter((l) => l.endsWith("{"));
        expect(selectorLines.length).toBeGreaterThanOrEqual(5);
        for (const s of selectorLines) {
            expect(s.startsWith(".weread-note-sync-")).toBe(true); // grep 锁定：全部作用域化
        }
    });

    it("单书 meta 块：作者/进度/读完状态/同步日期；跨轮块 ID 稳定", async () => {
        const books = fixture();
        const deps = makeDeps(books, { readingProgress: 45, markedStatus: 1 });
        await deps.engine.syncRound();
        const bookDoc = bookDocOf(deps.kernel, "10001");
        const metas = metaBlocks(deps.kernel, bookDoc.id);
        expect(metas.length).toBe(1);
        expect(metas[0]!.markdown).toContain("作者");
        expect(metas[0]!.markdown).toContain("45%");
        expect(metas[0]!.markdown).toContain("读完");
        expect(metas[0]!.markdown).toContain("已同步 2026-11-03");
        const id1 = metas[0]!.id;

        await deps.engine.syncRound();
        const metas2 = metaBlocks(deps.kernel, bookDoc.id);
        expect(metas2.length).toBe(1);
        expect(metas2[0]!.id).toBe(id1); // 原位更新，块 ID 稳定
        expect(metas2[0]!.markdown).toBe(metas[0]!.markdown); // 内容未变 → 零写入
    });

    it("unseen 书：清单条目保留并标 ⚠ 来源未返回，绝不删除", async () => {
        const books = withSecondBook(fixture());
        const deps = makeDeps(books);
        await deps.engine.syncRound();
        delete books["10002"]; // 来源不再返回该书

        const r2 = await deps.engine.syncRound();
        expect(r2.ok).toBe(true);
        const ov = overviewDoc(deps.kernel);
        const entry = entryBlocks(deps.kernel, ov.id).find((b) => b.ial["custom-wrs-entry"] === "10002");
        expect(entry).toBeDefined(); // 条目保留
        expect(entry!.markdown).toContain("⚠ 来源未返回");
        expect(entry!.markdown).toContain(`((${bookDocOf(deps.kernel, "10002").id} `); // 引用仍有效
    });

    it("总览丢失 → 下轮重建骨架，复盘区占位如实上报，index.overviewDocId 更新", async () => {
        const books = fixture();
        const deps = makeDeps(books);
        await deps.engine.syncRound();
        const ov = overviewDoc(deps.kernel);
        // 删除总览文档（连同子块）
        for (const b of deps.kernel.allBlocks()) {
            if (b.rootId === ov.id) {
                deps.kernel.blocks.delete(b.id);
            }
        }
        deps.kernel.blocks.delete(ov.id);

        const r2 = await deps.engine.syncRound();
        expect(r2.ok).toBe(true);
        const ov2 = overviewDoc(deps.kernel);
        expect(ov2.id).not.toBe(ov.id); // 重建（新文档）
        expect(ov2.content).toBe("00 阅读总览");
        for (const s of ["stats", "books", "recent", "notes"]) {
            expect(sectionBlock(deps.kernel, ov2.id, s)).toBeDefined();
        }
        const notes = sectionBlock(deps.kernel, ov2.id, "notes")!;
        expect(notes.markdown).toContain("复盘区"); // 复盘区重建为占位（如实）
        expect(r2.projectionAnomalies?.some((a) => a.includes("重建"))).toBe(true);
        // 条目随骨架重建，仍引用原书籍文档
        const entries = entryBlocks(deps.kernel, ov2.id);
        expect(entries.length).toBe(1);
        expect(entries[0]!.markdown).toContain(`((${bookDocOf(deps.kernel, "10001").id} `);
        // index 缓存已更新
        const idx = deps.persistence.store.get("index") as { overviewDocId?: string };
        expect(idx.overviewDocId).toBe(ov2.id);
    });

    it("投影失败不影响同步本体结果（updateBlock 注入失败 → outcome.ok、projectionErrors=1）", async () => {
        const books = fixture();
        const deps = makeDeps(books);
        await deps.engine.syncRound();
        books["10001"]!.title = "新标题触发条目更新";
        deps.kernel.failNext.add("/api/block/updateBlock");

        const r2 = await deps.engine.syncRound();
        expect(r2.ok).toBe(true); // 同步本体结果不受投影失败影响
        expect(r2.books[0]?.created).toBe(0);
        expect(r2.books[0]?.error).toBeUndefined();
        expect(r2.projectionErrors).toBe(1); // 投影错误计为 warning
        // 条目保持旧内容（更新失败安全停，不重试）
        const ov = overviewDoc(deps.kernel);
        const entry = entryBlocks(deps.kernel, ov.id).find((b) => b.ial["custom-wrs-entry"] === "10001")!;
        expect(entry.markdown).toContain("三体");
        // oplog 留有 project 失败记录
        const oplog = deps.persistence.store.get("oplog") as Array<{ intent: string; status: string }>;
        expect(oplog.some((e) => e.intent === "project" && e.status === "failed")).toBe(true);
    });

    it("投影开关关闭（projectOverview: false）→ 零投影写入", async () => {
        const books = fixture();
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
        const r = await engine.syncRound();
        expect(r.ok).toBe(true);
        expect(r.projectionErrors).toBeUndefined();
        expect(overviewDocs(kernel).length).toBe(0);
        expect(kernel.allBlocks().some((b) => b.ial["custom-wrs-section"] !== undefined)).toBe(false);
    });

    // ---------- PR11 评审整改 ----------

    it("PR11[1]：作者名含图片/链接/强调/代码等 Markdown 元字符 → meta 行按字面全角文本输出", () => {
        const line = formatBookMetaLine({
            title: "T",
            author: "![tracking](https://example.com/pixel) [l](siyuan://blocks/x) *b* `c` <i> & \"q\" {:ks} $m$ ~~s~~",
            progressPercent: 10,
            finished: false,
            syncedAt: "2026-11-03T00:00:00Z",
        });
        expect(line).not.toMatch(/!\[/u); // 不再构成图片语法
        expect(line).not.toMatch(/\]\(/u); // 不再构成链接语法
        expect(line).not.toContain("*");
        expect(line).not.toContain("`");
        expect(line).not.toContain("<");
        expect(line).not.toContain("$");
        expect(line).not.toContain("~");
        // 恶意作者名以字面文本呈现（全角化，语义不变）
        expect(line).toContain("！［tracking］（https://example.com/pixel）");
        expect(line).toContain("［l］（siyuan://blocks/x）");
        expect(line).toContain("＊b＊");
        expect(line).toContain("｀c｀");
        expect(line).toContain("＜i＞");
        expect(line).toContain("＆ ＂q＂");
        expect(line).toContain("｛:ks｝");
        expect(line).toContain("＄m＄");
        expect(line).toContain("～～s～～");
    });

    it("PR11[1]：远端恶意作者名 → meta 块按字面文本写入，两轮幂等无安全停", async () => {
        const books = fixture();
        const deps = makeDeps(books, { author: "![tracking](https://example.com/pixel)" });
        const r1 = await deps.engine.syncRound();
        expect(r1.ok).toBe(true);
        expect(r1.projectionErrors).toBeUndefined();
        const bookDoc = bookDocOf(deps.kernel, "10001");
        const metas = metaBlocks(deps.kernel, bookDoc.id);
        expect(metas.length).toBe(1);
        expect(metas[0]!.markdown).not.toContain("![");
        expect(metas[0]!.markdown).not.toContain("](");
        expect(metas[0]!.markdown).toContain("！［tracking］（https://example.com/pixel）");
        const r2 = await deps.engine.syncRound();
        expect(r2.ok).toBe(true);
        expect(r2.projectionErrors).toBeUndefined(); // 回读全等成立，无死循环
    });

    it("PR11[2] 回归：SQL 索引滞后（总览身份查询空结果）→ 创建成功仍返回已验证 docId", async () => {
        const books = fixture();
        const transport = new FakeTransport(books);
        const kernel = new FakeKernel();
        const persistence = new MemoryPersistence();
        // 模拟索引滞后：所有含 custom-wrs-overview="1" 的身份查询暂返回空
        const laggedKernel: KernelCallFn = async (path, data) => {
            if (path === "/api/query/sql") {
                const sql = String((data as { sql?: unknown }).sql ?? "");
                if (sql.includes('custom-wrs-overview="1"')) {
                    return { code: 0, msg: "", data: [] };
                }
            }
            return kernel.call(path, data);
        };
        let seq = 0;
        const engine = new SyncEngine({
            persistence,
            kernel: laggedKernel,
            transport,
            apiKey: KEY,
            accountNamespace: NS,
            now: () => "2026-11-03T00:00:00Z",
            newOpId: () => `op-${String((seq += 1)).padStart(4, "0")}`,
        });
        const r1 = await engine.syncRound();
        expect(r1.ok).toBe(true);
        expect(r1.projectionErrors).toBeUndefined(); // 创建+回读已验证，不依赖 SQL 可见性
        const ov = kernel.allBlocks().find((b) => b.type === "d" && b.ial["custom-wrs-overview"] === "1");
        expect(ov).toBeDefined();
        for (const s of ["stats", "books", "recent", "notes"]) {
            expect(sectionBlock(kernel, ov!.id, s)).toBeDefined(); // 骨架完整
        }
        const idx = persistence.store.get("index") as { overviewDocId?: string };
        expect(idx.overviewDocId).toBe(ov!.id); // 保存的是已验证 docId，而非 SQL 二查的空结果
        // 第二轮（缓存命中路径）在滞后 SQL 下仍正常
        const r2 = await engine.syncRound();
        expect(r2.ok).toBe(true);
        expect(r2.projectionErrors).toBeUndefined();
    });

    it("PR11[4]：缓存命中仍做重复身份检查——复制总览（带属性）→ 歧义安全停", async () => {
        const books = fixture();
        const deps = makeDeps(books);
        await deps.engine.syncRound();
        const ov = overviewDoc(deps.kernel);
        // 用户复制总览文档（身份属性随副本带走）→ 两份 custom-wrs-overview 身份
        const copy: FakeBlock = {
            id: "ov-copy",
            type: "d",
            content: ov.content,
            markdown: ov.markdown,
            ial: { ...ov.ial, id: "ov-copy" },
            parentId: null,
            rootId: "ov-copy",
            box: ov.box,
            children: [],
        };
        deps.kernel.blocks.set(copy.id, copy);

        books["10001"]!.title = "若未安全停会被写入条目的新标题";
        const r2 = await deps.engine.syncRound();
        expect(r2.ok).toBe(true); // 同步本体不受影响
        expect(r2.projectionErrors).toBe(1);
        expect(r2.projectionAnomalies?.some((a) => a.includes("多份总览"))).toBe(true);
        // 安全停：缓存副本的条目未被更新为伪新标题
        const entry = entryBlocks(deps.kernel, ov.id).find((b) => b.ial["custom-wrs-entry"] === "10001")!;
        expect(entry.markdown).toContain("三体");
        // 复制副本未被写入任何骨架
        expect(sectionBlock(deps.kernel, "ov-copy", "stats")).toBeUndefined();
        expect(sectionBlock(deps.kernel, "ov-copy", "notes")).toBeUndefined();
    });

    it("PR11[6]：SQL 恢复路径校验归属——属性被清但索引滞留旧值 → 安全停不写", async () => {
        const books = fixture();
        const transport = new FakeTransport(books);
        const kernel = new FakeKernel();
        const persistence = new MemoryPersistence();
        // 第二轮起注入"索引滞留"：总览身份查询仍返回旧 doc 行
        let staleRows: Array<{ id: string }> | undefined;
        const wrappedKernel: KernelCallFn = async (path, data) => {
            if (path === "/api/query/sql" && staleRows !== undefined) {
                const sql = String((data as { sql?: unknown }).sql ?? "");
                if (sql.includes('custom-wrs-overview="1"')) {
                    return { code: 0, msg: "", data: staleRows };
                }
            }
            return kernel.call(path, data);
        };
        let seq = 0;
        const engine = new SyncEngine({
            persistence,
            kernel: wrappedKernel,
            transport,
            apiKey: KEY,
            accountNamespace: NS,
            now: () => "2026-11-03T00:00:00Z",
            newOpId: () => `op-${String((seq += 1)).padStart(4, "0")}`,
        });
        await engine.syncRound();
        const ov = kernel.allBlocks().find((b) => b.ial["custom-wrs-overview"] === "1")!;
        expect(ov).toBeDefined();
        // 用户清除身份属性（缓存路径回读即失配）+ SQL 索引仍滞留旧值
        delete ov.ial["custom-wrs-overview"];
        staleRows = [{ id: ov.id }];

        books["10001"]!.title = "若归属失守会被写入条目的新标题";
        const r2 = await engine.syncRound();
        expect(r2.ok).toBe(true);
        expect(r2.projectionErrors).toBeGreaterThanOrEqual(1);
        expect(r2.projectionAnomalies?.some((a) => a.includes("SQL 索引不符"))).toBe(true);
        // 失属文档未被写入任何总览更新：条目仍是旧标题
        const entry = kernel.allBlocks().filter((b) => b.ial["custom-wrs-entry"] === "10001")[0]!;
        expect(entry.markdown).toContain("三体");
        // 未重建第二份总览文档
        expect(kernel.allBlocks().filter((b) => b.type === "d").length).toBe(2);
    });

    it("PR11[7]：首轮 notes 创建失败 → 下轮补建骨架而非误报用户删除；初始化完成后删除仍按删除纪律", async () => {
        const books = fixture();
        const transport = new FakeTransport(books);
        const kernel = new FakeKernel();
        const persistence = new MemoryPersistence();
        // 注入一次失败：复盘区（custom-wrs-section="notes"）创建中断（文档已建成）
        let failNotesOnce = true;
        const wrappedKernel: KernelCallFn = async (path, data) => {
            if (path === "/api/block/appendBlock" && failNotesOnce) {
                const md = String((data as { data?: unknown }).data ?? "");
                if (md.includes('custom-wrs-section="notes"')) {
                    failNotesOnce = false;
                    return { code: -1, msg: "注入：复盘区创建失败" };
                }
            }
            return kernel.call(path, data);
        };
        let seq = 0;
        const engine = new SyncEngine({
            persistence,
            kernel: wrappedKernel,
            transport,
            apiKey: KEY,
            accountNamespace: NS,
            now: () => "2026-11-03T00:00:00Z",
            newOpId: () => `op-${String((seq += 1)).padStart(4, "0")}`,
        });

        const r1 = await engine.syncRound();
        expect(r1.ok).toBe(true);
        expect(r1.projectionErrors).toBe(1); // 投影安全停：notes 创建失败
        const ov = kernel.allBlocks().find((b) => b.ial["custom-wrs-overview"] === "1")!;
        expect(ov).toBeDefined();
        expect(sectionBlock(kernel, ov.id, "stats")).toBeDefined(); // stats 已建（notes 之前）
        expect(sectionBlock(kernel, ov.id, "notes")).toBeUndefined(); // notes 确实未建成

        const r2 = await engine.syncRound();
        expect(r2.ok).toBe(true);
        expect(r2.projectionErrors).toBeUndefined();
        // 初始化未完成 → 补建复盘区，绝不误报"疑似被用户删除"
        expect(r2.projectionAnomalies?.some((a) => a.includes("疑似被用户删除"))).toBe(false);
        expect(r2.projectionAnomalies?.some((a) => a.includes("初始化未完成"))).toBe(true);
        for (const s of ["stats", "books", "recent", "notes"]) {
            expect(sectionBlock(kernel, ov.id, s)).toBeDefined(); // 骨架补建完成
        }
        expect(ov.ial["custom-wrs-init"]).toBe("done"); // 初始化完成标记落盘

        const r3 = await engine.syncRound();
        expect(r3.ok).toBe(true);
        expect(r3.projectionErrors).toBeUndefined();
        expect(r3.projectionAnomalies ?? []).toEqual([]); // 稳态零异常、零误报

        // 初始化完成后用户删除复盘区 → 按删除纪律：不自动复活、如实上报（AGENTS.md L19）
        const notes = sectionBlock(kernel, ov.id, "notes")!;
        kernel.blocks.delete(notes.id);
        const r4 = await engine.syncRound();
        expect(r4.ok).toBe(true);
        expect(r4.projectionErrors).toBeUndefined();
        expect(r4.projectionAnomalies?.some((a) => a.includes("疑似被用户删除"))).toBe(true);
        expect(sectionBlock(kernel, ov.id, "notes")).toBeUndefined(); // 未复活
    });
});
