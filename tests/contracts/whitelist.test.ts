import { describe, expect, it } from "vitest";
import { WEREAD_GATEWAY_URL, assertWhitelistedUrl } from "../../src/core/net/whitelist";

describe("远端白名单", () => {
    it("精确匹配唯一白名单地址通过", () => {
        expect(() => assertWhitelistedUrl(WEREAD_GATEWAY_URL)).not.toThrow();
        expect(() => assertWhitelistedUrl("https://i.weread.qq.com/api/agent/gateway")).not.toThrow();
    });

    it("协议变体（http）拒绝", () => {
        expect(() => assertWhitelistedUrl("http://i.weread.qq.com/api/agent/gateway")).toThrow();
    });

    it("域名变体（子域/后缀拼接/大小写）拒绝", () => {
        expect(() => assertWhitelistedUrl("https://evil.weread.qq.com/api/agent/gateway")).toThrow();
        expect(() => assertWhitelistedUrl("https://i.weread.qq.com.evil.com/api/agent/gateway")).toThrow();
        expect(() => assertWhitelistedUrl("https://user@i.weread.qq.com/api/agent/gateway")).toThrow();
        expect(() => assertWhitelistedUrl("https://I.WEREAD.QQ.COM/api/agent/gateway")).toThrow();
    });

    it("路径变体（尾斜杠/扩展路径）拒绝", () => {
        expect(() => assertWhitelistedUrl("https://i.weread.qq.com/api/agent/gateway/")).toThrow();
        expect(() => assertWhitelistedUrl("https://i.weread.qq.com/api/agent/gateway/other")).toThrow();
        expect(() => assertWhitelistedUrl("https://i.weread.qq.com/api/agent")).toThrow();
    });

    it("多余查询参数拒绝", () => {
        expect(() => assertWhitelistedUrl("https://i.weread.qq.com/api/agent/gateway?x=1")).toThrow();
    });

    it("空串与其他任意地址拒绝", () => {
        expect(() => assertWhitelistedUrl("")).toThrow();
        expect(() => assertWhitelistedUrl("https://weread.qq.com/")).toThrow();
    });
});
