import { describe, expect, it } from "vitest";
import { redact, toSafeErrorMessage } from "../../src/core/security/redact";

describe("脱敏", () => {
    it("wrk- Key 深藏于长文本中也会被替换", () => {
        const text = "请求 https://example.invalid/api 失败，返回 500，key=wrk-abcdef123456 请检查后重试";
        const out = redact(text);
        expect(out).not.toContain("wrk-abcdef123456");
        expect(out).toContain("wrk-***REDACTED***");
    });

    it("Bearer 凭证头整体替换为 Bearer ***", () => {
        const out = redact("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig");
        expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9.payload.sig");
        expect(out).toContain("Bearer ***");
    });

    it("Bearer 与 wrk- 组合出现时最终仍收敛为 Bearer ***", () => {
        const out = redact("Bearer wrk-abcdef123456");
        expect(out).toBe("Bearer ***");
    });

    it("同一 Key 重复出现时每一处都脱敏", () => {
        const out = redact("first wrk-aaaa1111bbbb second wrk-aaaa1111bbbb");
        expect(out.match(/wrk-\*\*\*REDACTED\*\*\*/g)?.length).toBe(2);
        expect(out).not.toContain("wrk-aaaa1111bbbb");
    });

    it("无敏感内容的文本原样通过", () => {
        const text = "普通错误消息：连接超时（code=10），请稍后重试 123";
        expect(redact(text)).toBe(text);
    });

    it("wrk- 后非空白字符不足 8 个时不视为完整 Key（保持原样）", () => {
        expect(redact("wrk-short")).toBe("wrk-short");
    });
});

describe("toSafeErrorMessage", () => {
    it("Error 消息中的 Key 被脱敏", () => {
        const out = toSafeErrorMessage(new Error("请求失败，key=wrk-abcdef123456"));
        expect(out).not.toContain("wrk-abcdef123456");
        expect(out).toContain("***REDACTED***");
    });

    it("字符串输入同样脱敏", () => {
        const out = toSafeErrorMessage("Bearer abc.def.ghi 校验失败");
        expect(out).toContain("Bearer ***");
        expect(out).not.toContain("abc.def.ghi");
    });

    it("超长文本截断到 500 字符", () => {
        const out = toSafeErrorMessage("A".repeat(600));
        expect(out.length).toBe(500);
    });

    it("非 Error 对象可安全序列化，不抛异常", () => {
        const out = toSafeErrorMessage({ code: 1, msg: "x" });
        expect(out).toContain("code");
        expect(typeof out).toBe("string");
    });

    it("null/undefined 等特殊值也能给出字符串", () => {
        expect(typeof toSafeErrorMessage(null)).toBe("string");
        expect(typeof toSafeErrorMessage(undefined)).toBe("string");
    });
});
