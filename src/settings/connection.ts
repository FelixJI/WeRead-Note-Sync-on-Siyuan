/**
 * 连接测试组装（设置页专用）。
 *
 * 组装方式（冻结约定）：
 *   const client = createWereadClient(createKernelForwardProxyTransport(kernelForwardProxy), apiKey);
 *   const result = await testConnection(client);
 *
 * - 先本地校验 Key 格式，不通过直接返回，不发起任何网络请求。
 * - testConnection 返回的失败 message 已由 core 层脱敏，UI 以纯文本展示。
 * - 意外异常时不透出原始 error 文本（可能含未脱敏上下文），统一按 unknown 处理。
 */
import { createWereadClient, isValidWereadApiKey } from "../adapters/weread/client";
import { createKernelForwardProxyTransport } from "../core/net/forward-proxy-transport";
import { kernelForwardProxy } from "../adapters/siyuan/kernel";
import { testConnection, type ConnectionTestResult } from "../core/connection-test";

export type ConnectionFailKind = Extract<ConnectionTestResult, { ok: false }>["kind"];

export type ConnectionTestOutcome =
    | { status: "invalid-key" }
    | { status: "ok"; totalBookCount?: number; elapsedMs: number }
    | { status: "fail"; kind: ConnectionFailKind; message: string }
    | { status: "unknown-error" };

export async function runConnectionTest(apiKey: string): Promise<ConnectionTestOutcome> {
    if (!isValidWereadApiKey(apiKey)) {
        return { status: "invalid-key" };
    }
    const client = createWereadClient(createKernelForwardProxyTransport(kernelForwardProxy), apiKey);
    let result: ConnectionTestResult;
    try {
        result = await testConnection(client);
    } catch {
        return { status: "unknown-error" };
    }
    if (result.ok) {
        return { status: "ok", totalBookCount: result.totalBookCount, elapsedMs: result.elapsedMs };
    }
    return { status: "fail", kind: result.kind, message: result.message };
}
