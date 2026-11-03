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

    /** 创建"微信读书"笔记本，返回笔记本 ID。 */
    async createNotebook(name: string): Promise<string> {
        const data = await callKernel(this.#fn, "/api/notebook/createNotebook", { name });
        const rec = data as Record<string, unknown> | null;
        const id = rec !== null && typeof rec.id === "string" ? rec.id : undefined;
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

    /** 创建书籍文档（空正文），返回文档根块 ID。 */
    async createBookDoc(notebookId: string, title: string): Promise<string> {
        const data = await callKernel(this.#fn, "/api/filetree/createDocWithMd", {
            notebook: notebookId,
            path: `/${title}`,
            markdown: "",
        });
        // data 直接是文档 ID 字符串
        return assertBlockId(data, "createDocWithMd");
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

    /** 设置块自定义属性（custom- 命名空间）。 */
    async setBlockAttrs(blockId: string, attrs: Record<string, string>): Promise<void> {
        await callKernel(this.#fn, "/api/attr/setBlockAttrs", { id: blockId, attrs });
    }

    /** 回读块 kramdown；块不存在返回 undefined（存在性证据以此为准）。 */
    async getBlockKramdown(blockId: string): Promise<string | undefined> {
        try {
            const data = await callKernel(this.#fn, "/api/block/getBlockKramdown", { id: blockId });
            const rec = data as Record<string, unknown> | null;
            return rec !== null && typeof rec.kramdown === "string" ? rec.kramdown : undefined;
        } catch (e) {
            if (e instanceof KernelApiError && typeof e.code === "number" && e.code !== 0) {
                return undefined;
            }
            throw e;
        }
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
        // sourceKey 已由 identity 层限制安全字符集；单引号双写防 SQL 转义，双引号锚定防前缀碰撞。
        const escaped = sourceKey.replaceAll("'", "''");
        return this.sql(
            `select id, parent_id, root_id, box, ial from blocks where ial like '%custom-wrs-src=\"${escaped}\"%'`,
        );
    }
}
