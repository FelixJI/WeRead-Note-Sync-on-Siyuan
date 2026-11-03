import type { HttpTextResponse, Transport } from "./transport";
import { assertWhitelistedUrl } from "./whitelist";

// 内核 forwardProxy 的请求形状（docs/contracts/siyuan-kernel.md）：
// headers 是"单键对象数组"（内核逐项合并），与外层 Record 形式不同，需在此转换。
export type ForwardProxyFn = (req: {
    url: string;
    method: string;
    timeout: number;
    contentType: string;
    headers: Record<string, string>[];
    payload: unknown;
    payloadEncoding: "json";
    responseEncoding: "text";
}) => Promise<HttpTextResponse>;

const BUILTIN_DEFAULT_TIMEOUT_MS = 15000;

export function createKernelForwardProxyTransport(
    forwardProxy: ForwardProxyFn,
    defaults?: { timeoutMs?: number },
): Transport {
    const fallbackTimeoutMs = defaults?.timeoutMs ?? BUILTIN_DEFAULT_TIMEOUT_MS;
    return {
        async post(url, body, headers, timeoutMs) {
            // 出网前强制白名单校验，Transport 层不信任调用方
            assertWhitelistedUrl(url);
            const headerList = Object.entries(headers).map(([key, value]) => ({ [key]: value }));
            // 调用方传入非正数超时（未指定语义）时回退到默认值
            const timeout =
                Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : fallbackTimeoutMs;
            return forwardProxy({
                url,
                method: "POST",
                timeout,
                contentType: "application/json",
                headers: headerList,
                payload: body,
                payloadEncoding: "json",
                responseEncoding: "text",
            });
        },
    };
}
