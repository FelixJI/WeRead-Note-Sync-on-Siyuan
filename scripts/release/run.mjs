/**
 * 发版 CLI（Issue #16）：计算下一版本、汇总自上一 tag 以来的提交/PR 生成更新日志、
 * 同步 package.json/plugin.json 双源版本号。只改文件与输出，不做 git 提交/打 tag/推送——
 * 发布动作（commit/tag/push/gh release）由 .github/workflows/release.yml 在用户
 * 手动选择 patch/minor/major 后执行；make-package 仍“只打包不发布”。
 *
 * 用法：node scripts/release/run.mjs --bump patch|minor|major [--dry-run] [--notes-out <path>]
 *   --dry-run     只打印计划版本与本版日志，不写入任何文件
 *   --notes-out   把本版日志（Release 说明正文）写入指定路径（CI 用已 gitignore 的
 *                 .ai-flow/runtime/release-notes.md，天然不入库）
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mergeChangelog, nextVersion, parseCommitLine, renderChangelog, updateVersionFields } from "./lib.mjs";

// stderr 一律捕获不转发：预期内的失败（无 tag 时 describe/rev-parse）由调用方 catch 静默处理，
// 不让 git 的 fatal 提示污染输出；stdout 为命令结果。
function git(args) {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function fail(msg) {
    console.error(`[release] 失败：${msg}`);
    process.exit(1);
}

// ---- 参数解析 ----
const argv = process.argv.slice(2);
function argValue(name) {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
const bump = argValue("--bump");
const dryRun = argv.includes("--dry-run");
const notesOut = argValue("--notes-out");
if (!bump) fail("缺少 --bump patch|minor|major");

// ---- 前置校验：跟踪文件干净、双源版本一致、目标 tag 未占用 ----
// 只检查已跟踪文件（--untracked-files=no）：本地未跟踪目录（.ai-flow/、package.zip 等）不影响发版基线。
// dry-run 只预览不落盘，允许在带未提交改动的本地工作区运行；真实发版（CI）必须在干净基线上。
if (!dryRun && git(["status", "--porcelain", "--untracked-files=no"]).trim() !== "") {
    fail("已跟踪文件存在未提交改动；发版必须在干净基线上运行（dry-run 可预览）");
}
const pkgPath = resolve("package.json");
const pluginPath = resolve("plugin.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const plugin = JSON.parse(readFileSync(pluginPath, "utf8"));
if (pkg.version !== plugin.version) {
    fail(`版本双源不一致：package.json=${pkg.version} / plugin.json=${plugin.version}`);
}
let newVersion;
try {
    newVersion = nextVersion(pkg.version, bump);
} catch (err) {
    fail(err?.message ?? String(err));
}
const tag = `v${newVersion}`;
let tagExists = true;
try {
    git(["rev-parse", "-q", "--verify", `refs/tags/${tag}`]);
} catch {
    tagExists = false; // rev-parse 非零退出 = tag 不存在（预期路径）
}
if (tagExists) fail(`tag ${tag} 已存在；如需重发请先核对历史，不自动覆盖`);

// ---- 汇总范围：上一 v* tag..HEAD；仓库尚无 tag 则汇总全部历史 ----
let prevTag = null;
try {
    prevTag = git(["describe", "--tags", "--match", "v*", "--abbrev=0"]).trim() || null;
} catch {
    prevTag = null; // 无任何 v* tag（首发）
}
const range = prevTag ? [`${prevTag}..HEAD`] : [];
const subjects = git(["log", "--no-merges", "--format=%s", ...range])
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "");
const commits = subjects.map(parseCommitLine);

// ---- 渲染本版日志与合并后 CHANGELOG ----
const repoUrl = String(pkg.repository ?? "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
const date = new Date().toISOString().slice(0, 10);
const section = renderChangelog({ version: newVersion, prevTag, date, commits, repoUrl });
const changelogPath = resolve("CHANGELOG.md");
const existing = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : null;
const changelog = mergeChangelog(existing, section);

// ---- 输出 ----
console.log(`[release] 当前版本 ${pkg.version} → 新版本 ${newVersion}（档位 ${bump}），tag ${tag}`);
console.log(`[release] 汇总 ${commits.length} 个提交${prevTag ? `（${prevTag}..HEAD）` : "（仓库全部历史，首发）"}`);

if (dryRun) {
    console.log("[release] dry-run：不写入任何文件。本版更新日志预览：\n");
    console.log(section);
    process.exit(0);
}

const { pkgText, pluginText } = updateVersionFields(
    readFileSync(pkgPath, "utf8"),
    readFileSync(pluginPath, "utf8"),
    newVersion
);
writeFileSync(pkgPath, pkgText);
writeFileSync(pluginPath, pluginText);
writeFileSync(changelogPath, changelog);
if (notesOut) {
    const notesPath = resolve(notesOut);
    mkdirSync(dirname(notesPath), { recursive: true });
    writeFileSync(notesPath, `${section}\n`);
    console.log(`[release] Release 说明已写入 ${notesOut}`);
}
console.log(`[release] 完成：package.json/plugin.json → ${newVersion}；CHANGELOG.md 已更新`);
console.log(`RELEASE_VERSION=${newVersion}`);
