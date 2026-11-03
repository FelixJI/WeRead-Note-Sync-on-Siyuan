import type { Transport } from "../../core/net/transport";
import { executeGatewayCall, isRecord } from "./gateway";
import { paginateAll } from "./pagers";
import type { NotebookSummaryEntry, NotebooksPage } from "./types";

// /user/notebooks 客户端：单页读取（缺字段异常收集）+ 全量翻页（分页安全守卫）。

// Key 格式在工厂阶段不拦截、在使用时惰性校验：
// 连接测试需要拿到 client 后仍能报出 invalid-key（UI 先校验，这里双保险）。
export class InvalidWereadApiKeyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InvalidWereadApiKeyError";
    }
}

export function isValidWereadApiKey(key: string): boolean {
    // 冻结规则：wrk- 前缀、总长 >= 12、不含空白字符
    return key.startsWith("wrk-") && key.length >= 12 && !/\s/.test(key);
}

const NOTEBOOKS_PAGE_COUNT = 20;

function parseNotebooksPage(obj: Record<string, unknown>): NotebooksPage {
    const anomalies: string[] = [];
    const books: NotebookSummaryEntry[] = [];

    const rawBooks = obj.books;
    if (rawBooks !== undefined && !Array.isArray(rawBooks)) {
        anomalies.push("books 字段不是数组，按空页处理");
    }
    if (Array.isArray(rawBooks)) {
        rawBooks.forEach((raw, index) => {
            if (!isRecord(raw)) {
                anomalies.push(`books[${index}] 不是对象，跳过`);
                return;
            }
            const bookId = raw.bookId;
            if (typeof bookId !== "string" || bookId.length === 0) {
                // 契约：必填 bookId 缺失时跳过并记异常，不猜主键
                anomalies.push(`books[${index}] bookId缺失，跳过该条`);
                return;
            }
            const entry: NotebookSummaryEntry = { bookId };
            if (typeof raw.title === "string") entry.title = raw.title;
            if (typeof raw.author === "string") entry.author = raw.author;
            for (const field of ["reviewCount", "noteCount", "bookmarkCount", "readingProgress", "markedStatus", "sort"] as const) {
                const value = raw[field];
                if (typeof value === "number" && Number.isFinite(value)) {
                    entry[field] = value;
                }
            }
            books.push(entry);
        });
    }

    const hasMoreRaw = obj.hasMore;
    const hasMore = hasMoreRaw === 1 || hasMoreRaw === true;
    const totalBookCountRaw = obj.totalBookCount;

    if (typeof totalBookCountRaw === "number" && Number.isFinite(totalBookCountRaw)) {
        return { books, hasMore, totalBookCount: totalBookCountRaw, anomalies };
    }
    return { books, hasMore, anomalies };
}

export interface WereadClient {
    /** 单页读取；缺必填字段的条目被跳过并收集到 anomalies */
    listNotebooksPage(params?: { count?: number; lastSort?: number }): Promise<NotebooksPage>;
    /** 完整翻页（含分页安全守卫），默认 maxPages=200；任何分页异常都会抛错而非返回不完整结果 */
    listAllNotebooks(
        maxPages?: number,
    ): Promise<{ books: NotebookSummaryEntry[]; anomalies: string[] }>;
}

export function createWereadClient(transport: Transport, apiKey: string): WereadClient {
    const assertKey = (): void => {
        if (!isValidWereadApiKey(apiKey)) {
            throw new InvalidWereadApiKeyError(
                "API Key 格式不正确：应以 wrk- 开头、总长度不小于 12 个字符且不含空白。",
            );
        }
    };

    const client: WereadClient = {
        async listNotebooksPage(params) {
            assertKey();
            const obj = await executeGatewayCall(
                transport,
                apiKey,
                "/user/notebooks",
                params ?? {},
            );
            return parseNotebooksPage(obj);
        },
        async listAllNotebooks(maxPages = 200) {
            assertKey();
            const result = await paginateAll<NotebookSummaryEntry>({
                maxPages,
                cursorLabel: "lastSort",
                keyLabel: "bookId",
                keyOf: (entry) => entry.bookId,
                fetchPage: async (cursor) => {
                    const params: { count: number; lastSort?: number } = {
                        count: NOTEBOOKS_PAGE_COUNT,
                    };
                    if (typeof cursor === "number") {
                        params.lastSort = cursor;
                    }
                    const page = await client.listNotebooksPage(params);
                    // 契约：hasMore=1 时取本页最后一条 sort 作下一页 lastSort；
                    // 最后一条缺 sort 视为游标缺失（引擎将判游标循环/异常，不会静默丢页）
                    const last = page.books.length > 0 ? page.books[page.books.length - 1] : undefined;
                    const nextCursor = last !== undefined ? last.sort : undefined;
                    return {
                        items: page.books,
                        hasMore: page.hasMore,
                        nextCursor,
                        anomalies: page.anomalies,
                    };
                },
            });
            return { books: result.items, anomalies: result.anomalies };
        },
    };
    return client;
}
