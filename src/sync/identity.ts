// 身份模型（设计契约 §1，冻结）：sourceKey = accountNamespace / bookId / kind / officialSourceId。
// accountNamespace 是用户显式配置的账号标识（由 engine 侧保证非空），不以 Key 哈希定义；
// officialSourceId：highlight=bookmarkId，review=reviewId。
// sourceKey 会进入思源 IAL 属性与 SQL LIKE 匹配，任一段不得携带注入面字符。

export type SourceKind = "highlight" | "review";

export interface SourceRef {
    accountNamespace: string;
    bookId: string;
    kind: SourceKind;
    officialSourceId: string;
}

const KINDS: ReadonlySet<string> = new Set(["highlight", "review"]);

// 安全字符集（主代理冻结补充）：双引号/单引号/反斜杠/反引号/尖括号与 C0 控制字符（含 DEL）
const FORBIDDEN_CHARS: ReadonlySet<string> = new Set(['"', "'", "\\", "`", "<", ">", "\u007F"]);

function isForbidden(ch: string): boolean {
    const code = ch.charCodeAt(0);
    if (code <= 0x1f) return true; // C0 控制字符
    return FORBIDDEN_CHARS.has(ch);
}

/** 校验单个段：非空、不含 "/"、不含安全字符集外字符。违例即 throw（消息列出非法字符）。 */
function assertSegment(name: string, value: string): void {
    if (value.length === 0) {
        throw new Error(`sourceKey 段 ${name} 为空`);
    }
    if (value.includes("/")) {
        throw new Error(`sourceKey 段 ${name} 含 "/"：${name}=${value}`);
    }
    const illegal: string[] = [];
    for (const ch of value) {
        if (isForbidden(ch) && !illegal.includes(ch)) illegal.push(ch);
    }
    if (illegal.length > 0) {
        throw new Error(`sourceKey 段 ${name} 含非法字符（${illegal.join(" ")}）：${name}=${value}`);
    }
}

/** UI 输入校验用（不抛错）：返回 null=合法，否则返回中文错误提示。 */
export function validateSourceSegment(value: string): string | null {
    if (value.length === 0) {
        return "不能为空";
    }
    if (value.includes("/")) {
        return "不能包含 /";
    }
    const illegal: string[] = [];
    for (const ch of value) {
        if (isForbidden(ch) && !illegal.includes(ch)) illegal.push(ch);
    }
    if (illegal.length > 0) {
        return `不能包含以下字符：${illegal.join(" ")}`;
    }
    return null;
}

export function makeSourceKey(ref: SourceRef): string {
    assertSegment("accountNamespace", ref.accountNamespace);
    assertSegment("bookId", ref.bookId);
    assertSegment("kind", ref.kind);
    assertSegment("officialSourceId", ref.officialSourceId);
    return `${ref.accountNamespace}/${ref.bookId}/${ref.kind}/${ref.officialSourceId}`;
}

export function parseSourceKey(key: string): SourceRef {
    const parts = key.split("/");
    if (parts.length !== 4) {
        throw new Error(
            `sourceKey 结构非法（应为 ns/bookId/kind/id 共 4 段，实际 ${parts.length} 段）：${key}`,
        );
    }
    const [accountNamespace, bookId, kind, officialSourceId] = parts;
    if (!KINDS.has(kind)) {
        throw new Error(`sourceKey 段 kind 非法（应为 highlight|review）：${kind}`);
    }
    // 与 makeSourceKey 对称校验：防止脏状态把非法 key 送进 SQL/IAL
    assertSegment("accountNamespace", accountNamespace);
    assertSegment("bookId", bookId);
    assertSegment("kind", kind);
    assertSegment("officialSourceId", officialSourceId);
    return { accountNamespace, bookId, kind: kind as SourceKind, officialSourceId };
}
