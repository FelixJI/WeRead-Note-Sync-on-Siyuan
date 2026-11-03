import type { Transport } from "../../core/net/transport";
import { WEREAD_GATEWAY_URL } from "../../core/net/whitelist";
import { redact } from "../../core/security/redact";

// 网关协议层：错误类型 + 回包 JSON 解析 + 统一调用（供 client 与分页辅助复用）。

export class TransportError extends Error {
    readonly status?: number;

    constructor(message: string, status?: number) {
        super(message);
        this.name = "TransportError";
        this.status = status;
    }
}

export class GatewayError extends Error {
    readonly errcode: number;

    constructor(message: string, errcode: number) {
        super(message);
        this.name = "GatewayError";
        this.errcode = errcode;
    }
}

// HTTP 401 或鉴权类 errcode
export class AuthError extends GatewayError {
    constructor(message: string, errcode: number) {
        super(message, errcode);
        this.name = "AuthError";
    }
}

// 回包含 upgrade_info：按契约必须立即暂停并抛出，不得忽略
export class UpgradeRequiredError extends GatewayError {
    readonly serverMessage: string;

    constructor(message: string, errcode: number, serverMessage: string) {
        super(message, errcode);
        this.name = "UpgradeRequiredError";
        this.serverMessage = serverMessage;
    }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseGatewayJson(bodyText: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(bodyText);
    } catch {
        throw new TransportError(
            `网关响应不是合法 JSON：${redact(bodyText.slice(0, 80))}`,
        );
    }
    if (!isRecord(parsed)) {
        throw new TransportError(`网关响应不是 JSON 对象：${redact(bodyText.slice(0, 80))}`);
    }
    return parsed;
}

export const WEREAD_SKILL_VERSION = "1.0.5";

export const DEFAULT_GATEWAY_TIMEOUT_MS = 15000;

// 已知鉴权类 errcode（HTTP 语义码；后续真实联调若发现专有码在此集合扩展）
const AUTH_ERRCODES: ReadonlySet<number> = new Set([401, 403]);

function errcodeOf(obj: Record<string, unknown>): number {
    return typeof obj.errcode === "number" ? obj.errcode : 0;
}

function errmsgOf(obj: Record<string, unknown>): string {
    return typeof obj.errmsg === "string" && obj.errmsg.length > 0 ? obj.errmsg : "无错误消息";
}

/**
 * 统一网关调用：平铺请求体、注入 Authorization、按契约映射错误。
 * 成功时返回解析后的回包对象（errcode === 0 且无 upgrade_info）。
 */
export async function executeGatewayCall(
    transport: Transport,
    apiKey: string,
    apiName: string,
    params: Record<string, unknown>,
    timeoutMs: number = DEFAULT_GATEWAY_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
    // 业务参数平铺在顶层，禁止包在 params/data/body 里（契约冻结）
    const body: Record<string, unknown> = {
        api_name: apiName,
        skill_version: WEREAD_SKILL_VERSION,
        ...params,
    };
    const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
    };
    const resp = await transport.post(WEREAD_GATEWAY_URL, body, headers, timeoutMs);

    if (resp.status === 401) {
        throw new AuthError("微信读书鉴权失败（HTTP 401）：请检查 API Key。", 401);
    }
    if (resp.status < 200 || resp.status >= 300) {
        throw new TransportError(`微信读书网关 HTTP ${resp.status}`, resp.status);
    }

    const obj = parseGatewayJson(resp.body);

    // upgrade_info 优先于 errcode 判断：契约要求出现即暂停
    const upgradeInfo = obj.upgrade_info;
    if (isRecord(upgradeInfo)) {
        const serverMessage =
            typeof upgradeInfo.message === "string" ? upgradeInfo.message : "";
        throw new UpgradeRequiredError(
            `微信读书接口要求升级：${redact(serverMessage)}`,
            errcodeOf(obj),
            redact(serverMessage),
        );
    }

    const errcode = errcodeOf(obj);
    if (errcode !== 0) {
        const message = redact(errmsgOf(obj));
        if (AUTH_ERRCODES.has(errcode)) {
            throw new AuthError(`微信读书鉴权失败（errcode=${errcode}）：${message}`, errcode);
        }
        throw new GatewayError(`微信读书网关错误（errcode=${errcode}）：${message}`, errcode);
    }
    return obj;
}
