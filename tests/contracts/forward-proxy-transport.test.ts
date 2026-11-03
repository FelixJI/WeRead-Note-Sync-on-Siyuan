import { describe, expect, it } from "vitest";
import type { HttpTextResponse, Transport } from "../../src/core/net/transport";
import { WEREAD_GATEWAY_URL } from "../../src/core/net/whitelist";
import { createKernelForwardProxyTransport } from "../../src/core/net/forward-proxy-transport";

const RESP: HttpTextResponse = { status: 200, body: '{"errcode":0}', contentType: "application/json" };

interface CapturedReq {
    url: string;
    method: string;
    timeout: number;
    contentType: string;
    headers: Record<string, string>[];
    payload: unknown;
    payloadEncoding: string;
    responseEncoding: string;
}

function capturingProxy(): { reqs: CapturedReq[]; transport: Transport } {
    const reqs: CapturedReq[] = [];
    const forwardProxy = async (req: {
        url: string; method: string; timeout: number; contentType: string;
        headers: Record<string, string>[]; payload: unknown;
        payloadEncoding: "json"; responseEncoding: "text";
    }): Promise<HttpTextResponse> => {
        reqs.push(req);
        return RESP;
    };
    return { reqs, transport: createKernelForwardProxyTransport(forwardProxy) };
}

describe("内核 forwardProxy Transport 适配", () => {
    it("非白名单 URL 直接拒绝，不触发 forwardProxy", async () => {
        const { reqs, transport } = capturingProxy();
        await expect(transport.post("https://evil.com/api", {}, {}, 1000)).rejects.toThrow();
        expect(reqs).toHaveLength(0);
    });

    it("白名单 URL 放行，请求字段按内核契约组装", async () => {
        const { reqs, transport } = capturingProxy();
        const body = { api_name: "/user/notebooks", skill_version: "1.0.5" };
        const headers = { Authorization: "Bearer wrk-abc", "Content-Type": "application/json" };
        const out = await transport.post(WEREAD_GATEWAY_URL, body, headers, 12345);
        expect(out).toEqual(RESP);
        expect(reqs).toHaveLength(1);
        const req = reqs[0];
        expect(req.url).toBe(WEREAD_GATEWAY_URL);
        expect(req.method).toBe("POST");
        expect(req.contentType).toBe("application/json");
        expect(req.timeout).toBe(12345);
        expect(req.payload).toEqual(body);
        expect(req.payloadEncoding).toBe("json");
        expect(req.responseEncoding).toBe("text");
    });

    it("headers 对象转换为内核要求的单键对象数组", async () => {
        const { reqs, transport } = capturingProxy();
        const headers = { Authorization: "Bearer wrk-abc", "X-Extra": "1" };
        await transport.post(WEREAD_GATEWAY_URL, {}, headers, 5000);
        const arr = reqs[0].headers;
        expect(Array.isArray(arr)).toBe(true);
        for (const h of arr) {
            expect(Object.keys(h)).toHaveLength(1);
        }
        const merged: Record<string, string> = {};
        for (const h of arr) {
            for (const [k, v] of Object.entries(h)) {
                merged[k] = v;
            }
        }
        expect(merged).toEqual(headers);
    });

    it("timeoutMs 非正数时回退：先 defaults，再内置默认 15000", async () => {
        const reqs: CapturedReq[] = [];
        const withDefaults = createKernelForwardProxyTransport(
            async (req) => {
                reqs.push(req);
                return RESP;
            },
            { timeoutMs: 7777 },
        );
        await withDefaults.post(WEREAD_GATEWAY_URL, {}, {}, 0);
        expect(reqs[0].timeout).toBe(7777);

        const noDefaults = createKernelForwardProxyTransport(async (req) => {
            reqs.push(req);
            return RESP;
        });
        await noDefaults.post(WEREAD_GATEWAY_URL, {}, {}, -1);
        expect(reqs[1].timeout).toBe(15000);
    });
});
