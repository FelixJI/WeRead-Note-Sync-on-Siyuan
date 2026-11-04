/**
 * 发版纯函数库类型声明：实现为同目录 lib.mjs（scripts/ 不在 tsconfig include，
 * 仅供 tests/release/pipeline.test.ts 导入时获得类型；运行时由 Node/Vitest 直接加载 .mjs）。
 */

export interface ParsedCommit {
    /** Conventional Commits 类型（小写）；不符合规范的提交为 null（归“其他”） */
    type: string | null;
    /** 中文/英文 scope，可为空串 */
    scope: string;
    /** 去除 type/scope/PR 尾缀后的描述 */
    subject: string;
    /** PR squash 尾缀 (#N) 的编号，无则 null */
    pr: number | null;
}

export interface RenderChangelogInput {
    version: string;
    /** 上一发版 tag（如 v0.1.0）；首发（仓库无 v* tag）传 null */
    prevTag: string | null;
    /** 日期字符串（YYYY-MM-DD） */
    date: string;
    commits: ParsedCommit[];
    /** 仓库 URL（无尾斜杠），用于 compare/pull 链接 */
    repoUrl: string;
}

export declare function nextVersion(current: string, bump: "patch" | "minor" | "major" | string): string;
export declare function parseCommitLine(subject: string): ParsedCommit;
export declare function renderChangelog(input: RenderChangelogInput): string;
export declare function mergeChangelog(existingMd: string | null, newSection: string): string;
export declare function updateVersionFields(
    pkgText: string,
    pluginText: string,
    newVersion: string
): { pkgText: string; pluginText: string };
