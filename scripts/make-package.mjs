/**
 * T06 打包：dist → package.zip（思源插件安装包）。
 * 无第三方依赖：Windows 用 PowerShell Compress-Archive；类 Unix 用 zip（缺失时报错）。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const dist = resolve("dist");
const out = resolve("package.zip");
if (!existsSync(resolve(dist, "index.js")) || !existsSync(resolve(dist, "plugin.json"))) {
    console.error("dist 不完整（缺 index.js/plugin.json），先运行 npm run build");
    process.exit(1);
}
if (process.platform === "win32") {
    execFileSync("powershell.exe", [
        "-NoProfile", "-Command", "Compress-Archive", "-Path", `${dist}/*`, "-DestinationPath", out, "-Force",
    ], { stdio: "inherit" });
} else {
    execFileSync("sh", ["-c", `cd "${dist}" && rm -f ../package.zip && zip -r ../package.zip .`], { stdio: "inherit" });
}
console.log("package.zip 生成完成（发布需另行授权，本脚本不发布）");
