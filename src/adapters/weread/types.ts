// 微信读书网关数据类型（按 docs/contracts/weread-gateway.md 字段冻结）。

export interface WereadBookMeta {
    bookId: string;
    title?: string;
    author?: string;
    cover?: string;
    intro?: string;
    isbn?: string;
}

export interface NotebookSummaryEntry {
    bookId: string;
    title?: string;
    author?: string;
    // 注意：noteCount 是划线数；总笔记数 = reviewCount + noteCount + bookmarkCount
    reviewCount?: number;
    noteCount?: number;
    bookmarkCount?: number;
    readingProgress?: number;
    markedStatus?: number;
    sort?: number;
}

export interface NotebooksPage {
    books: NotebookSummaryEntry[];
    hasMore: boolean;
    totalBookCount?: number;
    anomalies: string[];
}
