import { describe, expect, it } from "vitest";
import type { HttpTextResponse, Transport } from "../../src/core/net/transport";
import { WEREAD_GATEWAY_URL } from "../../src/core/net/whitelist";
import { createWereadClient, isValidWereadApiKey } from "../../src/adapters/weread/client";
import {
    AuthError,
    GatewayError,
    TransportError,
    UpgradeRequiredError,
    executeGatewayCall,
    parseGatewayJson,
} from "../../src/adapters/weread/gateway";

// 测试用 Key：格式合法（wrk- 前缀、总长 >= 12、无空白），不是真实凭证
const KEY = "wrk-test-key-0001";

interface RecordedCall {
    url: string;
    body: unknown;
    headers: Record<string, string>;
    timeoutMs: number;
}

function fakeTransport(
    respond: (call: RecordedCall) => HttpTextResponse,
): Transport & { calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    return {
        calls,
        async post(url, body, headers, timeoutMs) {
            const call = { url, body, headers, timeoutMs };
            calls.push(call);
            return respond(call);
        },
    };
}

function jsonBody(obj: unknown, status = 200): HttpTextResponse {
    return { status, body: JSON.stringify(obj), contentType: "application/json" };
}

function bodyAsRecord(call: RecordedCall): Record<string, unknown> {
    return call.body as Record<string, unknown>;
}

describe("微信读书网关契约", () => {
    it("请求体平铺：transport 收到的 body 恰为 api_name + skill_version + 业务参数", async () => {
        const t = fakeTransport(() => jsonBody({ errcode: 0, books: [], hasMore: 0 }));
        const client = createWereadClient(t, KEY);
        await client.listNotebooksPage({ count: 3, lastSort: 123 });
        expect(t.calls).toHaveLength(1);
        expect(bodyAsRecord(t.calls[0])).toEqual({
            api_name: "/user/notebooks",
            skill_version: "1.0.5",
            count: 3,
            lastSort: 123,
        });
    });

    it("无参数调用时请求体仅含 api_name 与 skill_version", async () => {
        const t = fakeTransport(() => jsonBody({ errcode: 0, books: [], hasMore: 0 }));
        const client = createWereadClient(t, KEY);
        await client.listNotebooksPage();
        expect(bodyAsRecord(t.calls[0])).toEqual({
            api_name: "/user/notebooks",
            skill_version: "1.0.5",
        });
    });

    it("Authorization 头由 client 调 transport 时注入，URL 与超时一并传递", async () => {
        const t = fakeTransport(() => jsonBody({ errcode: 0, books: [], hasMore: 0 }));
        const client = createWereadClient(t, KEY);
        await client.listNotebooksPage({ count: 1 });
        const call = t.calls[0];
        expect(call.url).toBe(WEREAD_GATEWAY_URL);
        expect(call.headers["Authorization"]).toBe(`Bearer ${KEY}`);
        expect(call.headers["Content-Type"]).toBe("application/json");
        expect(typeof call.timeoutMs).toBe("number");
        expect(call.timeoutMs).toBeGreaterThan(0);
    });

    it("errcode 非 0 且非鉴权类 → GatewayError 携带 errcode", async () => {
        const t = fakeTransport(() => jsonBody({ errcode: 5001, errmsg: "系统繁忙" }));
        const client = createWereadClient(t, KEY);
        const err = await client.listNotebooksPage({ count: 1 }).then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(GatewayError);
        expect(err).not.toBeInstanceOf(AuthError);
        const ge = err as GatewayError;
        expect(ge.errcode).toBe(5001);
        expect(ge.message).toContain("系统繁忙");
    });

    it("鉴权类 errcode → AuthError（GatewayError 子类）", async () => {
        const t = fakeTransport(() => jsonBody({ errcode: 401, errmsg: "key 无效" }));
        const client = createWereadClient(t, KEY);
        const err = await client.listNotebooksPage({ count: 1 }).then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(AuthError);
        expect(err).toBeInstanceOf(GatewayError);
        expect((err as AuthError).errcode).toBe(401);
    });

    it("HTTP 401 → AuthError", async () => {
        const t = fakeTransport(() => ({ status: 401, body: "unauthorized", contentType: "text/plain" }));
        const client = createWereadClient(t, KEY);
        const err = await client.listNotebooksPage({ count: 1 }).then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(AuthError);
    });

    it("回包含 upgrade_info → UpgradeRequiredError 且带 serverMessage", async () => {
        const t = fakeTransport(() =>
            jsonBody({ errcode: 0, upgrade_info: { message: "请升级技能版本后重试" } }),
        );
        const client = createWereadClient(t, KEY);
        const err = await client.listNotebooksPage({ count: 1 }).then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(UpgradeRequiredError);
        const ue = err as UpgradeRequiredError;
        expect(ue.serverMessage).toBe("请升级技能版本后重试");
    });

    it("errcode 非 0 且同时含 upgrade_info → 升级优先于普通网关错误", async () => {
        const t = fakeTransport(() =>
            jsonBody({ errcode: 4000, errmsg: "版本过低", upgrade_info: { message: "请升级" } }),
        );
        const client = createWereadClient(t, KEY);
        const err = await client.listNotebooksPage({ count: 1 }).then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(UpgradeRequiredError);
        expect(err).not.toBeInstanceOf(AuthError);
    });

    it("upgrade_info 为非对象真值（字符串）→ 字段出现即暂停，仍抛 UpgradeRequiredError", async () => {
        const t = fakeTransport(() =>
            jsonBody({ errcode: 0, upgrade_info: "请升级技能版本" }),
        );
        const client = createWereadClient(t, KEY);
        const err = await client.listNotebooksPage({ count: 1 }).then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(UpgradeRequiredError);
        const ue = err as UpgradeRequiredError;
        expect(ue.serverMessage).toBe("");
    });

    it("upgrade_info 为 null（字段显式出现）→ 仍抛 UpgradeRequiredError", async () => {
        const t = fakeTransport(() => jsonBody({ errcode: 0, upgrade_info: null }));
        const client = createWereadClient(t, KEY);
        const err = await client.listNotebooksPage({ count: 1 }).then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(UpgradeRequiredError);
    });

    it("业务参数含 api_name/skill_version 同名键 → 协议字段固化不被覆盖", async () => {
        const t = fakeTransport(() => jsonBody({ errcode: 0, books: [], hasMore: 0 }));
        await executeGatewayCall(t, KEY, "/user/notebooks", {
            count: 1,
            api_name: "/evil",
            skill_version: "9.9",
        });
        const body = bodyAsRecord(t.calls[0]);
        expect(body.api_name).toBe("/user/notebooks");
        expect(body.skill_version).toBe("1.0.5");
        expect(body.count).toBe(1);
    });

    it("非 JSON 响应 → TransportError", async () => {
        const t = fakeTransport(() => ({ status: 200, body: "<html>not json</html>", contentType: "text/html" }));
        const client = createWereadClient(t, KEY);
        const err = await client.listNotebooksPage({ count: 1 }).then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(TransportError);
    });

    it("其他非 2xx HTTP 状态 → TransportError 携带 status", async () => {
        const t = fakeTransport(() => jsonBody({ errcode: 0 }, 502));
        const client = createWereadClient(t, KEY);
        const err = await client.listNotebooksPage({ count: 1 }).then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(TransportError);
        expect((err as TransportError).status).toBe(502);
    });

    it("parseGatewayJson：合法对象原样返回；数组/null/非 JSON 一律 TransportError", () => {
        expect(parseGatewayJson('{"a":1}')).toEqual({ a: 1 });
        expect(() => parseGatewayJson("[1,2]")).toThrow(TransportError);
        expect(() => parseGatewayJson("null")).toThrow(TransportError);
        expect(() => parseGatewayJson("42")).toThrow(TransportError);
        expect(() => parseGatewayJson("这不是JSON")).toThrow(TransportError);
    });

    it("非 JSON 回包中 API Key 横跨 80 字符边界 → 先脱敏后截断，错误消息不含 wrk- 残段", () => {
        // PR8[2]：69 个填充字符 + wrk-abcdefgh 共 81 字符；若先截断后脱敏，
        // 剩余 7 字符后缀不满足脱敏器 8 字符要求，wrk-abcdefg 将泄露进错误消息
        const leak = "wrk-abcdefgh";
        const bodyText = `${"x".repeat(69)}${leak}`;
        let captured: unknown;
        try {
            parseGatewayJson(bodyText);
        } catch (e) {
            captured = e;
        }
        expect(captured).toBeInstanceOf(TransportError);
        const message = (captured as TransportError).message;
        expect(message).not.toContain("wrk-abcdefg");
        // wrk- 之后不得再跟任何密钥材质字符（脱敏标记后的 * 不算泄露）
        expect(message).not.toMatch(/wrk-[0-9A-Za-z]/);
    });

    it("合法 JSON 但非对象（数组）且回显跨边界 Key → 同样先脱敏后截断，不泄露残段", () => {
        // 数组前缀 73 字符，使 wrk-abcdefgh 横跨截断边界（截断后仅剩 7 字符后缀）
        const leak = "wrk-abcdefgh";
        const bodyText = `["${"x".repeat(67)}", "${leak}"]`;
        let captured: unknown;
        try {
            parseGatewayJson(bodyText);
        } catch (e) {
            captured = e;
        }
        expect(captured).toBeInstanceOf(TransportError);
        const message = (captured as TransportError).message;
        expect(message).not.toContain("wrk-abcdefg");
        expect(message).not.toMatch(/wrk-[0-9A-Za-z]/);
    });

    it("isValidWereadApiKey：wrk- 前缀、总长 >= 12、无空白", () => {
        expect(isValidWereadApiKey("wrk-abcdefgh")).toBe(true);
        expect(isValidWereadApiKey("wrk-abcdefgh1")).toBe(true);
        expect(isValidWereadApiKey("wrk-abc")).toBe(false);
        expect(isValidWereadApiKey("WRK-abcdefgh")).toBe(false);
        expect(isValidWereadApiKey("wrk-abcd efgh")).toBe(false);
        expect(isValidWereadApiKey("abc-abcdefgh")).toBe(false);
        expect(isValidWereadApiKey("")).toBe(false);
    });
});
