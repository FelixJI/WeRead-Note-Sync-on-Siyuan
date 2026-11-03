/**
 * 同步引擎故障注入测试（Issue #3 AC1–AC7）。
 *
 * 全部使用内存 Fake：FakeTransport（网关）、FakeKernel（思源内核含迷你 SQL）、
 * MemoryPersistence（双世代状态）。不访问真实网络与内核。
 */
import { describe, expect, it } from "vitest";
import type { Transport } from "../../src/core/net/transport";
import type { KernelCallFn } from "../../src/adapters/siyuan/writer";
import type { StatePersistence } from "../../src/sync/state/store";
import { SyncEngine } from "../../src/sync/engine";

const KEY = "wrk-test-key-0001";
const NS = "测试账号";

// ---------- FakeTransport ----------

export interface RawHighlight {
    bookmarkId: string;
    chapterUid: number;
    markText: string;
    range: string;
    createTime: number;
    type?: number;
}

export interface RawReview {
    review: {
        reviewId: string;
        content: string;
        range?: string;
        chapterUid?: number;
        chapterIdx?: number;
        createTime?: number;
        star?: number;
    };
    abstract?: string;
}

export interface BookScript {
    title: string;
    highlights: RawHighlight[];
    reviews: RawReview[];
    /** 模拟 bookmarklist 回包异常（updated 非数组 → complete=false） */
    bookmarkListBroken?: boolean;
}

export class FakeTransport implements Transport {
    constructor(public books: Record<string, BookScript>) {}

    async post(_url: string, body: unknown): Promise<{ status: number; body: string; contentType?: string }> {
        void _url;
        const req = body as Record<string, unknown>;
        const api = req.api_name;
        if (api === "/user/notebooks") {
            const entries = Object.entries(this.books).map(([bookId, b], i) => ({
                bookId,
                book: { title: b.title, author: "作者" },
                noteCount: b.highlights.length,
                reviewCount: b.reviews.length,
                bookmarkCount: 0,
                sort: 1000 - i,
            }));
            return {
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    errcode: 0,
                    totalBookCount: entries.length,
                    hasMore: 0,
                    books: entries,
                }),
            };
        }
        if (api === "/book/bookmarklist") {
            const bookId = String(req.bookId);
            const b = this.books[bookId];
            if (b === undefined || b.bookmarkListBroken) {
                return { status: 200, body: JSON.stringify({ errcode: 0, updated: null }), contentType: "application/json" };
            }
            const chapterUids = [...new Set(b.highlights.map((h) => h.chapterUid))];
            return {
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    errcode: 0,
                    updated: b.highlights,
                    chapters: chapterUids.map((uid) => ({ chapterUid: uid, chapterIdx: uid, title: `第${uid}章` })),
                    book: { title: b.title },
                }),
            };
        }
        if (api === "/review/list/mine") {
            const bookId = String(req.bookid);
            const b = this.books[bookId];
            const reviews = b === undefined ? [] : b.reviews;
            return {
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ errcode: 0, hasMore: 0, synckey: "", reviews, totalCount: reviews.length }),
            };
        }
        return { status: 200, body: JSON.stringify({ errcode: -1, errmsg: `未知 api ${String(api)}` }), contentType: "application/json" };
    }
}

// ---------- FakeKernel ----------

interface FakeBlock {
    id: string;
    type: string; // d / h / 其他
    content: string;
    markdown: string; // 不含 IAL 的正文 markdown
    ial: Record<string, string>; // 含 id
    parentId: string | null;
    rootId: string | null;
    box?: string;
    children: string[];
}

export class FakeKernel {
    blocks = new Map<string, FakeBlock>();
    notebooks: Array<{ id: string; name: string; closed: boolean }> = [];
    #seq = 0;
    failNext = new Set<string>();
    /** T03 测试钩子：updateBlock 后丢弃 custom-wrs-src（模拟身份属性丢失） */
    dropIdentityOnUpdate = false;
    /** T03 测试钩子：第 N 次（1 起）getBlockKramdown 返回失败（模拟验证回读失败） */
    failReadAt = new Set<number>();
    readCount = 0;
    /** 命中时执行变更但返回错误（模拟响应丢失）：按 API 的第 N 次调用（1 起） */
    dropAt = new Map<string, Set<number>>();
    #callCounts = new Map<string, number>();

    #id(prefix: string): string {
        this.#seq += 1;
        return `${prefix}-${String(this.#seq).padStart(4, "0")}`;
    }

    #takeFault(api: string): "fail" | "drop" | "ok" {
        const n = (this.#callCounts.get(api) ?? 0) + 1;
        this.#callCounts.set(api, n);
        if (this.failNext.delete(api)) {
            return "fail";
        }
        const drops = this.dropAt.get(api);
        if (drops !== undefined && drops.delete(n)) {
            return "drop";
        }
        return "ok";
    }

    allBlocks(): FakeBlock[] {
        return [...this.blocks.values()];
    }

    itemBlocks(): FakeBlock[] {
        return this.allBlocks().filter((b) => b.ial["custom-wrs-src"] !== undefined);
    }

    /** 解析创建 markdown：剥离尾随 IAL */
    static parseMarkdown(data: string): { body: string; attrs: Record<string, string> } {
        const m = data.match(/\s*\{:(.*)\}\s*$/);
        const attrs: Record<string, string> = {};
        let body = data;
        if (m !== null) {
            body = data.slice(0, m.index);
            for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) {
                attrs[a[1]] = a[2];
            }
        }
        return { body: body.trimEnd(), attrs };
    }

    static blockType(body: string): string {
        if (/^#{1,6} /u.test(body)) {
            return "h";
        }
        if (/^> /u.test(body)) {
            return "quote";
        }
        if (/^[-*+] /u.test(body)) {
            return "li";
        }
        return "p";
    }

    #attach(block: FakeBlock, parent: FakeBlock | null): void {
        block.parentId = parent !== null ? parent.id : null;
        block.rootId = parent !== null ? (parent.type === "d" ? parent.id : parent.rootId) : block.id;
        block.box = parent !== null ? parent.box : undefined;
        if (parent !== null) {
            parent.children.push(block.id);
        }
    }

    call: KernelCallFn = async (path: string, data: unknown): Promise<unknown> => {
        const fault = this.#takeFault(path);
        const failResp = { code: -1, msg: `注入故障 ${path}` };
        if (fault === "fail") {
            // failNext：不执行任何变更，直接返回错误
            return failResp;
        }
        const rec = data as Record<string, unknown>;
        switch (path) {
            case "/api/notebook/createNotebook": {
                // 真实内核形状（审阅 B1）：data.notebook.id
                const nb = { id: this.#id("nb"), name: String(rec.name), closed: false };
                this.notebooks.push(nb);
                return { code: 0, msg: "", data: { notebook: nb } };
            }
            case "/api/notebook/lsNotebooks":
                return { code: 0, msg: "", data: { notebooks: this.notebooks } };
            case "/api/filetree/createDocWithMd": {
                const title = String(rec.path).replace(/^\//u, "");
                const block: FakeBlock = {
                    id: this.#id("doc"),
                    type: "d",
                    content: title,
                    markdown: String(rec.markdown ?? ""),
                    ial: { id: "" },
                    parentId: null,
                    rootId: null,
                    box: this.notebooks[0]?.id,
                    children: [],
                };
                block.ial.id = block.id;
                block.rootId = block.id;
                this.blocks.set(block.id, block);
                return { code: 0, msg: "", data: block.id };
            }
            case "/api/block/insertBlock":
            case "/api/block/appendBlock": {
                const { body, attrs } = FakeKernel.parseMarkdown(String(rec.data));
                const type = FakeKernel.blockType(body);
                const content =
                    type === "h" ? body.replace(/^#{1,6} /u, "") : body.replace(/^(> |- 💭 |[-*+] )/u, "");
                const block: FakeBlock = {
                    id: this.#id("b"),
                    type,
                    content,
                    markdown: body,
                    ial: { id: "", ...attrs },
                    parentId: null,
                    rootId: null,
                    box: undefined,
                    children: [],
                };
                block.ial.id = block.id;
                let parent: FakeBlock | null = null;
                if (path === "/api/block/appendBlock") {
                    parent = this.blocks.get(String(rec.parentID)) ?? null;
                } else {
                    const prev = this.blocks.get(String(rec.previousID));
                    if (prev === undefined) {
                        return failResp;
                    }
                    parent = prev.parentId !== null ? this.blocks.get(prev.parentId) ?? null : null;
                }
                this.#attach(block, parent);
                this.blocks.set(block.id, block);
                if (fault === "drop") {
                    return failResp; // 块已创建但调用方收到错误（响应丢失）
                }
                return {
                    code: 0,
                    msg: "",
                    data: [{ doOperations: [{ action: "insert", id: block.id }] }],
                };
            }
            case "/api/block/updateBlock": {
                // T03 受控原位更新：解析 markdown（含 IAL），更新正文与属性；
                // dropIdentityOnUpdate=true 时丢弃 custom-wrs-src（模拟属性丢失）
                const block = this.blocks.get(String(rec.id));
                if (block === undefined) {
                    return { code: -1, msg: "块不存在" };
                }
                const { body, attrs } = FakeKernel.parseMarkdown(String(rec.data));
                if (fault === "drop") {
                    // 执行变更但响应丢失
                    block.markdown = body;
                    block.content = body.replace(/^(> |- 💭 |[-*+] |#{1,6} )/u, "");
                    if (!this.dropIdentityOnUpdate) {
                        Object.assign(block.ial, attrs);
                    } else {
                        block.ial = { id: block.id };
                    }
                    return failResp;
                }
                block.markdown = body;
                block.content = body.replace(/^(> |- 💭 |[-*+] |[-*+] |#{1,6} )/u, "");
                if (!this.dropIdentityOnUpdate) {
                    Object.assign(block.ial, attrs);
                } else {
                    block.ial = { id: block.id };
                }
                return { code: 0, msg: "", data: [{ doOperations: [{ action: "update", id: block.id }] }] };
            }
            case "/api/attr/setBlockAttrs": {
                const block = this.blocks.get(String(rec.id));
                if (block === undefined) {
                    return failResp;
                }
                Object.assign(block.ial, rec.attrs as Record<string, string>);
                return { code: 0, msg: "", data: null };
            }
            case "/api/block/getBlockKramdown": {
                this.readCount += 1;
                if (this.failReadAt.delete(this.readCount)) {
                    return { code: -1, msg: "注入：回读失败" };
                }
                const block = this.blocks.get(String(rec.id));
                if (block === undefined) {
                    return { code: -1, msg: "块不存在" };
                }
                const ial = Object.entries(block.ial)
                    .map(([k, v]) => `${k}="${v}"`)
                    .join(" ");
                return { code: 0, msg: "", data: { kramdown: `${block.markdown} {: ${ial}}` } };
            }
            case "/api/block/getBlockInfo": {
                const block = this.blocks.get(String(rec.id));
                if (block === undefined) {
                    return { code: -1, msg: "块不存在" };
                }
                return {
                    code: 0,
                    msg: "",
                    data: { parentID: block.parentId ?? "", rootID: block.rootId ?? block.id },
                };
            }
            case "/api/query/sql":
                return { code: 0, msg: "", data: this.sql(String(rec.sql)) };
            default:
                throw new Error(`FakeKernel 未实现 ${path}`);
        }
    };

    /** 迷你 SQL：忠实模拟 SQLite 关键语义（LIKE 通配符/ESCAPE、'' 解码），仅支持引擎使用的形状 */
    sql(query: string): Array<Record<string, unknown>> {
        const selectM = query.match(/^select ([\w, ]+) from blocks where (.+)$/u);
        if (selectM === null) {
            return [];
        }
        const cols = selectM[1].split(",").map((c) => c.trim());
        const where = selectM[2];
        const conds: Array<{ op: string; raw: string }> = [];
        const condRe = /(ial not like|ial like|type !=|type=|root_id=|id !=|id=|content=|box=)\s*'((?:[^']|'')*)'(?:\s*escape\s*'\\\\')?/gu;
        for (const m of where.matchAll(condRe)) {
            conds.push({ op: m[1], raw: m[2] });
        }
        const unescapeSql = (s: string): string => s.replaceAll("''", "'");
        const likeToRegex = (pattern: string): RegExp => {
            // SQLite LIKE + ESCAPE '\' 语义：% 任意串、_ 单字符、\x 字面量 x
            let src = "^";
            for (let i = 0; i < pattern.length; i += 1) {
                const ch = pattern[i]!;
                if (ch === "\\" && i + 1 < pattern.length) {
                    src += pattern[i + 1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                    i += 1;
                } else if (ch === "%") {
                    src += ".*";
                } else if (ch === "_") {
                    src += ".";
                } else {
                    src += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                }
            }
            return new RegExp(`${src}$`, "u");
        };
        const ialString = (b: FakeBlock): string =>
            `{: ${Object.entries(b.ial).map(([k, v]) => `${k}="${v}"`).join(" ")}}`;
        const rows: Array<Record<string, unknown>> = [];
        for (const b of this.blocks.values()) {
            let ok = true;
            for (const cond of conds) {
                const value = unescapeSql(cond.raw);
                if (cond.op === "ial like") {
                    if (!likeToRegex(value).test(ialString(b))) {
                        ok = false;
                        break;
                    }
                } else if (cond.op === "ial not like") {
                    if (likeToRegex(value).test(ialString(b))) {
                        ok = false;
                        break;
                    }
                } else if (cond.op === "type=") {
                    if (b.type !== value) {
                        ok = false;
                        break;
                    }
                } else if (cond.op === "type !=") {
                    if (b.type === value) {
                        ok = false;
                        break;
                    }
                } else if (cond.op === "id=") {
                    if (b.id !== value) {
                        ok = false;
                        break;
                    }
                } else if (cond.op === "id !=") {
                    if (b.id === value) {
                        ok = false;
                        break;
                    }
                } else if (cond.op === "root_id=") {
                    if (b.rootId !== value) {
                        ok = false;
                        break;
                    }
                } else if (cond.op === "content=") {
                    if (b.content !== value) {
                        ok = false;
                        break;
                    }
                } else if (cond.op === "box=") {
                    if (b.box !== value) {
                        ok = false;
                        break;
                    }
                } else {
                    ok = false;
                    break;
                }
            }
            if (ok) {
                const row: Record<string, unknown> = {};
                for (const c of cols) {
                    if (c === "id") {
                        row.id = b.id;
                    } else if (c === "ial") {
                        row.ial = ialString(b);
                    } else if (c === "content") {
                        row.content = b.content;
                    } else if (c === "box") {
                        row.box = b.box;
                    } else if (c === "root_id") {
                        row.root_id = b.rootId;
                    } else if (c === "markdown") {
                        row.markdown = `${b.markdown} {: ${Object.entries(b.ial).map(([k, v]) => `${k}="${v}"`).join(" ")}}`;
                    }
                }
                rows.push(row);
            }
        }
        return rows;
    }
}

// ---------- MemoryPersistence ----------

export class MemoryPersistence implements StatePersistence {
    store = new Map<string, unknown>();
    failNextSave = new Set<string>();

    async load(name: string): Promise<unknown> {
        if (this.failNextSave.has(`load:${name}`)) {
            this.failNextSave.delete(`load:${name}`);
            throw new Error("注入：读取失败");
        }
        return this.store.get(name) ?? null;
    }

    async save(name: string, content: unknown): Promise<void> {
        if (this.failNextSave.has(name)) {
            this.failNextSave.delete(name);
            throw new Error("注入：写入失败");
        }
        this.store.set(name, content);
    }
}

// ---------- 工具 ----------

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
    });
    return { transport, kernel, persistence, engine };
}

export function fixture(): Record<string, BookScript> {
    return {
        "10001": {
            title: "三体",
            highlights: [
                { bookmarkId: "h1", chapterUid: 1, markText: "给岁月以文明", range: "10-20", createTime: 1700000001 },
                { bookmarkId: "h2", chapterUid: 1, markText: "弱小和无知不是生存的障碍，傲慢才是", range: "30-40", createTime: 1700000002 },
                { bookmarkId: "h3", chapterUid: 2, markText: "宇宙就是一座黑暗森林", range: "5-15", createTime: 1700000003 },
            ],
            reviews: [
                { review: { reviewId: "r1", content: "这句话太震撼了", range: "10-20", chapterUid: 1, createTime: 1700000010 } },
                { review: { reviewId: "r2", content: "整体书评：神作", createTime: 1700000011 } },
            ],
        },
    };
}

const srcOf = (bookId: string, kind: string, id: string): string => `${NS}/${bookId}/${kind}/${id}`;

// ---------- 测试 ----------

describe("同步引擎：非破坏导入与稳定块映射", () => {
    it("AC1：首次同步建立文档与块；连续三轮同数据不重复、ID 稳定", async () => {
        const { kernel, engine } = makeDeps(fixture());
        const r1 = await engine.syncRound();
        expect(r1.ok).toBe(true);
        expect(r1.books[0]?.created).toBe(5); // 3 highlights + 2 reviews
        const idsAfter1 = new Map(kernel.itemBlocks().map((b) => [b.ial["custom-wrs-src"], b.id]));
        expect(idsAfter1.size).toBe(5);

        const r2 = await engine.syncRound();
        const r3 = await engine.syncRound();
        expect(r2.books[0]?.created).toBe(0);
        expect(r3.books[0]?.created).toBe(0);
        expect(kernel.itemBlocks().length).toBe(5);
        for (const b of kernel.itemBlocks()) {
            expect(b.id).toBe(idsAfter1.get(b.ial["custom-wrs-src"]));
        }
        // 文档唯一
        const docs = kernel.allBlocks().filter((b) => b.type === "d");
        expect(docs.length).toBe(1);
        expect(docs[0]?.content).toBe("三体");
        // 挂靠 review 是对应 highlight 的子块；独立 review 在文档直接子级
        const h1 = kernel.itemBlocks().find((b) => b.ial["custom-wrs-src"] === srcOf("10001", "highlight", "h1"));
        const r1Block = kernel.itemBlocks().find((b) => b.ial["custom-wrs-src"] === srcOf("10001", "review", "r1"));
        expect(r1Block?.parentId).toBe(h1?.id);
        const r2Block = kernel.itemBlocks().find((b) => b.ial["custom-wrs-src"] === srcOf("10001", "review", "r2"));
        expect(r2Block?.parentId).toBe(docs[0]?.id);
    });

    it("AC1：同名书按 bookId 区分为两份文档", async () => {
        const books = fixture();
        books["10002"] = { ...books["10001"]!, title: "三体", highlights: [books["10001"]!.highlights[0]!], reviews: [] };
        const { kernel, engine } = makeDeps(books);
        const r = await engine.syncRound();
        expect(r.ok).toBe(true);
        const docs = kernel.allBlocks().filter((b) => b.type === "d");
        expect(docs.length).toBe(2);
        expect(kernel.itemBlocks().length).toBe(6); // 10001: 3划线+2想法；10002: 1划线
    });

    it("AC2：用户自加块不受影响、不重复导入", async () => {
        const books = fixture();
        const { kernel, engine } = makeDeps(books);
        await engine.syncRound();
        const doc = kernel.allBlocks().find((b) => b.type === "d")!;
        const userBlock: FakeBlock = {
            id: "user-1",
            type: "p",
            content: "我的私人批注",
            markdown: "我的私人批注",
            ial: { id: "user-1" },
            parentId: doc.id,
            rootId: doc.id,
            box: doc.box,
            children: [],
        };
        kernel.blocks.set("user-1", userBlock);
        doc.children.push("user-1");

        const r2 = await engine.syncRound();
        expect(r2.books[0]?.created).toBe(0);
        expect(kernel.blocks.get("user-1")).toBeDefined();
        expect(kernel.itemBlocks().length).toBe(5);
    });

    it("AC2：来源块移出管理范围 → moved-out，不补建", async () => {
        const books = fixture();
        const { kernel, engine } = makeDeps(books);
        await engine.syncRound();
        const otherDoc: FakeBlock = {
            id: "doc-other",
            type: "d",
            content: "别的文档",
            markdown: "",
            ial: { id: "doc-other" },
            parentId: null,
            rootId: "doc-other",
            box: kernel.notebooks[0]?.id,
            children: [],
        };
        kernel.blocks.set("doc-other", otherDoc);
        const h1 = kernel.itemBlocks().find((b) => b.ial["custom-wrs-src"] === srcOf("10001", "highlight", "h1"))!;
        h1.parentId = "doc-other";
        h1.rootId = "doc-other";
        otherDoc.children.push(h1.id);

        const r2 = await engine.syncRound();
        expect(r2.protectedReport.some((p) => p.reason === "moved-out" && p.sourceKey === srcOf("10001", "highlight", "h1"))).toBe(true);
        expect(r2.books[0]?.created).toBe(0);
        // 原文档不补建同名块
        expect(kernel.itemBlocks().filter((b) => b.ial["custom-wrs-src"] === srcOf("10001", "highlight", "h1")).length).toBe(1);
    });

    it("AC3-切断1：意图已存、写入失败 → 重试不重复", async () => {
        const books = fixture();
        const { kernel, engine } = makeDeps(books);
        kernel.failNext.add("/api/block/appendBlock");
        const r1 = await engine.syncRound();
        expect(r1.ok).toBe(false);
        // 恢复轮
        const r2 = await engine.syncRound();
        expect(r2.ok).toBe(true);
        expect(r2.books[0]?.created).toBe(5);
        expect(kernel.itemBlocks().length).toBe(5);
    });

    it("AC3-切断2：写入成功但响应丢失 → 按 IAL 认领，不重复创建", async () => {
        const books = fixture();
        const { kernel, engine } = makeDeps(books);
        // appendBlock 调用序（首轮）：1=摘录标题、2=第1章标题、3=h1 条目块
        // 第 3 次丢弃响应：块已创建（出生带 IAL）但引擎收到错误
        kernel.dropAt.set("/api/block/appendBlock", new Set([3]));
        const r1 = await engine.syncRound();
        expect(r1.ok).toBe(false); // h1 create 报错中断本书
        // h1 块已实际存在（带 IAL）
        const orphan = kernel.itemBlocks().find((b) => b.ial["custom-wrs-src"] === srcOf("10001", "highlight", "h1"));
        expect(orphan).toBeDefined();
        const r2 = await engine.syncRound();
        expect(r2.ok).toBe(true);
        // 孤儿被收养，同 sourceKey 只有一块
        const same = kernel.itemBlocks().filter((b) => b.ial["custom-wrs-src"] === srcOf("10001", "highlight", "h1"));
        expect(same.length).toBe(1);
        expect(r2.books[0]?.adopted).toBe(1);
        expect(kernel.itemBlocks().length).toBe(5);
    });

    it("AC3-切断3：块创建+记账前持久化失败 → 下一轮收养不重复", async () => {
        const books = fixture();
        const { kernel, persistence, engine } = makeDeps(books);
        // 记账链路的 bookName 保存序：1=重建init、2/3=ensureDoc(prev+cur)、4/5=意图(prev+cur)、6/7=记账(prev+cur)
        // 拦截第 6 次（记账世代写入）→ 落块成功但账未记
        const bookName = "book-10001";
        let bookSaves = 0;
        const origSave = persistence.save.bind(persistence);
        persistence.save = async (name: string, content: unknown) => {
            if (name === bookName) {
                bookSaves += 1;
                if (bookSaves === 6) {
                    throw new Error("注入：记账保存失败");
                }
            }
            return origSave(name, content);
        };
        const r1 = await engine.syncRound();
        expect(r1.ok).toBe(false);
        const before = kernel.itemBlocks().length;
        expect(before).toBeGreaterThanOrEqual(1);

        const r2 = await engine.syncRound();
        expect(r2.ok).toBe(true);
        expect(kernel.itemBlocks().length).toBe(5); // 无重复
        expect(r2.books[0]?.adopted).toBeGreaterThanOrEqual(1);
    });

    it("AC3-切断4：回读失败 → 下一轮收养（内容已核对）", async () => {
        const books = fixture();
        const { kernel, engine } = makeDeps(books);
        kernel.failNext.add("/api/block/getBlockKramdown");
        const r1 = await engine.syncRound();
        expect(r1.ok).toBe(false);
        const r2 = await engine.syncRound();
        expect(r2.ok).toBe(true);
        expect(kernel.itemBlocks().length).toBe(5);
    });

    it("AC4：索引双丢失 → 从块属性重建，无重复文档/块；书状态完好则零动作", async () => {
        const books = fixture();
        const { kernel, persistence, engine } = makeDeps(books);
        await engine.syncRound();
        persistence.store.delete("index");
        persistence.store.delete("index.prev");

        const r2 = await engine.syncRound();
        expect(r2.ok).toBe(true);
        expect(kernel.allBlocks().filter((b) => b.type === "d").length).toBe(1);
        expect(kernel.itemBlocks().length).toBe(5);
        expect(r2.books[0]?.created).toBe(0);
        expect(r2.books[0]?.candidates).toBe(0);
    });

    it("AC4：书状态双丢失（索引在）→ 从块属性重建身份，来源只产生候选不覆盖不重复", async () => {
        const books = fixture();
        const { kernel, persistence, engine } = makeDeps(books);
        await engine.syncRound();
        persistence.store.delete("book-10001");
        persistence.store.delete("book-10001.prev");

        const r2 = await engine.syncRound();
        expect(r2.ok).toBe(true);
        expect(r2.books[0]?.created).toBe(0);
        expect(r2.books[0]?.candidates).toBe(5); // 重建指纹 unknown → 全部列为候选而非覆盖
        expect(kernel.itemBlocks().length).toBe(5);
    });

    it("AC4：书籍状态双世代损坏 → 保护模式停写", async () => {
        const books = fixture();
        const { kernel, persistence, engine } = makeDeps(books);
        await engine.syncRound();
        persistence.store.set("book-10001", { broken: true });
        persistence.store.set("book-10001.prev", "垃圾数据");

        const r2 = await engine.syncRound();
        expect(r2.books[0]?.skipped).toBe(true);
        expect(r2.books[0]?.error).toContain("保护模式");
        expect(kernel.itemBlocks().length).toBe(5); // 无任何写入
    });

    it("AC4：复制属性（同 sourceKey 两块）→ 隔离待审，不任选", async () => {
        const books = fixture();
        const { kernel, engine } = makeDeps(books);
        await engine.syncRound();
        const h1 = kernel.itemBlocks().find((b) => b.ial["custom-wrs-src"] === srcOf("10001", "highlight", "h1"))!;
        const doc = kernel.blocks.get(h1.rootId!)!;
        const clone: FakeBlock = {
            ...h1,
            id: "clone-1",
            ial: { ...h1.ial, id: "clone-1" },
            children: [],
        };
        kernel.blocks.set("clone-1", clone);
        doc.children.push("clone-1");

        const r2 = await engine.syncRound();
        expect(r2.protectedReport.some((p) => p.reason === "ambiguous-attrs" && p.sourceKey === srcOf("10001", "highlight", "h1"))).toBe(true);
        expect(r2.books[0]?.created).toBe(0);
        expect(kernel.itemBlocks().filter((b) => b.ial["custom-wrs-src"] === srcOf("10001", "highlight", "h1")).length).toBe(2); // 两块都保留（不删除）
    });

    it("AC5：本地删除 → 永不复活", async () => {
        const books = fixture();
        const { kernel, engine } = makeDeps(books);
        await engine.syncRound();
        const h1 = kernel.itemBlocks().find((b) => b.ial["custom-wrs-src"] === srcOf("10001", "highlight", "h1"))!;
        kernel.blocks.delete(h1.id);

        const r2 = await engine.syncRound();
        expect(r2.protectedReport.some((p) => p.reason === "user-deleted" && p.sourceKey === srcOf("10001", "highlight", "h1"))).toBe(true);
        expect(kernel.itemBlocks().filter((b) => b.ial["custom-wrs-src"] === srcOf("10001", "highlight", "h1")).length).toBe(0);
        expect(r2.books[0]?.created).toBe(0);
    });

    it("AC5：来源移除条目 → unseen 保护，绝不删除本地块", async () => {
        const books = fixture();
        const { kernel, engine } = makeDeps(books);
        await engine.syncRound();
        books["10001"]!.highlights = books["10001"]!.highlights.filter((h) => h.bookmarkId !== "h3");

        const r2 = await engine.syncRound();
        expect(r2.protectedReport.some((p) => p.reason === "unseen" && p.sourceKey === srcOf("10001", "highlight", "h3"))).toBe(true);
        expect(kernel.itemBlocks().filter((b) => b.ial["custom-wrs-src"] === srcOf("10001", "highlight", "h3")).length).toBe(1);
    });

    it("AC5：远端 ID 变化（新 bookmarkId）→ 新条目导入，旧条目 unseen 保护", async () => {
        const books = fixture();
        const { kernel, engine } = makeDeps(books);
        await engine.syncRound();
        books["10001"]!.highlights = books["10001"]!.highlights.map((h) =>
            h.bookmarkId === "h3" ? { ...h, bookmarkId: "h3-new" } : h,
        );

        const r2 = await engine.syncRound();
        expect(r2.books[0]?.created).toBe(1);
        expect(kernel.itemBlocks().filter((b) => b.ial["custom-wrs-src"] === srcOf("10001", "highlight", "h3-new")).length).toBe(1);
        expect(kernel.itemBlocks().filter((b) => b.ial["custom-wrs-src"] === srcOf("10001", "highlight", "h3")).length).toBe(1);
    });

    it("AC6：来源正文变化 → 仅候选，原块不被改动", async () => {
        const books = fixture();
        const { kernel, engine } = makeDeps(books);
        await engine.syncRound();
        const h1 = kernel.itemBlocks().find((b) => b.ial["custom-wrs-src"] === srcOf("10001", "highlight", "h1"))!;
        const kramdownBefore = h1.markdown;
        books["10001"]!.highlights = books["10001"]!.highlights.map((h) =>
            h.bookmarkId === "h1" ? { ...h, markText: "给岁月以文明，而不是给文明以岁月" } : h,
        );

        const r2 = await engine.syncRound();
        expect(r2.books[0]?.candidates).toBe(1);
        expect(r2.candidatesReport[0]?.sourceKey).toBe(srcOf("10001", "highlight", "h1"));
        expect(kernel.blocks.get(h1.id)?.markdown).toBe(kramdownBefore); // 未被覆盖
        expect(r2.books[0]?.created).toBe(0);
    });

    it("AC6：外部引用锚点（块 ID）跨轮稳定", async () => {
        const books = fixture();
        const { kernel, engine } = makeDeps(books);
        await engine.syncRound();
        const ids = kernel.itemBlocks().map((b) => b.id);
        books["10001"]!.highlights[0]!.markText = "改一下";
        await engine.syncRound();
        const ids2 = kernel.itemBlocks().map((b) => b.id).sort();
        expect(ids.sort()).toEqual(ids2); // 即使有候选，块 ID 不变
    });

    it("AC7：分页/回包异常（updated 非数组）→ 整书跳过、不标记删除", async () => {
        const books = fixture();
        const { kernel, engine } = makeDeps(books);
        await engine.syncRound();
        books["10001"]!.bookmarkListBroken = true;

        const r2 = await engine.syncRound();
        expect(r2.books[0]?.skipped).toBe(true);
        expect(kernel.itemBlocks().length).toBe(5); // 全保留
    });

    it("AC7：书目分页游标异常 → 整轮中止", async () => {
        const books = fixture();
        const { engine } = makeDeps(books);
        const transport = new FakeTransport(books);
        // 构造 hasMore=1 但 books 恒同页（游标异常 → listAllNotebooks 抛 PaginationAnomalyError）
        const origPost = transport.post.bind(transport);
        transport.post = async (url, body) => {
            const req = body as Record<string, unknown>;
            if (req.api_name === "/user/notebooks") {
                const resp = await origPost(url, body);
                const parsed = JSON.parse(resp.body) as { hasMore: number };
                parsed.hasMore = 1;
                return { ...resp, body: JSON.stringify(parsed) };
            }
            return origPost(url, body);
        };
        // 重新构建 engine 用坏 transport
        const kernel2 = new FakeKernel();
        const persistence2 = new MemoryPersistence();
        let seq = 0;
        const engine2 = new SyncEngine({
            persistence: persistence2,
            kernel: kernel2.call,
            transport,
            apiKey: KEY,
            accountNamespace: NS,
            now: () => "2026-11-03T00:00:00Z",
            newOpId: () => `op-${String((seq += 1)).padStart(4, "0")}`,
        });
        void engine;
        const r = await engine2.syncRound();
        expect(r.ok).toBe(false);
        expect(r.abortedReason).toContain("中止");
        expect(kernel2.allBlocks().length).toBe(0); // 零写入
    });

    it("鉴权失败 → 整轮中止且零写入", async () => {
        const books = fixture();
        const { kernel, engine } = makeDeps(books);
        // 构造 401
        const transport = new FakeTransport(books);
        transport.post = async () => ({ status: 401, body: "", contentType: "text/plain" });
        const persistence = new MemoryPersistence();
        const engine2 = new SyncEngine({
            persistence,
            kernel: kernel.call,
            transport,
            apiKey: KEY,
            accountNamespace: NS,
            now: () => "2026-11-03T00:00:00Z",
            newOpId: () => "op-x",
        });
        void engine;
        const r = await engine2.syncRound();
        expect(r.ok).toBe(false);
        expect(r.abortedReason).toContain("鉴权失败");
        expect(kernel.allBlocks().length).toBe(0);
    });

    it("整改m2：单条归一化错误（缺 bookmarkId）→ 只跳过该条，整书继续导入", async () => {
        const books = fixture();
        books["10001"]!.highlights.push({
            bookmarkId: "",
            chapterUid: 1,
            markText: "没有 ID 的坏条目",
            range: "1-2",
            createTime: 1700000009,
        });
        const { engine } = makeDeps(books);
        const r = await engine.syncRound();
        expect(r.ok).toBe(true);
        expect(r.books[0]?.skipped).toBe(false);
        expect(r.books[0]?.created).toBe(5);
        expect(r.books[0]?.itemErrors).toBe(1);
    });

    it("整改M5：6 本书、每轮 5 本 → 轮转覆盖，无永久饥饿", async () => {
        const books: Record<string, BookScript> = {};
        for (let i = 1; i <= 6; i += 1) {
            books[`20${String(i).padStart(3, "0")}`] = {
                title: `书${i}`,
                highlights: [
                    { bookmarkId: `h-${i}`, chapterUid: 1, markText: `内容${i}`, range: "1-9", createTime: 1700000000 + i },
                ],
                reviews: [],
            };
        }
        const { kernel, engine } = makeDeps(books);
        const r1 = await engine.syncRound();
        expect(r1.books).toHaveLength(5);
        expect(r1.deferredBooks).toBe(1);
        expect(r1.ok).toBe(true);
        expect(kernel.itemBlocks().length).toBe(5);

        const r2 = await engine.syncRound();
        expect(r2.ok).toBe(true);
        // 轮转后第一本是上轮被推迟的第 6 本
        expect(r2.books[0]?.bookId).toBe("20006");
        expect(r2.books[0]?.created).toBe(1);
        expect(kernel.itemBlocks().length).toBe(6);
    });

    it("整改M4：同名且有内容的用户文档 → 不认领不新建，报人工处理", async () => {
        const books = fixture();
        const { kernel, engine } = makeDeps(books);
        await engine.syncRound();
        // 删除既有书籍文档（含子块），模拟文档丢失
        const doc = kernel.allBlocks().find((b) => b.type === "d")!;
        for (const b of kernel.allBlocks()) {
            if (b.rootId === doc.id && b.id !== doc.id) {
                kernel.blocks.delete(b.id);
            }
        }
        kernel.blocks.delete(doc.id);
        // 用户在插件笔记本里自建同名文档（有内容）
        await kernel.call("/api/filetree/createDocWithMd", { notebook: kernel.notebooks[0]!.id, path: "/三体", markdown: "" });
        const userDoc = kernel.allBlocks().find((b) => b.type === "d")!;
        await kernel.call("/api/block/appendBlock", { dataType: "markdown", data: "用户自己的内容", parentID: userDoc.id });

        const r2 = await engine.syncRound();
        expect(r2.books[0]?.error).toContain("人工");
        // 用户文档未被认领（无 custom 属性）、未被写入条目块
        expect(userDoc.ial["custom-wrs-book-id"]).toBeUndefined();
        expect(kernel.itemBlocks().length).toBe(0);
        // 也没有新建第二份文档
        expect(kernel.allBlocks().filter((b) => b.type === "d").length).toBe(1);
    });

    it("整改m3：账号标识与既有状态不一致 → AccountMismatchError（绝不自动混入）", async () => {
        const books = fixture();
        const { kernel, persistence, engine } = makeDeps(books);
        await engine.syncRound();
        const engine2 = new SyncEngine({
            persistence,
            kernel: kernel.call,
            transport: new FakeTransport(books),
            apiKey: KEY,
            accountNamespace: "另一个账号",
            now: () => "2026-11-03T00:00:00Z",
            newOpId: () => "op-y",
        });
        await expect(engine2.syncRound()).rejects.toThrow(/账号标识与既有状态不一致/);
        // 零新增写入
        expect(kernel.itemBlocks().length).toBe(5);
    });

    it("整改M3：bookId 含 LIKE 通配符 _ → 精确匹配，不命中单字符差异的他书块", async () => {
        const books: Record<string, BookScript> = {
            "100077-_book": {
                title: "通配符书",
                highlights: [{ bookmarkId: "w1", chapterUid: 1, markText: "下划线书", range: "1-5", createTime: 1700000001 }],
                reviews: [],
            },
            "100077-Xbook": {
                title: "单字符差异书",
                highlights: [{ bookmarkId: "w1", chapterUid: 1, markText: "另一本书", range: "1-5", createTime: 1700000001 }],
                reviews: [],
            },
        };
        const { kernel, persistence, engine } = makeDeps(books);
        const r = await engine.syncRound();
        expect(r.ok).toBe(true);
        const srcA = "测试账号/100077-_book/highlight/w1";
        const srcB = "测试账号/100077-Xbook/highlight/w1";
        const a = kernel.itemBlocks().filter((b) => b.ial["custom-wrs-src"] === srcA);
        const b = kernel.itemBlocks().filter((b) => b.ial["custom-wrs-src"] === srcB);
        expect(a.length).toBe(1);
        expect(b.length).toBe(1);
        // 真锁性质（复核随行）：删除 A 书状态后重建，A 的 items 不得包含 B 的 sourceKey
        persistence.store.delete("book-100077-_book");
        persistence.store.delete("book-100077-_book.prev");
        const r2 = await engine.syncRound();
        expect(r2.ok).toBe(true);
        const rebuilt = persistence.store.get("book-100077-_book") as {
            items: Record<string, unknown>;
        };
        const keys = Object.keys(rebuilt.items);
        expect(keys.length).toBe(1);
        expect(keys[0]).toBe(srcA);
        // 且不重复导入（_ 不作为单字符通配匹配到 B 书）
        expect(kernel.itemBlocks().length).toBe(2);
    });

    it("复核随行M4：文档创建窗口的空孤儿（无属性、无子块）→ 按标题认领并补属性", async () => {
        const books = fixture();
        const { kernel, persistence, engine } = makeDeps(books);
        await engine.syncRound();
        // 模拟真实创建窗口：createDocWithMd 成功、setBlockAttrs 前中断——
        // 文档无属性无子块；书状态与 index 条目均未记 docId（index 本身仍在，笔记本不丢）
        const doc = kernel.allBlocks().find((b) => b.type === "d")!;
        for (const b of kernel.allBlocks()) {
            if (b.rootId === doc.id && b.id !== doc.id) {
                kernel.blocks.delete(b.id);
            }
        }
        delete doc.ial["custom-wrs-book-id"];
        delete doc.ial["custom-wrs-account"];
        persistence.store.delete("book-10001");
        persistence.store.delete("book-10001.prev");
        const idx = persistence.store.get("index") as {
            books: Record<string, { docId?: string }>;
        };
        delete idx.books["10001"]!.docId;

        const r2 = await engine.syncRound();
        expect(r2.ok).toBe(true);
        // 空孤儿被认领（属性补齐）且没有第二份文档
        expect(doc.ial["custom-wrs-book-id"]).toBe("10001");
        expect(kernel.allBlocks().filter((b) => b.type === "d").length).toBe(1);
        // 条目重新导入（状态已重建为空）
        expect(kernel.itemBlocks().length).toBe(5);
    });
});
