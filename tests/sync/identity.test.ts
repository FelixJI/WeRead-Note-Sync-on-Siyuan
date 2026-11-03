import { describe, expect, it } from "vitest";
import { makeSourceKey, parseSourceKey, type SourceRef } from "../../src/sync/identity";

// 冻结契约：sourceKey = ns/bookId/kind/id；任一段含 "/" 或空 → throw；
// 主代理追加：任一段含 " ' \ ` < > 或 C0 控制字符 → throw（IAL/SQL LIKE 注入面）。

const REF: SourceRef = {
    accountNamespace: "acct-1",
    bookId: "BID",
    kind: "highlight",
    officialSourceId: "bm-1",
};

describe("identity sourceKey 构造与解析", () => {
    it("构造与解析往返一致（highlight）", () => {
        const key = makeSourceKey(REF);
        expect(key).toBe("acct-1/BID/highlight/bm-1");
        expect(parseSourceKey(key)).toEqual(REF);
    });

    it("构造与解析往返一致（review）", () => {
        const ref: SourceRef = {
            accountNamespace: "acct-1",
            bookId: "BID",
            kind: "review",
            officialSourceId: "rv-1",
        };
        expect(parseSourceKey(makeSourceKey(ref))).toEqual(ref);
    });

    it("合法 Unicode/CJK 命名空间通过", () => {
        const ref: SourceRef = {
            accountNamespace: "微信读书-主账号",
            bookId: "100077-_book",
            kind: "highlight",
            officialSourceId: "书签-标识",
        };
        const key = makeSourceKey(ref);
        expect(key).toBe("微信读书-主账号/100077-_book/highlight/书签-标识");
        expect(parseSourceKey(key)).toEqual(ref);
    });

    it.each([
        ["accountNamespace", { ...REF, accountNamespace: "a/b" }],
        ["bookId", { ...REF, bookId: "B/ID" }],
        ["officialSourceId", { ...REF, officialSourceId: "bm/1" }],
    ] as const)("任一段含 / → throw（%s）", (_seg, ref) => {
        expect(() => makeSourceKey(ref)).toThrow(/sourceKey/);
    });

    it.each([
        ["accountNamespace", { ...REF, accountNamespace: "" }],
        ["bookId", { ...REF, bookId: "" }],
        ["officialSourceId", { ...REF, officialSourceId: "" }],
    ] as const)("任一段为空 → throw（%s）", (_seg, ref) => {
        expect(() => makeSourceKey(ref)).toThrow(/sourceKey/);
    });

    it.each([
        ["双引号", { ...REF, officialSourceId: 'bm"1' }],
        ["单引号", { ...REF, officialSourceId: "bm'1" }],
        ["反斜杠", { ...REF, officialSourceId: "bm\\1" }],
        ["反引号", { ...REF, accountNamespace: "ns`x" }],
        ["小于号", { ...REF, bookId: "B<ID" }],
        ["大于号", { ...REF, bookId: "B>ID" }],
        ["C0 控制字符", { ...REF, accountNamespace: "ns\u0001x" }],
        ["C0 换行", { ...REF, officialSourceId: "bm\n1" }],
    ] as const)("安全字符集：含非法字符 → throw（%s）", (_label, ref) => {
        expect(() => makeSourceKey(ref)).toThrow(/非法字符/);
    });

    it("安全字符集：kind 段同样校验（通过类型外的运行时防线）", () => {
        const ref = { ...REF, kind: "highlight<" as unknown as SourceRef["kind"] };
        expect(() => makeSourceKey(ref)).toThrow(/非法字符/);
    });
});

describe("identity parseSourceKey 非法结构", () => {
    it("段数不是 4 → throw", () => {
        expect(() => parseSourceKey("a/b/highlight")).toThrow();
        expect(() => parseSourceKey("a/b/highlight/x/y")).toThrow();
    });

    it("kind 不是 highlight|review → throw", () => {
        expect(() => parseSourceKey("a/b/notakind/x")).toThrow(/kind/);
    });

    it("空段 → throw", () => {
        expect(() => parseSourceKey("/b/highlight/x")).toThrow();
        expect(() => parseSourceKey("a//highlight/x")).toThrow();
        expect(() => parseSourceKey("a/b/highlight/")).toThrow();
    });

    it("含非法字符的 key → throw（与 makeSourceKey 对称，防脏状态注入 SQL/IAL）", () => {
        expect(() => parseSourceKey('a/b/highlight/x"y')).toThrow(/非法字符/);
        expect(() => parseSourceKey("a/b/highlight/x\\y")).toThrow(/非法字符/);
        expect(() => parseSourceKey("a/b/highlight/x\u0002y")).toThrow(/非法字符/);
    });
});
