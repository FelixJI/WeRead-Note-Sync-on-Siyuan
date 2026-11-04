import { describe, expect, it } from "vitest";
import {
    mergeChangelog,
    nextVersion,
    parseCommitLine,
    renderChangelog,
    updateVersionFields,
} from "../../scripts/release/lib.mjs";

// 发版流水线纯函数契约：版本三档递增、中文 Conventional Commits 解析、
// 更新日志分组渲染、CHANGELOG 头部插入、package.json/plugin.json 双源版本同步。
// 远端提交信息一律按纯文本处理（转义方括号/反引号），不作为可执行 Markdown 注入。

const REPO_URL = "https://github.com/FelixJI/WeRead-Note-Sync-on-Siyuan";

describe("nextVersion 三档递增", () => {
    it("patch/minor/major 分别递增对应位", () => {
        expect(nextVersion("0.1.0", "patch")).toBe("0.1.1");
        expect(nextVersion("0.1.0", "minor")).toBe("0.2.0");
        expect(nextVersion("0.1.0", "major")).toBe("1.0.0");
        expect(nextVersion("1.2.3", "patch")).toBe("1.2.4");
        expect(nextVersion("10.20.30", "minor")).toBe("10.21.0");
    });

    it("非法当前版本或非法档位抛错", () => {
        expect(() => nextVersion("1.2", "patch")).toThrow();
        expect(() => nextVersion("a.b.c", "patch")).toThrow();
        expect(() => nextVersion("0.1.0-rc.1", "patch")).toThrow();
        expect(() => nextVersion("0.1.0", "build")).toThrow();
        expect(() => nextVersion("0.1.0", "")).toThrow();
    });
});

describe("parseCommitLine 中文 Conventional Commits 解析", () => {
    it("解析 type、中文 scope、subject 与 PR 尾缀", () => {
        expect(parseCommitLine("feat(统计): T05 阅读时长、年度热力图与原生统计快照 (#12)")).toEqual({
            type: "feat",
            scope: "统计",
            subject: "T05 阅读时长、年度热力图与原生统计快照",
            pr: 12,
        });
        expect(
            parseCommitLine("fix(评审): PR#14 评审修复——legacy 总览不重建、释放引擎先于 Key 清理 (#15)")
        ).toEqual({
            type: "fix",
            scope: "评审",
            subject: "PR#14 评审修复——legacy 总览不重建、释放引擎先于 Key 清理",
            pr: 15,
        });
    });

    it("无 scope / 无 PR / 无 type 的兜底", () => {
        expect(parseCommitLine("chore(发版): 发布 v0.2.0")).toEqual({
            type: "chore",
            scope: "发版",
            subject: "发布 v0.2.0",
            pr: null,
        });
        expect(parseCommitLine("feat: 无 scope 提交")).toEqual({
            type: "feat",
            scope: "",
            subject: "无 scope 提交",
            pr: null,
        });
        expect(parseCommitLine("Initial commit")).toEqual({
            type: null,
            scope: "",
            subject: "Initial commit",
            pr: null,
        });
        expect(parseCommitLine("Merge pull request #5 from FelixJI/feat-ci")).toEqual({
            type: null,
            scope: "",
            subject: "Merge pull request #5 from FelixJI/feat-ci",
            pr: null,
        });
    });

    it("破坏性标记 ! 归一化剥离，type 统一小写", () => {
        expect(parseCommitLine("feat(总览)!: 破坏性变更 (#20)").type).toBe("feat");
        expect(parseCommitLine("feat!: 裸类型破坏性").type).toBe("feat");
        expect(parseCommitLine("FIX(设置): 大写类型 (#3)").type).toBe("fix");
    });
});

describe("renderChangelog 分组渲染", () => {
    it("按类型分组、PR 渲染为链接、版本标题带 compare 链接", () => {
        const commits = [
            parseCommitLine("feat(统计): T05 阅读时长、年度热力图与原生统计快照 (#12)"),
            parseCommitLine("fix(评审): PR#14 评审修复 (#15)"),
            parseCommitLine("feat(总览): T04 原生阅读总览 (#11)"),
            parseCommitLine("Initial commit"),
        ];
        expect(renderChangelog({ version: "0.2.0", prevTag: "v0.1.0", date: "2026-11-04", commits, repoUrl: REPO_URL })).toBe(
            [
                `## [v0.2.0](${REPO_URL}/compare/v0.1.0...v0.2.0)（2026-11-04）`,
                "",
                "### 🎉 新增",
                "",
                `- **统计**：T05 阅读时长、年度热力图与原生统计快照（[#12](${REPO_URL}/pull/12)）`,
                `- **总览**：T04 原生阅读总览（[#11](${REPO_URL}/pull/11)）`,
                "",
                "### 🐛 修复",
                "",
                `- **评审**：PR#14 评审修复（[#15](${REPO_URL}/pull/15)）`,
                "",
                "### 🔧 其他",
                "",
                "- Initial commit",
            ].join("\n")
        );
    });

    it("首个版本（无前驱 tag）省略 compare 链接", () => {
        const commits = [parseCommitLine("feat(插件基础): T01 插件壳、网页 API Key 配置与官方接口适配层 (#8)")];
        expect(renderChangelog({ version: "0.1.0", prevTag: null, date: "2026-11-04", commits, repoUrl: REPO_URL })).toBe(
            [
                "## v0.1.0（2026-11-04）",
                "",
                "### 🎉 新增",
                "",
                `- **插件基础**：T01 插件壳、网页 API Key 配置与官方接口适配层（[#8](${REPO_URL}/pull/8)）`,
            ].join("\n")
        );
    });

    it("subject/scope 按纯文本转义（方括号/反引号），无 scope 时不输出加粗前缀", () => {
        const commits = [
            { type: "docs", scope: "", subject: "更新 [链接] 与 `命令`", pr: null },
            { type: null, scope: "杂项", subject: "无 PR 提交", pr: null },
        ];
        const out = renderChangelog({ version: "0.2.0", prevTag: null, date: "2026-11-04", commits, repoUrl: REPO_URL });
        expect(out).toContain("- 更新 \\[链接\\] 与 \\`命令\\`");
        expect(out).toContain("- **杂项**：无 PR 提交");
    });

    it("空提交列表只输出标题行", () => {
        const out = renderChangelog({ version: "0.2.0", prevTag: "v0.1.0", date: "2026-11-04", commits: [], repoUrl: REPO_URL });
        expect(out).toBe(`## [v0.2.0](${REPO_URL}/compare/v0.1.0...v0.2.0)（2026-11-04）`);
    });
});

describe("mergeChangelog 头部插入", () => {
    const section0 = "## v0.1.0（2026-11-03）\n\n### 🎉 新增\n\n- 初始版本";

    it("文件不存在时创建并带总标题", () => {
        expect(mergeChangelog(null, section0)).toBe(`# 更新日志\n\n${section0}\n`);
        expect(mergeChangelog("", section0)).toBe(`# 更新日志\n\n${section0}\n`);
    });

    it("新版本节插入在总标题与旧节之间，旧内容保持不变", () => {
        const existing = `# 更新日志\n\n${section0}\n`;
        const section1 = "## v0.2.0（2026-11-04）\n\n### 🐛 修复\n\n- 修复 A (#21)";
        expect(mergeChangelog(existing, section1)).toBe(`# 更新日志\n\n${section1}\n\n${section0}\n`);
    });
});

describe("updateVersionFields 双源版本同步", () => {
    const pkgText = `{
  "name": "weread-note-sync-on-siyuan",
  "version": "0.1.0",
  "repository": "https://github.com/FelixJI/WeRead-Note-Sync-on-Siyuan"
}
`;
    const pluginText = `{
    "name": "weread-note-sync-on-siyuan",
    "version": "0.1.0",
    "icon": "icon.png"
}
`;

    it("同步改写两文件 version，保持缩进与键序", () => {
        const { pkgText: p, pluginText: g } = updateVersionFields(pkgText, pluginText, "0.2.0");
        const pj = JSON.parse(p);
        const gj = JSON.parse(g);
        expect(pj.version).toBe("0.2.0");
        expect(gj.version).toBe("0.2.0");
        // 键序不变（version 仍是第 2 个键）
        expect(Object.keys(pj)).toEqual(["name", "version", "repository"]);
        expect(Object.keys(gj)).toEqual(["name", "version", "icon"]);
        // 缩进保持：package 2 空格、plugin 4 空格；行首缩进可直接断言
        expect(p).toContain('\n  "version": "0.2.0"');
        expect(g).toContain('\n    "version": "0.2.0"');
        expect(p.endsWith("}\n")).toBe(true);
    });

    it("非法输入抛错：非 semver 目标版本、非法 JSON、缺 version 字段", () => {
        expect(() => updateVersionFields(pkgText, pluginText, "0.2")).toThrow();
        expect(() => updateVersionFields("{ 不合法", pluginText, "0.2.0")).toThrow();
        expect(() => updateVersionFields(pkgText, '{ "name": "x" }', "0.2.0")).toThrow();
    });
});
