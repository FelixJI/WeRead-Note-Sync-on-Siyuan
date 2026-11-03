import type { WereadClient } from "../adapters/weread/client";
import { InvalidWereadApiKeyError } from "../adapters/weread/client";
import {
    AuthError,
    GatewayError,
    TransportError,
    UpgradeRequiredError,
} from "../adapters/weread/gateway";
import { PaginationAnomalyError } from "../adapters/weread/pagers";
import { toSafeErrorMessage } from "./security/redact";

// 连接测试：只读探测（count=1），不做任何写入。
// message 一律为脱敏后的中文用户提示（toSafeErrorMessage 内部过 redact 并截断 500 字符）。

export type ConnectionTestResult =
    | { ok: true; totalBookCount?: number; elapsedMs: number }
    | {
          ok: false;
          kind: "auth" | "network" | "upgrade" | "gateway" | "invalid-key";
          message: string;
      };

export async function testConnection(client: WereadClient): Promise<ConnectionTestResult> {
    const startedAt = Date.now();
    try {
        const page = await client.listNotebooksPage({ count: 1 });
        const elapsedMs = Date.now() - startedAt;
        const total = page.totalBookCount;
        if (typeof total === "number" && Number.isFinite(total)) {
            return { ok: true, totalBookCount: total, elapsedMs };
        }
        return { ok: true, elapsedMs };
    } catch (e) {
        // invalid-key：本地格式校验不过（UI 先校验，这里双保险）
        if (e instanceof InvalidWereadApiKeyError) {
            return {
                ok: false,
                kind: "invalid-key",
                message: toSafeErrorMessage(
                    "API Key 格式不正确：应以 wrk- 开头、总长度不小于 12 个字符且不含空白。",
                ),
            };
        }
        if (e instanceof TransportError) {
            return {
                ok: false,
                kind: "network",
                message: toSafeErrorMessage(`网络请求失败：${e.message}`),
            };
        }
        if (e instanceof UpgradeRequiredError) {
            return {
                ok: false,
                kind: "upgrade",
                message: toSafeErrorMessage(`微信读书接口要求升级：${e.serverMessage}`),
            };
        }
        if (e instanceof AuthError) {
            return {
                ok: false,
                kind: "auth",
                message: toSafeErrorMessage(
                    `鉴权失败（errcode=${e.errcode}）：请检查微信读书 API Key 是否正确或已过期。`,
                ),
            };
        }
        if (e instanceof GatewayError) {
            return {
                ok: false,
                kind: "gateway",
                message: toSafeErrorMessage(`微信读书网关返回错误（errcode=${e.errcode}）。`),
            };
        }
        if (e instanceof PaginationAnomalyError) {
            // 只读探测按理不会触发分页；防御性归入 gateway（数据异常）
            return {
                ok: false,
                kind: "gateway",
                message: toSafeErrorMessage(`网关分页数据异常：${e.message}`),
            };
        }
        return { ok: false, kind: "network", message: toSafeErrorMessage(e) };
    }
}
