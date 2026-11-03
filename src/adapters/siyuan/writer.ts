/**
 * 思源内核写入执行器（docs/design/t02-sync-core.md §4）。
 *
 * - 唯一允许出现块级写入调用的模块（T02 只允许"新建"：createNotebook/createDocWithMd/
 *   insertBlock/appendBlock/setBlockAttrs；updateBlock/deleteBlock 不得出现在自动路径）。
 * - 通过注入的 KernelCallFn 调内核（生产为 fetchSyncPost，测试为 FakeKernel）。
 * - 一切错误文本出口过 redact；块 ID 校验后才返回。
 */
import { toSafeErrorMessage } from "../../core/security/redact";

export type KernelCallFn = (path: string, data: unknown) => Promise<unknown>;

export class KernelApiError extends Error {
    constructor(message: string, public readonly path: string, public readonly code?: number) {
        super(message);
        this.name = "KernelApiError";
    }
}

/**
 * PR9[3]：createDocWithMd 同路径撞上既有（他书）文档——真实内核不新建而是交回既有
 * 文档 ID，放行会让调用方（#ensureDoc）随后 setBlockAttrs 静默改绑他书文档身份。
 * 抛出本错误交书级重试/人工裁决；彻底防碰撞路径（路径并入 bookId）需引擎侧传参适配。
 */
export class DocPathCollisionError extends Error {
    constructor(
        public readonly docPath: string,
        public readonly existingDocId: string,
        public readonly reason: string,
    ) {
        super(
            `文档路径 ${docPath} 已存在既有文档（${existingDocId}：${reason}），` +
                "疑似不同书同名导致路径冲突；为防止改绑他书文档已拒绝创建，请人工处理",
        );
        this.name = "DocPathCollisionError";
    }
}

interface KernelResponse {
    code: number;
    msg: string;
    data?: unknown;
}

function isKernelResponse(v: unknown): v is KernelResponse {
    if (typeof v !== "object" || v === null) {
        return false;
    }
    const rec = v as Record<string, unknown>;
    return typeof rec.code === "number" && typeof rec.msg === "string";
}

/**
 * "块不存在"消息特征（PR9[5]）：仓库冻结契约（docs/contracts/siyuan-kernel.md）只规定
 * code!==0 即失败，未定义缺块专用码；真实内核 getBlockKramdown 缺块走 code 0 + 空串
 * （见 getBlockKramdown 注释），code!=0 + 此类消息覆盖测试 FakeKernel 契约
 * （tests/sync/engine.test.ts 返回 {code:-1, msg:"块不存在"}）及内核其他块端点的
 * 缺块形态。特征外的 code!=0 一律视为瞬时错误抛出。
 */
const BLOCK_NOT_FOUND_MSG = /块不存在|not found/iu;

/** SQL 字面量引号转义（SQLite '' 语义；仅用于 = 等值比较，不做 LIKE 通配转义）。 */
function quoteSqlLiteral(text: string): string {
    return text.replaceAll("'", "''");
}

export interface BlockOperation {
    action: string;
    id?: string;
    parentID?: string;
    previousID?: string;
}

export interface SiyuanBlock {
    id: string;
    parent_id?: string;
    root_id?: string;
    box?: string;
    hpath?: string;
    content?: string;
    ial?: string;
    markdown?: string;
}

function assertBlockId(raw: unknown, context: string): string {
    if (typeof raw !== "string" || raw.length < 1) {
        throw new KernelApiError(`${context}：内核未返回有效块 ID`, context);
    }
    return raw;
}

/** 内核 API 调用外壳：code!==0 抛错（脱敏）。 */
export async function callKernel(fn: KernelCallFn, path: string, data: unknown): Promise<unknown> {
    let resp: unknown;
    try {
        resp = await fn(path, data);
    } catch (e) {
        throw new KernelApiError(`内核请求失败 ${path}：${toSafeErrorMessage(e)}`, path);
    }
    if (!isKernelResponse(resp)) {
        throw new KernelApiError(`内核响应格式异常 ${path}`, path);
    }
    if (resp.code !== 0) {
        throw new KernelApiError(`内核错误 ${path} code=${resp.code}：${toSafeErrorMessage(resp.msg)}`, path, resp.code);
    }
    return resp.data;
}

export class SiyuanWriter {
    readonly #fn: KernelCallFn;

    constructor(fn: KernelCallFn) {
        this.#fn = fn;
    }

    /** 创建"微信读书"笔记本，返回笔记本 ID。真实内核返回 data.notebook.id（docs/API.md）。 */
    async createNotebook(name: string): Promise<string> {
        const data = await callKernel(this.#fn, "/api/notebook/createNotebook", { name });
        const rec = data as Record<string, unknown> | null;
        const notebook =
            rec !== null && typeof rec.notebook === "object" && rec.notebook !== null
                ? (rec.notebook as Record<string, unknown>)
                : null;
        const id = notebook !== null && typeof notebook.id === "string" ? notebook.id : undefined;
        return assertBlockId(id, "createNotebook");
    }

    /** 列出笔记本（id + name + closed 状态）。 */
    async listNotebooks(): Promise<Array<{ id: string; name: string; closed: boolean }>> {
        const data = await callKernel(this.#fn, "/api/notebook/lsNotebooks", {});
        const rec = data as Record<string, unknown> | null;
        const notebooks = rec !== null && Array.isArray(rec.notebooks) ? rec.notebooks : [];
        const result: Array<{ id: string; name: string; closed: boolean }> = [];
        for (const nb of notebooks) {
            if (typeof nb !== "object" || nb === null) {
                continue;
            }
            const r = nb as Record<string, unknown>;
            if (typeof r.id === "string" && typeof r.name === "string") {
                result.push({ id: r.id, name: r.name, closed: r.closed === true });
            }
        }
        return result;
    }

    /**
     * 创建书籍文档（空正文），返回文档根块 ID。
     *
     * PR9[3] 同路径冲突守卫：真实内核对同 path 的 createDocWithMd **不新建文档**，
     * 而是直接返回既有文档 ID（v3.0.0 kernel/model/path.go createDocsByHPath：
     * GetBlockTreeRootByPath 命中即 retID=root.ID；仓库契约 docs/contracts/siyuan-kernel.md
     * 亦冻结为"同 path 重复调用不覆盖已有文档"）。因此创建后必须核对返回 ID 确为
     * 全新文档，否则抛 DocPathCollisionError——绝不把既有文档 ID 交回调用方。
     * 例外：同 path 的"空且无主"文档（创建窗口中断遗留）允许接管，与引擎 M4
     * 空孤儿认领语义一致。
     */
    async createBookDoc(notebookId: string, title: string): Promise<string> {
        const docPath = `/${title}`;
        const data = await callKernel(this.#fn, "/api/filetree/createDocWithMd", {
            notebook: notebookId,
            path: docPath,
            markdown: "",
        });
        // data 直接是文档 ID 字符串
        const docId = assertBlockId(data, "createDocWithMd");
        await this.#assertCreatedDocIsFresh(docId, docPath);
        return docId;
    }

    /**
     * 核对 createDocWithMd 返回的 ID 确为全新文档（PR9[3]）：
     * - 已有子块 → 撞上既有书籍文档（骨架/条目已在）；
     * - 已带 custom-wrs-book-id 身份属性 → 撞上他书（或本书旧档）的已绑定文档。
     * 两种情况都抛 DocPathCollisionError；SQL 瞬时失败也会自然抛错由书级重试兜底。
     */
    async #assertCreatedDocIsFresh(docId: string, docPath: string): Promise<void> {
        const children = await this.sql(
            `select id from blocks where root_id='${quoteSqlLiteral(docId)}' and id != '${quoteSqlLiteral(docId)}'`,
        );
        if (children.length > 0) {
            throw new DocPathCollisionError(docPath, docId, "文档已含子内容");
        }
        const bound = await this.sql(
            `select id from blocks where id='${quoteSqlLiteral(docId)}' and ial like '%custom-wrs-book-id="%' escape '\\'`,
        );
        if (bound.length > 0) {
            throw new DocPathCollisionError(docPath, docId, "文档已带 custom-wrs-book-id 身份");
        }
    }

    /** 在 previousID 后插入块，返回新块 ID。 */
    async insertBlockAfter(markdown: string, previousBlockId: string): Promise<string> {
        const data = await callKernel(this.#fn, "/api/block/insertBlock", {
            dataType: "markdown",
            data: markdown,
            previousID: previousBlockId,
        });
        const transactions = data as Array<{ doOperations?: BlockOperation[] }> | null;
        const first = transactions !== null && Array.isArray(transactions) ? transactions[0] : undefined;
        const op = first !== undefined && Array.isArray(first.doOperations) ? first.doOperations[0] : undefined;
        return assertBlockId(op !== undefined ? op.id : undefined, "insertBlock");
    }

    /** 作为 parentID 的子块追加，返回新块 ID。 */
    async appendChildBlock(markdown: string, parentBlockId: string): Promise<string> {
        const data = await callKernel(this.#fn, "/api/block/appendBlock", {
            dataType: "markdown",
            data: markdown,
            parentID: parentBlockId,
        });
        const transactions = data as Array<{ doOperations?: BlockOperation[] }> | null;
        const first = transactions !== null && Array.isArray(transactions) ? transactions[0] : undefined;
        const op = first !== undefined && Array.isArray(first.doOperations) ? first.doOperations[0] : undefined;
        return assertBlockId(op !== undefined ? op.id : undefined, "appendBlock");
    }

    /**
     * T03 受控原位更新（唯一用户批准写入口，设计契约 §3）：
     * markdown 必须自带 IAL（id + custom-wrs-src）以保身份；调用方负责前后校验，本方法不做重试。
     */
    async updateBlockContent(markdown: string, blockId: string): Promise<void> {
        await callKernel(this.#fn, "/api/block/updateBlock", {
            dataType: "markdown",
            data: markdown,
            id: blockId,
        });
    }

    /** 设置块自定义属性（custom- 命名空间）。 */
    async setBlockAttrs(blockId: string, attrs: Record<string, string>): Promise<void> {
        await callKernel(this.#fn, "/api/attr/setBlockAttrs", { id: blockId, attrs });
    }

    /**
     * 回读块 kramdown（存在性证据以此为准）。三态契约（PR9[5]）：
     *
     * 1. 存在：code 0 且 data.kramdown 为非空字符串 → 返回该字符串。
     * 2. 确认不存在 → 返回 undefined，仅限两种可确认形态：
     *    (a) code 0 且 kramdown 为空串——真实内核（v2.12.8/v3.0.0/master 的
     *        kernel/api/block.go getBlockKramdown → model.GetBlockKramdown）对缺失块
     *        正是返回 code 0 + 空串，并非 code!=0。已知局限：该形态在真实内核同时
     *        覆盖"块缺失"与"树加载失败"，本端点无更强信号可区分，按缺失处理
     *        （引擎侧如需绝对稳妥可在判 user-deleted 前用 getBlockInfo 复核）；
     *    (b) code!=0 且 msg 匹配块不存在/not found 特征——测试 FakeKernel 契约形态
     *        及内核其他块端点（如 getBlockInfo 缺块返回 code -1 + 查询失败消息）。
     * 3. 其他一切错误（code!=0 的其他消息=瞬时内核故障、传输异常、响应形状异常）
     *    → 抛 KernelApiError，由调用方按书级重试处理。绝不把瞬时故障折算成
     *    "块不存在"——否则 #auditBlocks 会把条目永久误判 user-deleted。
     */
    async getBlockKramdown(blockId: string): Promise<string | undefined> {
        const path = "/api/block/getBlockKramdown";
        let resp: unknown;
        try {
            resp = await this.#fn(path, { id: blockId });
        } catch (e) {
            throw new KernelApiError(`内核请求失败 ${path}：${toSafeErrorMessage(e)}`, path);
        }
        if (!isKernelResponse(resp)) {
            throw new KernelApiError(`内核响应格式异常 ${path}`, path);
        }
        if (resp.code !== 0) {
            if (BLOCK_NOT_FOUND_MSG.test(resp.msg)) {
                return undefined; // 确认不存在（形态 b）
            }
            throw new KernelApiError(
                `内核错误 ${path} code=${resp.code}：${toSafeErrorMessage(resp.msg)}`,
                path,
                resp.code,
            );
        }
        const rec = resp.data as Record<string, unknown> | null;
        if (rec === null || typeof rec.kramdown !== "string") {
            // code 0 但形状异常：无法确认块存在性 → 保守抛错（不折算成"不存在"）
            throw new KernelApiError(`${path} 响应缺少 kramdown 字符串，无法确认块状态`, path);
        }
        if (rec.kramdown === "") {
            return undefined; // 确认不存在（形态 a：真实内核缺块形态）
        }
        return rec.kramdown;
    }

    /** 取块直接信息（parent_id/root_id，用于 moved-out 判定）。 */
    async getBlockInfo(blockId: string): Promise<{ parentId?: string; rootId?: string } | undefined> {
        try {
            const data = await callKernel(this.#fn, "/api/block/getBlockInfo", { id: blockId });
            const rec = data as Record<string, unknown> | null;
            if (rec === null) {
                return undefined;
            }
            return {
                parentId: typeof rec.parentID === "string" ? rec.parentID : undefined,
                rootId: typeof rec.rootID === "string" ? rec.rootID : undefined,
            };
        } catch (e) {
            if (e instanceof KernelApiError) {
                return undefined;
            }
            throw e;
        }
    }

    /** SQL 查询（身份索引重建/歧义扫描专用；不做存在性唯一证据）。 */
    async sql(query: string): Promise<SiyuanBlock[]> {
        const data = await callKernel(this.#fn, "/api/query/sql", { sql: query });
        return Array.isArray(data) ? (data as SiyuanBlock[]) : [];
    }

    /** 按 custom-wrs-src 精确查块（SQL 结果仍需回读核对）。 */
    async findBlocksBySourceKey(sourceKey: string): Promise<SiyuanBlock[]> {
        // 思源 blocks.ial 是 kramdown IAL 字符串（形如 {: id="..." custom-wrs-src="..."}）。
        // likeEscape 处理 %/_/\ 通配符；单引号双写防 SQL 转义；双引号锚定防前缀碰撞。
        return this.sql(
            `select id, parent_id, root_id, box, ial from blocks where ial like '%custom-wrs-src="${likeEscape(sourceKey)}"%' escape '\\'`,
        );
    }
}

/**
 * SQL LIKE 上下文转义：%/_/\ 是通配符/转义符（SQLite ESCAPE '\' 语义），
 * 身份段（账号命名空间、bookId）可能含 _ ——不转义会跨书/跨账号误匹配。
 * 单引号双写由调用方先行处理或由此处一并处理（本函数假定输入尚未做 SQL 引号转义）。
 */
export function likeEscape(text: string): string {
    return text
        .replaceAll("\\", "\\\\")
        .replaceAll("%", "\\%")
        .replaceAll("_", "\\_")
        .replaceAll("'", "''");
}
