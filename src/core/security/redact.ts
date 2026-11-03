// 脱敏：任何要展示/记录的错误文本都必须先过这里（AGENTS.md 安全不变量 2）。
// 规则冻结：wrk-<非空白8+> → wrk-***REDACTED***；Bearer <token> → Bearer ***

const WRK_TOKEN_RE = /wrk-[^\s]{8,}/g;
const BEARER_TOKEN_RE = /Bearer\s+[^\s]+/g;

export function redact(text: string): string {
    // 先脱敏 wrk- 再处理 Bearer：组合出现时最终收敛为 "Bearer ***"
    return text.replace(WRK_TOKEN_RE, "wrk-***REDACTED***").replace(BEARER_TOKEN_RE, "Bearer ***");
}

const MAX_MESSAGE_LENGTH = 500;

function errorToText(e: unknown): string {
    if (e instanceof Error) {
        return e.message.length > 0 ? e.message : e.name;
    }
    if (typeof e === "string") {
        return e;
    }
    try {
        const serialized = JSON.stringify(e);
        return serialized ?? String(e);
    } catch {
        // 循环引用等无法序列化的对象退化为默认字符串，绝不抛出
        return String(e);
    }
}

export function toSafeErrorMessage(e: unknown): string {
    const safe = redact(errorToText(e));
    return safe.length > MAX_MESSAGE_LENGTH ? safe.slice(0, MAX_MESSAGE_LENGTH) : safe;
}
