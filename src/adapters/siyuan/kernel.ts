import { fetchSyncPost } from "siyuan";
import type { ForwardProxyFn } from "../../core/net/forward-proxy-transport";
import type { HttpTextResponse } from "../../core/net/transport";
import { toSafeErrorMessage } from "../../core/security/redact";
import { TransportError } from "../weread/gateway";

// 思源内核适配层：本文件是唯一允许 import "siyuan" 的文件之一。
// 注意：本文件不进入任何测试的 import 图（测试环境无内核）。
// fetchSyncPost 返回的 IWebSocketData.data 是 any——这里只做 unknown 结构收窄，不信任其类型。

function assertKernelOk(code: number, msg: string, action: string): void {
    if (code !== 0) {
        throw new TransportError(toSafeErrorMessage(`内核${action}失败（code=${code}）：${msg}`));
    }
}

/** 经内核 forwardProxy 外联（唯一白名单远端通道），返回目标服务的文本响应。 */
export async function kernelForwardProxy(
    req: Parameters<ForwardProxyFn>[0],
): Promise<HttpTextResponse> {
    const resp = await fetchSyncPost("/api/network/forwardProxy", req);
    assertKernelOk(resp.code, resp.msg, "forwardProxy 调用");

    const data: unknown = resp.data;
    if (typeof data !== "object" || data === null) {
        throw new TransportError("内核 forwardProxy 响应缺少 data 对象");
    }
    const rec = data as Record<string, unknown>;
    if (typeof rec.status !== "number") {
        throw new TransportError("内核 forwardProxy 响应缺少目标 HTTP status");
    }
    if (typeof rec.body !== "string") {
        throw new TransportError("内核 forwardProxy 响应缺少文本 body");
    }
    const contentType =
        typeof rec.contentType === "string" ? rec.contentType : undefined;
    return contentType === undefined
        ? { status: rec.status, body: rec.body }
        : { status: rec.status, body: rec.body, contentType };
}

/** 读取内核版本号（/api/system/version，data 为版本字符串）。 */
export async function getKernelVersion(): Promise<string> {
    const resp = await fetchSyncPost("/api/system/version", {});
    assertKernelOk(resp.code, resp.msg, "版本查询");
    const data: unknown = resp.data;
    if (typeof data !== "string" || data.length === 0) {
        throw new TransportError("内核版本响应格式异常（data 非版本字符串）");
    }
    return data;
}
